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

  constructor(document: Document = window.document) {
    this.element = document.createElement("span");
    this.element.className = "native-pdf-ink-save-status";
    this.element.setAttribute("role", "status");
    this.element.setAttribute("aria-live", "polite");
    this.dot = document.createElement("span");
    this.dot.className = "native-pdf-ink-save-status-dot";
    this.dot.setAttribute("aria-hidden", "true");
    this.element.append(this.dot);
    this.update("saved");
  }

  update(status: SaveStatus, lastSavedAt?: Date): void {
    this.element.dataset.status = status;
    const label = status === "saved" && lastSavedAt
      ? `Last saved ${lastSavedAt.toLocaleTimeString()}`
      : LABELS[status];
    this.element.setAttribute("aria-label", label);
    // Prefer aria-label only — native title stacks a second browser tooltip on hover.
    this.element.removeAttribute("title");
  }
}
