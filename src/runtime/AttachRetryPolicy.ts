/**
 * Per-path attach backoff so layout/file-open rescans cannot hammer a PDF that
 * is not ready yet (or briefly throws during mount).
 */
export class AttachRetryPolicy {
  static readonly MIN_MS = 500;
  static readonly MAX_MS = 8_000;

  private readonly delayByPath = new Map<string, number>();
  private readonly notBeforeByPath = new Map<string, number>();

  clear(path: string): void {
    this.delayByPath.delete(path);
    this.notBeforeByPath.delete(path);
  }

  clearAll(): void {
    this.delayByPath.clear();
    this.notBeforeByPath.clear();
  }

  /** Drop cooldown entries for paths that no longer have an open PDF leaf. */
  retainOnly(livePaths: ReadonlySet<string>): void {
    for (const path of new Set([...this.notBeforeByPath.keys(), ...this.delayByPath.keys()])) {
      if (!livePaths.has(path)) this.clear(path);
    }
  }

  canAttempt(path: string, now = Date.now()): boolean {
    return now >= (this.notBeforeByPath.get(path) ?? 0);
  }

  /** Record a failed attach; returns the cooldown delay applied (ms). */
  recordFailure(path: string, now = Date.now()): number {
    const previous = this.delayByPath.get(path) ?? AttachRetryPolicy.MIN_MS;
    const delayMs = Math.min(
      AttachRetryPolicy.MAX_MS,
      Math.max(AttachRetryPolicy.MIN_MS, previous * 2)
    );
    this.delayByPath.set(path, delayMs);
    this.notBeforeByPath.set(path, now + delayMs);
    return delayMs;
  }

  /**
   * Jump straight to max cooldown (e.g. mobile DOM never grew page nodes).
   * Prevents attach storms that can take down Obsidian Mobile on large PDFs.
   */
  recordHardFailure(path: string, now = Date.now()): number {
    this.delayByPath.set(path, AttachRetryPolicy.MAX_MS);
    this.notBeforeByPath.set(path, now + AttachRetryPolicy.MAX_MS);
    return AttachRetryPolicy.MAX_MS;
  }

  /**
   * Milliseconds until the soonest live-path cooldown expires.
   * `null` when nothing is cooling down.
   */
  msUntilNextRetry(livePaths: ReadonlySet<string>, now = Date.now()): number | null {
    let next = Infinity;
    for (const path of livePaths) {
      const notBefore = this.notBeforeByPath.get(path);
      if (notBefore != null && notBefore > now) next = Math.min(next, notBefore);
    }
    if (next === Infinity) return null;
    return Math.max(0, next - now);
  }
}
