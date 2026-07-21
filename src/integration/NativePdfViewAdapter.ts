import { BasePdfAdapter } from "./BasePdfAdapter";
import { PdfAdapterCompatibilityError, type PdfAdapterCallbacks } from "./ObsidianPdfAdapter";
import { PdfViewerCompatibility, type PdfJsViewerLike } from "./PdfViewerCompatibility";
import { waitForPdfPageNodes } from "./pdfPageSelectors";

export class NativePdfViewAdapter extends BasePdfAdapter {
  readonly kind = "direct" as const;

  /**
   * Attach once the PDF viewer shell and numbered page nodes are ready.
   * Mobile often mounts `.pdf-viewer` before `.page[data-page-number]`.
   */
  static async attach(
    host: HTMLElement,
    callbacks: PdfAdapterCallbacks = {},
    options: { privateViewer?: PdfJsViewerLike; pageWaitMs?: number } = {}
  ): Promise<NativePdfViewAdapter> {
    let compatibility = PdfViewerCompatibility.direct(host, options.privateViewer);
    const pagesMissing =
      Boolean(compatibility.viewerRoot)
      && !compatibility.compatible
      && compatibility.errors.every((error) => error.includes("PDF page nodes missing"));

    if (pagesMissing && compatibility.viewerRoot) {
      await waitForPdfPageNodes(compatibility.viewerRoot, options.pageWaitMs ?? 5_000);
      compatibility = PdfViewerCompatibility.direct(host, options.privateViewer);
    }

    if (!compatibility.compatible) {
      throw new PdfAdapterCompatibilityError("direct", compatibility.errors);
    }
    return new NativePdfViewAdapter(compatibility, host, callbacks);
  }
}
