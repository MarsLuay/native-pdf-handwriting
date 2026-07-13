import type { SaveStatus } from "../model";

const LABELS: Record<SaveStatus, string> = {
  saved: "Saved",
  saving: "Saving…",
  dirty: "Unsaved changes",
  failed: "Save failed"
};

export class SaveStatusIndicator {
  readonly element: HTMLElement;

  constructor(document: Document = window.document) {
    this.element = document.createElement("span");
    this.element.className = "native-pdf-ink-save-status";
    this.element.setAttribute("role", "status");
    this.element.setAttribute("aria-live", "polite");
    this.update("saved");
  }

  update(status: SaveStatus, lastSavedAt?: Date): void {
    this.element.dataset.status = status;
    this.element.textContent = LABELS[status];
    this.element.title = status === "saved" && lastSavedAt ? `Last saved ${lastSavedAt.toLocaleTimeString()}` : LABELS[status];
  }
}
