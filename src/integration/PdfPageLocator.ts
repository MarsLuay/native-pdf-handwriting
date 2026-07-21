import type { PdfJsViewerLike } from "./PdfViewerCompatibility";
import { queryPdfPageNodes } from "./pdfPageSelectors";
import { pdfRenderCanvas } from "../pdf/PageCoordinateLayout";

export interface PdfPageInfo {
  pageNumber: number;
  width: number;
  height: number;
  scale: number;
  rotation: number;
  element: HTMLElement;
}

interface CanonicalPageSize {
  width: number;
  height: number;
}

const PLAUSIBLE_PDF_MIN = 200;
const PLAUSIBLE_PDF_MAX = 2500;

export class PdfPageLocator {
  private readonly canonicalByElement = new WeakMap<HTMLElement, CanonicalPageSize>();

  constructor(private readonly viewerRoot: HTMLElement, private readonly privateViewer?: PdfJsViewerLike) {}

  pages(): PdfPageInfo[] {
    return queryPdfPageNodes(this.viewerRoot).map((element) => this.info(element));
  }

  page(pageNumber: number): PdfPageInfo | undefined {
    const element = this.viewerRoot.querySelector<HTMLElement>(
      `.page[data-page-number="${pageNumber}"], .pdf-page-view[data-page-number="${pageNumber}"]`
    );
    return element ? this.info(element) : undefined;
  }

  pageAt(clientX: number, clientY: number): PdfPageInfo | undefined {
    return this.pages().find(({ element }) => {
      const rect = element.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    });
  }

  currentPage(): number {
    return this.privateViewer?.currentPageNumber ?? this.pages()[0]?.pageNumber ?? 1;
  }

  private info(element: HTMLElement): PdfPageInfo {
    const rect = element.getBoundingClientRect();
    const pageNumber = Number(element.dataset.pageNumber) || 1;
    const scale = this.scaleFor(element);
    const rotation = this.number(element.dataset.rotation, this.number(this.privateViewer?.pagesRotation, 0));
    const { width, height } = this.canonicalSize(element, rect, scale, rotation);
    return { pageNumber, width, height, scale, rotation, element };
  }

  private canonicalSize(
    element: HTMLElement,
    rect: DOMRect,
    scale: number,
    rotation: number
  ): CanonicalPageSize {
    const fromDataset = this.sizeFromDataset(element);
    if (fromDataset) {
      this.canonicalByElement.set(element, fromDataset);
      return fromDataset;
    }

    const fromCanvasCss = this.sizeFromCanvasCss(element, scale, rotation);
    if (fromCanvasCss && this.isPlausible(fromCanvasCss)) {
      this.canonicalByElement.set(element, fromCanvasCss);
      return fromCanvasCss;
    }

    const rotated = rotation % 180 !== 0;
    if (rect.width > 0 && rect.height > 0 && scale > 0) {
      const inferred = {
        width: (rotated ? rect.height : rect.width) / scale,
        height: (rotated ? rect.width : rect.height) / scale
      };
      if (this.isPlausible(inferred)) {
        this.canonicalByElement.set(element, inferred);
        return inferred;
      }
    }

    const fromCanvasBitmap = this.sizeFromCanvasBitmap(element, scale, rotation);
    if (fromCanvasBitmap && this.isPlausible(fromCanvasBitmap)) {
      this.canonicalByElement.set(element, fromCanvasBitmap);
      return fromCanvasBitmap;
    }

    const cached = this.canonicalByElement.get(element);
    if (cached) return cached;
    return fromCanvasCss ?? fromCanvasBitmap ?? { width: 1, height: 1 };
  }

  private sizeFromDataset(element: HTMLElement): CanonicalPageSize | undefined {
    const width = this.number(element.dataset.pdfWidth, 0);
    const height = this.number(element.dataset.pdfHeight, 0);
    if (width > 0 && height > 0) return { width, height };
    return undefined;
  }

  private sizeFromCanvasCss(element: HTMLElement, scale: number, rotation: number): CanonicalPageSize | undefined {
    const canvas = pdfRenderCanvas(element);
    if (!canvas || !(scale > 0)) return undefined;
    const cssWidth = canvas.clientWidth || 0;
    const cssHeight = canvas.clientHeight || 0;
    if (!(cssWidth > 8 && cssHeight > 8)) return undefined;
    const rotated = rotation % 180 !== 0;
    return {
      width: (rotated ? cssHeight : cssWidth) / scale,
      height: (rotated ? cssWidth : cssHeight) / scale
    };
  }

  private sizeFromCanvasBitmap(element: HTMLElement, scale: number, rotation: number): CanonicalPageSize | undefined {
    const canvas = pdfRenderCanvas(element);
    if (!canvas || !(scale > 0)) return undefined;
    const ratio = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const bitmapWidth = canvas.width / ratio;
    const bitmapHeight = canvas.height / ratio;
    if (!(bitmapWidth > 0 && bitmapHeight > 0)) return undefined;
    const rotated = rotation % 180 !== 0;
    return {
      width: (rotated ? bitmapHeight : bitmapWidth) / scale,
      height: (rotated ? bitmapWidth : bitmapHeight) / scale
    };
  }

  private scaleFor(element: HTMLElement): number {
    const fromPage = this.number(element.dataset.scale, 0);
    const fromViewer = this.number(this.privateViewer?.currentScale, 0);
    const canvas = pdfRenderCanvas(element);
    const cssWidth = canvas ? (canvas.clientWidth || canvas.getBoundingClientRect().width) : 0;

    if (fromPage > 0 && fromViewer > 0 && Math.abs(fromPage - fromViewer) > 0.01 && cssWidth > 8) {
      const pageWidth = cssWidth / fromPage;
      const viewerWidth = cssWidth / fromViewer;
      const pageOk = this.isPlausibleWidth(pageWidth);
      const viewerOk = this.isPlausibleWidth(viewerWidth);
      if (viewerOk && !pageOk) return fromViewer;
      if (pageOk && !viewerOk) return fromPage;
      return fromViewer;
    }
    if (fromPage > 0) return fromPage;
    if (fromViewer > 0) return fromViewer;
    return 1;
  }

  private isPlausible(size: CanonicalPageSize): boolean {
    return this.isPlausibleWidth(size.width) && this.isPlausibleWidth(size.height);
  }

  private isPlausibleWidth(value: number): boolean {
    return value >= PLAUSIBLE_PDF_MIN && value <= PLAUSIBLE_PDF_MAX;
  }

  private number(value: unknown, fallback: number): number {
    const parsed = typeof value === "string" ? Number(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
