import type { ViewStateSource } from "../logging/SessionLogger";
import type { PdfPageInfo } from "./PdfPageLocator";
import type { ToolbarPlacement } from "../model";

export interface PdfViewState {
  pageNumber: number;
  scrollFraction: number;
  scale: number;
  rotation: number;
}

export interface PdfAdapterCallbacks {
  onViewStateChange?(state: PdfViewState, source: ViewStateSource): void;
  onPagesChanged?(reason: string): void;
  onCompatibilityWarning?(message: string): void;
  onDebugLog?(level: "info" | "warn", event: string, payload?: Record<string, unknown>): void;
}

export interface ObsidianPdfAdapter {
  readonly kind: "direct" | "embedded";
  readonly host: HTMLElement;
  readonly root: HTMLElement;
  pages(): PdfPageInfo[];
  getViewState(): PdfViewState;
  restoreViewState(state: PdfViewState): void;
  scrollElement(): HTMLElement;
  mountOverlay(pageNumber: number): HTMLElement;
  mountToolbar(toolbar: HTMLElement, placement?: ToolbarPlacement): void;
  setScale?(scale: number): boolean;
  setScaleValue?(value: string | number): boolean;
  zoomBySteps?(steps: number): boolean;
  zoomByScaleFactor?(factor: number, origin?: [number, number]): boolean;
  maxScale?(): number;
  compatibilityReport(): { errors: string[]; warnings: string[] };
  destroy(): void;
}

export class PdfAdapterCompatibilityError extends Error {
  constructor(kind: "direct" | "embedded", reasons: string[]) {
    super(`${kind} PDF adapter incompatible: ${reasons.join("; ")}`);
    this.name = "PdfAdapterCompatibilityError";
  }
}
