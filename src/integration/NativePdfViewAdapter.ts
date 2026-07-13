import { BasePdfAdapter } from "./BasePdfAdapter";
import { PdfAdapterCompatibilityError, type PdfAdapterCallbacks } from "./ObsidianPdfAdapter";
import { PdfViewerCompatibility } from "./PdfViewerCompatibility";

export class NativePdfViewAdapter extends BasePdfAdapter {
  readonly kind = "direct" as const;

  static attach(host: HTMLElement, callbacks: PdfAdapterCallbacks = {}): NativePdfViewAdapter {
    const compatibility = PdfViewerCompatibility.direct(host);
    if (!compatibility.compatible) throw new PdfAdapterCompatibilityError("direct", compatibility.errors);
    return new NativePdfViewAdapter(compatibility, callbacks);
  }
}
