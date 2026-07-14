import type { PdfPageInfo } from "../integration/PdfPageLocator";
import type { PageRotation } from "./PdfCoordinateMapper";

export interface PageCoordinateLayout {
  offsetX: number;
  offsetY: number;
  contentWidth: number;
  contentHeight: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  pdfWidth: number;
  pdfHeight: number;
  hostWidth: number;
  hostHeight: number;
}

export function normalizeRotation(value: number): PageRotation {
  const normalized = ((Math.round(value) % 360) + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

export function pdfRenderCanvas(pageElement: HTMLElement): HTMLCanvasElement | null {
  const preferred = pageElement.querySelector<HTMLCanvasElement>(".canvasWrapper canvas");
  if (preferred && !preferred.classList.contains("native-pdf-ink-canvas")) return preferred;

  const canvases = [...pageElement.querySelectorAll("canvas")].filter(
    (node): node is HTMLCanvasElement => node instanceof HTMLCanvasElement && !node.classList.contains("native-pdf-ink-canvas")
  );
  if (!canvases.length) return null;

  return canvases.reduce((largest, canvas) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return largest;
    const area = rect.width * rect.height;
    const largestRect = largest.getBoundingClientRect();
    const largestArea = largestRect.width * largestRect.height;
    return area > largestArea ? canvas : largest;
  });
}

/** Absolute offsets from a positioned ancestor's padding box to the PDF canvas. */
export function overlayOffsetInParent(
  parent: HTMLElement,
  contentRect: DOMRect,
  parentRect: DOMRect = parent.getBoundingClientRect()
): { offsetX: number; offsetY: number } {
  const borderLeft = parent.clientLeft || 0;
  const borderTop = parent.clientTop || 0;
  return {
    offsetX: contentRect.left - parentRect.left - borderLeft,
    offsetY: contentRect.top - parentRect.top - borderTop
  };
}

export function resolvePageCoordinateLayout(page: PdfPageInfo): PageCoordinateLayout {
  const hostRect = page.element.getBoundingClientRect();
  const rotation = normalizeRotation(page.rotation);
  const pdfWidth = rotation === 90 || rotation === 270 ? page.height : page.width;
  const pdfHeight = rotation === 90 || rotation === 270 ? page.width : page.height;
  const pdfCanvas = pdfRenderCanvas(page.element);
  const contentRect = pdfCanvas?.getBoundingClientRect();

  if (!contentRect || contentRect.width <= 0 || contentRect.height <= 0) {
    const scale = hostRect.width / Math.max(1, pdfWidth);
    return {
      offsetX: 0,
      offsetY: 0,
      contentWidth: hostRect.width,
      contentHeight: hostRect.height,
      scale,
      scaleX: scale,
      scaleY: hostRect.height / Math.max(1, pdfHeight),
      pdfWidth,
      pdfHeight,
      hostWidth: hostRect.width,
      hostHeight: hostRect.height
    };
  }

  const scaleX = contentRect.width / Math.max(1, pdfWidth);
  const scaleY = contentRect.height / Math.max(1, pdfHeight);
  const scale = Math.min(scaleX, scaleY);
  const { offsetX, offsetY } = overlayOffsetInParent(page.element, contentRect, hostRect);

  return {
    offsetX,
    offsetY,
    contentWidth: contentRect.width,
    contentHeight: contentRect.height,
    scale,
    scaleX,
    scaleY,
    pdfWidth,
    pdfHeight,
    hostWidth: hostRect.width,
    hostHeight: hostRect.height
  };
}
