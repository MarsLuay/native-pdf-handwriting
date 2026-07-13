import type { PdfJsViewerLike } from "./PdfViewerCompatibility";

export interface PdfPageInfo {
  pageNumber: number;
  width: number;
  height: number;
  scale: number;
  rotation: number;
  element: HTMLElement;
}

export class PdfPageLocator {
  constructor(private readonly viewerRoot: HTMLElement, private readonly privateViewer?: PdfJsViewerLike) {}

  pages(): PdfPageInfo[] {
    return Array.from(this.viewerRoot.querySelectorAll<HTMLElement>(".page[data-page-number], .pdf-page-view[data-page-number]"))
      .map((element) => this.info(element));
  }

  page(pageNumber: number): PdfPageInfo | undefined {
    const element = this.viewerRoot.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"], .pdf-page-view[data-page-number="${pageNumber}"]`);
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
    const scale = this.number(this.privateViewer?.currentScale, this.number(element.dataset.scale, 1));
    const rotation = this.number(element.dataset.rotation, this.number(this.privateViewer?.pagesRotation, 0));
    const canvas = element.querySelector<HTMLCanvasElement>("canvas");
    const width = this.number(element.dataset.pdfWidth, canvas?.width ? canvas.width / scale : rect.width / scale);
    const height = this.number(element.dataset.pdfHeight, canvas?.height ? canvas.height / scale : rect.height / scale);
    return { pageNumber, width, height, scale, rotation, element };
  }

  private number(value: unknown, fallback: number): number {
    const parsed = typeof value === "string" ? Number(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
