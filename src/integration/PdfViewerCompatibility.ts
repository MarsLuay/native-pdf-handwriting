import { queryPdfPageNodes } from "./pdfPageSelectors";

export interface CompatibilityResult {
  compatible: boolean;
  errors: string[];
  warnings: string[];
  viewerRoot?: HTMLElement;
  toolbarHost?: HTMLElement;
  privateViewer?: PdfJsViewerLike;
}

export interface PdfJsViewerLike {
  currentPageNumber?: number;
  currentScale?: number;
  currentScaleValue?: string | number;
  pagesRotation?: number;
  container?: HTMLElement;
  viewer?: HTMLElement;
  updateScale?(options: {
    drawingDelay?: number;
    scaleFactor?: number | null;
    steps?: number | null;
    origin?: unknown;
  }): void;
  eventBus?: {
    on?(name: string, callback: (event: unknown) => void): void;
    off?(name: string, callback: (event: unknown) => void): void;
  };
}

/** Obsidian PDF view shape used by PDF++ / core (`view.viewer.then(child)`). */
export interface ObsidianPdfViewLike {
  containerEl?: HTMLElement;
  viewer?: {
    child?: ObsidianPdfViewerChildLike;
    then?(onFulfilled: (child: ObsidianPdfViewerChildLike) => void): unknown;
  };
}

interface ObsidianPdfViewerChildLike {
  pdfViewer?: PdfJsViewerLike & {
    pdfViewer?: PdfJsViewerLike | null;
    dom?: {
      viewerContainerEl?: HTMLElement;
      containerEl?: HTMLElement;
    } | null;
  };
}

type PrivateHost = HTMLElement & {
  pdfViewer?: PdfJsViewerLike;
  viewer?: PdfJsViewerLike;
  component?: { pdfViewer?: PdfJsViewerLike; viewer?: PdfJsViewerLike };
};

export class PdfViewerCompatibility {
  static direct(host: HTMLElement, privateViewer?: PdfJsViewerLike): CompatibilityResult {
    return this.inspect(host, [".pdf-viewer", ".pdfViewer"], [".pdf-toolbar", ".pdf-toolbar-container"], privateViewer);
  }

  static embedded(host: HTMLElement, privateViewer?: PdfJsViewerLike): CompatibilityResult {
    return this.inspect(
      host,
      [".pdf-embed .pdf-viewer", ".internal-embed .pdf-viewer", ".pdf-viewer", ".pdfViewer"],
      [".pdf-toolbar", ".pdf-toolbar-container"],
      privateViewer
    );
  }

  /** Wait for PDFViewerChild like PDF++ (`view.viewer.then(child)`). */
  static async waitPdfViewerChild(view: ObsidianPdfViewLike, timeoutMs = 2500): Promise<ObsidianPdfViewerChildLike | undefined> {
    const component = view.viewer;
    if (!component) return undefined;
    if (component.child?.pdfViewer) return component.child;
    if (typeof component.then !== "function") return component.child;

    return await new Promise<ObsidianPdfViewerChildLike | undefined>((resolve) => {
      let settled = false;
      const finish = (child: ObsidianPdfViewerChildLike | undefined): void => {
        if (settled) return;
        settled = true;
        resolve(child);
      };
      try {
        void Promise.resolve(component.then?.((child) => finish(child))).catch(() => {
          finish(component.child);
        });
      } catch {
        finish(component.child);
        return;
      }
      window.setTimeout(() => finish(component.child), timeoutMs);
    });
  }

  /**
   * Prefer nested PDF.js viewer for scale APIs; keep Obsidian viewer eventBus.
   * Graph: view.viewer.child.pdfViewer (Obsidian) → .pdfViewer (PDF.js).
   */
  static bindPrivateViewer(obsidianOrNested?: PdfJsViewerLike & { pdfViewer?: PdfJsViewerLike | null } | null): PdfJsViewerLike | undefined {
    if (!obsidianOrNested) return undefined;
    const nested = obsidianOrNested.pdfViewer ?? null;
    if (nested && (typeof nested.currentScale === "number" || typeof nested.updateScale === "function")) {
      const bound = {
        get currentPageNumber() {
          return nested.currentPageNumber ?? obsidianOrNested.currentPageNumber;
        },
        get currentScale() {
          return nested.currentScale;
        },
        set currentScale(value: number | undefined) {
          if (typeof value === "number") nested.currentScale = value;
        },
        get currentScaleValue() {
          return nested.currentScaleValue;
        },
        set currentScaleValue(value: string | number | undefined) {
          if (value !== undefined) nested.currentScaleValue = value;
        },
        get pagesRotation() {
          return nested.pagesRotation ?? obsidianOrNested.pagesRotation;
        },
        get container() {
          return nested.container
            ?? (obsidianOrNested as { dom?: { viewerContainerEl?: HTMLElement } }).dom?.viewerContainerEl
            ?? obsidianOrNested.container;
        },
        get viewer() {
          return nested.viewer ?? obsidianOrNested.viewer;
        },
        ...(typeof nested.updateScale === "function" ? { updateScale: nested.updateScale.bind(nested) } : {}),
        eventBus: obsidianOrNested.eventBus ?? nested.eventBus
      } as PdfJsViewerLike;
      return bound;
    }
    return obsidianOrNested;
  }

  static async resolvePrivateViewerFromPdfView(view: ObsidianPdfViewLike): Promise<PdfJsViewerLike | undefined> {
    const child = await this.waitPdfViewerChild(view);
    return this.bindPrivateViewer(child?.pdfViewer ?? null);
  }

  private static inspect(
    host: HTMLElement,
    viewerSelectors: string[],
    toolbarSelectors: string[],
    resolvedPrivateViewer?: PdfJsViewerLike
  ): CompatibilityResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const viewerRoot = this.first<HTMLElement>(host, viewerSelectors);
    if (!viewerRoot) errors.push(`PDF viewer root missing; tried ${viewerSelectors.join(", ")}`);
    const page = viewerRoot ? queryPdfPageNodes(viewerRoot)[0] : undefined;
    if (viewerRoot && !page) {
      errors.push("PDF page nodes missing; expected .page[data-page-number] or .pdf-page-view[data-page-number]");
    }
    const toolbarHost = this.first<HTMLElement>(host, toolbarSelectors);
    if (!toolbarHost) warnings.push("Native PDF toolbar host missing; annotation toolbar will mount beside the viewer");
    const privateHost = host as PrivateHost;
    const privateViewer = resolvedPrivateViewer
      ?? privateHost.pdfViewer
      ?? privateHost.viewer
      ?? privateHost.component?.pdfViewer
      ?? privateHost.component?.viewer;
    if (!privateViewer) warnings.push("Private PDF.js viewer object unavailable; DOM page metrics fallback is active");
    const result: CompatibilityResult = { compatible: errors.length === 0, errors, warnings };
    if (viewerRoot) result.viewerRoot = viewerRoot;
    if (toolbarHost) result.toolbarHost = toolbarHost;
    if (privateViewer) result.privateViewer = privateViewer;
    return result;
  }

  private static first<T extends Element>(host: HTMLElement, selectors: string[]): T | undefined {
    if (selectors.some((selector) => host.matches(selector))) return host as unknown as T;
    for (const selector of selectors) {
      const match = host.querySelector<T>(selector);
      if (match) return match;
    }
    return undefined;
  }
}
