export type DismissReason = "outside" | "escape" | "close-button";

export interface DismissControllerOptions {
  document: Document;
  panel: HTMLElement;
  isPinned: () => boolean;
  onDismiss: (reason: DismissReason) => void;
}

export class DismissController {
  private readonly abort = new AbortController();

  constructor(private readonly options: DismissControllerOptions) {
    options.document.addEventListener("pointerdown", this.onPointerDown, { capture: true, signal: this.abort.signal });
    options.document.addEventListener("keydown", this.onKeyDown, { signal: this.abort.signal });
  }

  destroy(): void {
    this.abort.abort();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.options.isPinned()) return;
    const target = event.target as Element | null;
    if (!target || this.options.panel.contains(target) || target.closest("[data-focus-overlay-internal='true']")) return;
    this.options.onDismiss("outside");
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.options.isPinned()) return;
    event.preventDefault();
    this.options.onDismiss("escape");
  };
}
