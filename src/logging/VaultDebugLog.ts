import { normalizePath, type Vault } from "obsidian";
import type { VaultLogSink, VaultLogLevel } from "./VaultLogSink";

async function ensureParentFolder(vault: Vault, filePath: string): Promise<void> {
  const parent = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  if (!parent) return;
  let current = "";
  for (const part of parent.split("/")) {
    current = current ? `${current}/${part}` : part;
    if (!await vault.adapter.exists(current)) await vault.adapter.mkdir(current);
  }
}

export class VaultDebugLog implements VaultLogSink {
  private readonly buffer: string[] = [];
  private flushTimer: number | null = null;
  private flushing = false;

  constructor(
    private readonly vault: () => Vault,
    private readonly path: () => string,
    private readonly enabled: () => boolean
  ) {}

  write(level: VaultLogLevel, event: string, payload: Record<string, unknown> = {}): void {
    if (!this.enabled() || !this.path().trim()) return;
    this.buffer.push(JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...payload
    }));
    this.scheduleFlush();
  }

  destroy(): void {
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    void this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 200);
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.buffer.length || !this.enabled()) {
      this.buffer.length = 0;
      return;
    }
    this.flushing = true;
    const chunk = `${this.buffer.splice(0).join("\n")}\n`;
    try {
      const vault = this.vault();
      const filePath = normalizePath(this.path());
      await ensureParentFolder(vault, filePath);
      if (await vault.adapter.exists(filePath)) await vault.adapter.append(filePath, chunk);
      else await vault.adapter.write(filePath, chunk);
    } catch (error) {
      console.error("[Handwriting Natively] vault debug log write failed", error);
    } finally {
      this.flushing = false;
      if (this.buffer.length) this.scheduleFlush();
    }
  }
}
