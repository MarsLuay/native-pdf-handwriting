import type { SaveStatus } from "../model";

export const DEFAULT_AUTOSAVE_DELAY_MS = 750;

export interface AutosaveQueueOptions<T> {
  write(documentId: string, snapshot: T): Promise<void>;
  delayMs?: number;
  retryFailed?: boolean;
  retryDelayMs?: number;
  onStatus?: (documentId: string, status: SaveStatus, error?: unknown) => void;
}

interface Entry<T> {
  snapshot: T;
  version: number;
  savedVersion: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  running: Promise<void> | undefined;
  status: SaveStatus;
}

export class AutosaveQueue<T> {
  readonly delayMs: number;
  private readonly entries = new Map<string, Entry<T>>();
  private closed = false;

  constructor(private readonly options: AutosaveQueueOptions<T>) {
    this.delayMs = options.delayMs ?? DEFAULT_AUTOSAVE_DELAY_MS;
  }

  schedule(documentId: string, snapshot: T): void {
    if (this.closed) throw new Error("AutosaveQueue is closed");
    const previous = this.entries.get(documentId);
    const entry: Entry<T> = previous ?? {
      snapshot, version: 0, savedVersion: 0, timer: undefined, running: undefined, status: "saved"
    };
    entry.snapshot = snapshot;
    entry.version += 1;
    this.setStatus(documentId, entry, "dirty");
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.drain(documentId, entry).catch(() => undefined); }, this.delayMs);
    this.entries.set(documentId, entry);
  }

  getStatus(documentId: string): SaveStatus { return this.entries.get(documentId)?.status ?? "saved"; }
  isDirty(documentId: string): boolean {
    const entry = this.entries.get(documentId);
    return entry !== undefined && entry.savedVersion < entry.version;
  }

  /** Mark current queued snapshot as saved without writing (after a sync emergency persist). */
  markClean(documentId: string): void {
    const entry = this.entries.get(documentId);
    if (!entry) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.savedVersion = entry.version;
    this.setStatus(documentId, entry, "saved");
  }

  /**
   * Stop timers and refuse further drains/writes without flushing.
   * Used when a newer session owns the document or plugin unload already synced disk.
   */
  abandon(): void {
    this.closed = true;
    for (const [documentId, entry] of this.entries) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      entry.savedVersion = entry.version;
      this.setStatus(documentId, entry, "saved");
    }
  }

  async retry(documentId: string): Promise<void> {
    if (this.closed) return;
    const entry = this.entries.get(documentId);
    if (!entry || !this.isDirty(documentId)) return;
    await this.drain(documentId, entry);
  }

  async flush(documentId?: string): Promise<void> {
    if (this.closed) return;
    if (documentId !== undefined) {
      const entry = this.entries.get(documentId);
      if (!entry) return;
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
      await this.drain(documentId, entry);
      return;
    }
    await Promise.all([...this.entries.keys()].map((id) => this.flush(id)));
  }

  async close(): Promise<void> {
    // Flush only if still open and dirty; abandoned queues must not write.
    if (!this.closed) await this.flush();
    this.closed = true;
  }

  private async drain(documentId: string, entry: Entry<T>): Promise<void> {
    if (this.closed) return;
    if (entry.running) { await entry.running; if (!this.closed && entry.savedVersion < entry.version) await this.drain(documentId, entry); return; }
    if (entry.savedVersion >= entry.version) return;
    if (this.closed) return;
    const targetVersion = entry.version;
    const snapshot = entry.snapshot;
    this.setStatus(documentId, entry, "saving");
    entry.running = this.options.write(documentId, snapshot).then(() => {
      if (this.closed) return;
      entry.savedVersion = Math.max(entry.savedVersion, targetVersion);
      this.setStatus(documentId, entry, entry.savedVersion < entry.version ? "dirty" : "saved");
    }).catch((error: unknown) => {
      if (this.closed) return;
      this.setStatus(documentId, entry, "failed", error);
      if (this.options.retryFailed) {
        entry.timer = setTimeout(() => { entry.timer = undefined; void this.drain(documentId, entry).catch(() => undefined); }, this.options.retryDelayMs ?? this.delayMs);
      }
      throw error;
    }).finally(() => { entry.running = undefined; });
    await entry.running;
    if (!this.closed && entry.savedVersion < entry.version && entry.status !== "failed") await this.drain(documentId, entry);
  }

  private setStatus(documentId: string, entry: Entry<T>, status: SaveStatus, error?: unknown): void {
    entry.status = status;
    this.options.onStatus?.(documentId, status, error);
  }
}
