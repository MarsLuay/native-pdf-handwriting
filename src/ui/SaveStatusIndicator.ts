import type { SaveStatus } from "../model";

const LABELS: Record<SaveStatus, string> = {
  saved: "Saved",
  saving: "Saving…",
  dirty: "Unsaved changes",
  failed: "Save failed"
};

export class SaveStatusIndicator {
  readonly element: HTMLElement;
  private readonly dot: HTMLElement;

  constructor(ownerDocument: Document = activeDocument) {
    this.element = ownerDocument.createSpan();
    this.element.className = "native-pdf-handwriting-save-status";
    this.element.setAttribute("role", "status");
    this.element.setAttribute("aria-live", "polite");
    this.dot = ownerDocument.createSpan();
    this.dot.className = "native-pdf-handwriting-save-status-dot";
    this.dot.setAttribute("aria-hidden", "true");
    this.element.append(this.dot);
    this.update("saved");
  }

  update(status: SaveStatus, lastSavedAt?: Date): void {
    this.element.dataset.status = status;
    const when = lastSavedAt ? ` · ${lastSavedAt.toLocaleTimeString()}` : "";
    this.element.setAttribute("aria-label", `${LABELS[status]}${when}`);
    this.element.title = `${LABELS[status]}${when}`;
  }
}
