import { BasePdfAdapter } from "./BasePdfAdapter";
import { PdfAdapterCompatibilityError, type PdfAdapterCallbacks } from "./ObsidianPdfAdapter";
import { PdfViewerCompatibility } from "./PdfViewerCompatibility";

export class EmbeddedPdfAdapter extends BasePdfAdapter {
  readonly kind = "embedded" as const;

  static discover(container: HTMLElement): HTMLElement[] {
    const selectors = [".internal-embed[src$='.pdf']", ".internal-embed[data-type='pdf']", ".pdf-embed"];
    const found = new Set<HTMLElement>();
    for (const selector of selectors) {
      if (container.matches(selector)) found.add(container);
      container.querySelectorAll<HTMLElement>(selector).forEach((element) => found.add(element));
    }
    return [...found];
  }

  static attach(host: HTMLElement, callbacks: PdfAdapterCallbacks = {}): EmbeddedPdfAdapter {
    const compatibility = PdfViewerCompatibility.embedded(host);
    if (!compatibility.compatible) throw new PdfAdapterCompatibilityError("embedded", compatibility.errors);
    return new EmbeddedPdfAdapter(compatibility, callbacks);
  }
}
