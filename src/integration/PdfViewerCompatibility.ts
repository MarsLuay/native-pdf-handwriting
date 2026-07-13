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
  eventBus?: {
    on?(name: string, callback: (event: unknown) => void): void;
    off?(name: string, callback: (event: unknown) => void): void;
  };
}

type PrivateHost = HTMLElement & {
  pdfViewer?: PdfJsViewerLike;
  viewer?: PdfJsViewerLike;
  component?: { pdfViewer?: PdfJsViewerLike; viewer?: PdfJsViewerLike };
};

export class PdfViewerCompatibility {
  static direct(host: HTMLElement): CompatibilityResult {
    return this.inspect(host, [".pdf-viewer", ".pdfViewer"], [".pdf-toolbar", ".pdf-toolbar-container"]);
  }

  static embedded(host: HTMLElement): CompatibilityResult {
    return this.inspect(host, [".pdf-embed .pdf-viewer", ".internal-embed .pdf-viewer", ".pdf-viewer", ".pdfViewer"], [".pdf-toolbar", ".pdf-toolbar-container"]);
  }

  private static inspect(host: HTMLElement, viewerSelectors: string[], toolbarSelectors: string[]): CompatibilityResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const viewerRoot = this.first<HTMLElement>(host, viewerSelectors);
    if (!viewerRoot) errors.push(`PDF viewer root missing; tried ${viewerSelectors.join(", ")}`);
    const page = viewerRoot?.querySelector<HTMLElement>(".page[data-page-number], .pdf-page-view[data-page-number]");
    if (viewerRoot && !page) errors.push("PDF page nodes missing; expected .page[data-page-number] or .pdf-page-view[data-page-number]");
    const toolbarHost = this.first<HTMLElement>(host, toolbarSelectors);
    if (!toolbarHost) warnings.push("Native PDF toolbar host missing; annotation toolbar will mount beside the viewer");
    const privateHost = host as PrivateHost;
    const privateViewer = privateHost.pdfViewer ?? privateHost.viewer ?? privateHost.component?.pdfViewer ?? privateHost.component?.viewer;
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
