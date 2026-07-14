import { BasePdfAdapter } from "./BasePdfAdapter";
import { PdfAdapterCompatibilityError, type PdfAdapterCallbacks } from "./ObsidianPdfAdapter";
import { PdfViewerCompatibility, type PdfJsViewerLike } from "./PdfViewerCompatibility";

export class NativePdfViewAdapter extends BasePdfAdapter {
  readonly kind = "direct" as const;

  static attach(
    host: HTMLElement,
    callbacks: PdfAdapterCallbacks = {},
    options: { privateViewer?: PdfJsViewerLike } = {}
  ): NativePdfViewAdapter {
    const compatibility = PdfViewerCompatibility.direct(host, options.privateViewer);
    if (!compatibility.compatible) throw new PdfAdapterCompatibilityError("direct", compatibility.errors);
    return new NativePdfViewAdapter(compatibility, host, callbacks);
  }
}
