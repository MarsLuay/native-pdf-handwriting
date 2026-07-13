export interface DebugState {
  pointerType?: string;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  page?: number;
  pdfX?: number;
  pdfY?: number;
  scale?: number;
  rotation?: number;
  tool?: string;
  dropdown?: string | null;
  dirty?: boolean;
  autosave?: boolean;
  lastSavedAt?: string;
  pending?: boolean;
}

export class DebugPanel {
  readonly element: HTMLElement;

  constructor(document: Document = window.document) {
    this.element = document.createElement("pre");
    this.element.className = "native-pdf-ink-debug";
    this.element.dataset.focusOverlayInternal = "true";
    this.update({});
  }

  update(state: DebugState): void {
    this.element.textContent = JSON.stringify(state, null, 2);
  }
}
