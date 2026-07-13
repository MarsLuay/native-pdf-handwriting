export interface PalmRejectionOptions {
  ignoreTouchWhilePenActive?: boolean;
  palmWidthThreshold?: number;
}

export class PalmRejectionPolicy {
  private readonly activePens = new Set<number>();
  private readonly ignoreTouchWhilePenActive: boolean;
  private readonly palmWidthThreshold: number;

  constructor(options: PalmRejectionOptions = {}) {
    this.ignoreTouchWhilePenActive = options.ignoreTouchWhilePenActive ?? true;
    this.palmWidthThreshold = options.palmWidthThreshold ?? 42;
  }

  pointerDown(event: PointerEvent): void {
    if (event.pointerType === "pen") this.activePens.add(event.pointerId);
  }

  pointerUp(event: PointerEvent): void {
    if (event.pointerType === "pen") this.activePens.delete(event.pointerId);
  }

  shouldIgnore(event: PointerEvent): boolean {
    if (event.pointerType !== "touch") return false;
    if (this.ignoreTouchWhilePenActive && this.activePens.size > 0) return true;
    return Math.max(event.width || 0, event.height || 0) >= this.palmWidthThreshold && event.pressure > 0.5;
  }

  reset(): void {
    this.activePens.clear();
  }
}
