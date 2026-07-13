import type { PdfPageInfo } from "./PdfPageLocator";

export interface PdfViewState {
  pageNumber: number;
  scrollFraction: number;
  scale: number;
  rotation: number;
}

export interface PdfAdapterCallbacks {
  onViewStateChange?(state: PdfViewState): void;
  onPagesChanged?(): void;
  onCompatibilityWarning?(message: string): void;
}

export interface ObsidianPdfAdapter {
  readonly kind: "direct" | "embedded";
  readonly root: HTMLElement;
  pages(): PdfPageInfo[];
  getViewState(): PdfViewState;
  restoreViewState(state: PdfViewState): void;
  mountOverlay(pageNumber: number): HTMLElement;
  mountToolbar(toolbar: HTMLElement): void;
  destroy(): void;
}

export class PdfAdapterCompatibilityError extends Error {
  constructor(kind: "direct" | "embedded", reasons: string[]) {
    super(`${kind} PDF adapter incompatible: ${reasons.join("; ")}`);
    this.name = "PdfAdapterCompatibilityError";
  }
}
