export interface SelectionToolbarCallbacks {
  onDelete(): void;
  onDuplicate(): void;
  onRecolor(color: string): void;
  onClear(): void;
}

export class SelectionToolbar {
  readonly element: HTMLElement;
  private readonly count: HTMLElement;
  private readonly abort = new AbortController();

  constructor(callbacks: SelectionToolbarCallbacks, document: Document = window.document) {
    this.element = document.createElement("div");
    this.element.className = "native-pdf-ink-selection-toolbar";
    this.element.dataset.focusOverlayInternal = "true";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", "Selected strokes");
    this.count = document.createElement("span");
    this.element.append(
      this.count,
      this.button(document, "Delete", callbacks.onDelete),
      this.button(document, "Duplicate", callbacks.onDuplicate)
    );
    const color = document.createElement("input");
    color.type = "color";
    color.setAttribute("aria-label", "Recolor selected strokes");
    color.addEventListener("input", () => callbacks.onRecolor(color.value), { signal: this.abort.signal });
    this.element.append(color, this.button(document, "Done", callbacks.onClear));
    this.hide();
  }

  show(count: number): void {
    this.count.textContent = `${count} selected`;
    this.element.hidden = count === 0;
  }

  hide(): void {
    this.element.hidden = true;
  }

  destroy(): void {
    this.abort.abort();
    this.element.remove();
  }

  private button(document: Document, label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action, { signal: this.abort.signal });
    return button;
  }
}
