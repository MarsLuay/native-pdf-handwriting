import { DismissController, type DismissReason } from "./DismissController";

export type UnsavedDecision = "save" | "discard" | "cancel";

export interface FocusOverlayOptions {
  document?: Document;
  title?: string;
  autosave: () => boolean;
  isDirty: () => boolean;
  flush: () => Promise<void>;
  decideUnsaved: () => Promise<UnsavedDecision>;
  onClosed?: (reason: DismissReason) => void;
}

export class FocusOverlay {
  readonly element: HTMLElement;
  readonly panel: HTMLElement;
  readonly content: HTMLElement;
  private readonly dismiss: DismissController;
  private readonly abort = new AbortController();
  private pinned = false;
  private closing = false;

  constructor(private readonly options: FocusOverlayOptions) {
    const document = options.document ?? window.document;
    this.element = document.createElement("div");
    this.element.className = "native-pdf-ink-focus-backdrop";
    this.element.setAttribute("role", "presentation");
    this.panel = document.createElement("section");
    this.panel.className = "native-pdf-ink-focus-panel";
    this.panel.dataset.focusOverlayInternal = "true";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-label", options.title ?? "PDF annotation focus view");
    const header = document.createElement("header");
    header.className = "native-pdf-ink-focus-header";
    const title = document.createElement("strong");
    title.textContent = options.title ?? "PDF annotation";
    const pin = document.createElement("button");
    pin.type = "button";
    pin.textContent = "Pin";
    pin.setAttribute("aria-pressed", "false");
    pin.addEventListener("click", () => {
      this.pinned = !this.pinned;
      pin.setAttribute("aria-pressed", String(this.pinned));
      pin.textContent = this.pinned ? "Unpin" : "Pin";
    }, { signal: this.abort.signal });
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.setAttribute("aria-label", "Close PDF focus view");
    close.addEventListener("click", () => void this.requestClose("close-button"), { signal: this.abort.signal });
    header.append(title, pin, close);
    this.content = document.createElement("div");
    this.content.className = "native-pdf-ink-focus-content";
    this.panel.append(header, this.content);
    this.element.append(this.panel);
    document.body.append(this.element);
    this.dismiss = new DismissController({
      document,
      panel: this.panel,
      isPinned: () => this.pinned,
      onDismiss: (reason) => void this.requestClose(reason)
    });
    close.focus();
  }

  async requestClose(reason: DismissReason): Promise<boolean> {
    if (this.closing) return false;
    this.closing = true;
    try {
      if (this.options.isDirty() && !this.options.autosave()) {
        const decision = await this.options.decideUnsaved();
        if (decision === "cancel") return false;
        if (decision === "save") await this.options.flush();
      } else {
        await this.options.flush();
      }
      this.destroy();
      this.options.onClosed?.(reason);
      return true;
    } finally {
      this.closing = false;
    }
  }

  destroy(): void {
    this.abort.abort();
    this.dismiss.destroy();
    this.element.remove();
  }
}
