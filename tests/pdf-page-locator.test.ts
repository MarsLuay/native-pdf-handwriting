import { describe, expect, it } from "vitest";
import { PdfPageLocator } from "../src/integration/PdfPageLocator";
import { PdfCoordinateMapper } from "../src/pdf/PdfCoordinateMapper";

function pageElement(options: {
  scale: string;
  rect: { width: number; height: number };
  pdfWidth?: string;
  pdfHeight?: string;
  rotation?: string;
  canvas?: { width: number; height: number };
}): HTMLElement {
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  page.dataset.scale = options.scale;
  if (options.pdfWidth) page.dataset.pdfWidth = options.pdfWidth;
  if (options.pdfHeight) page.dataset.pdfHeight = options.pdfHeight;
  if (options.rotation) page.dataset.rotation = options.rotation;
  page.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: options.rect.width,
    bottom: options.rect.height,
    width: options.rect.width,
    height: options.rect.height,
    toJSON: () => ({})
  });
  if (options.canvas) {
    const canvas = document.createElement("canvas");
    canvas.width = options.canvas.width;
    canvas.height = options.canvas.height;
    page.append(canvas);
  }
  return page;
}

describe("PdfPageLocator", () => {
  it("prefers page dataset.scale over stale private viewer scale", () => {
    const viewer = document.createElement("div");
    viewer.className = "pdf-viewer";
    viewer.append(pageElement({ scale: "2", rect: { width: 1224, height: 1584 } }));
    const locator = new PdfPageLocator(viewer, { currentScale: 1 });
    expect(locator.pages()[0]).toMatchObject({ width: 612, height: 792, scale: 2 });
  });

  it("keeps canonical pdf width when zoom scale changes on the same page element", () => {
    const page = pageElement({ scale: "1", rect: { width: 612, height: 792 }, pdfWidth: "612", pdfHeight: "792" });
    const viewer = document.createElement("div");
    viewer.className = "pdf-viewer";
    viewer.append(page);
    const locator = new PdfPageLocator(viewer);

    page.dataset.scale = "2";
    page.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 1224, bottom: 1584, width: 1224, height: 1584, toJSON: () => ({})
    });

    expect(locator.pages()[0]).toMatchObject({ width: 612, height: 792, scale: 2 });
  });

  it("anchors stored strokes to the same viewport position after zoom", () => {
    const pdfWidth = 612;
    const pdfHeight = 792;
    const viewportPoint = { x: 120, y: 220 };
    const stored = new PdfCoordinateMapper({ width: pdfWidth, height: pdfHeight, scale: 1 }).toPdf(viewportPoint);

    const zoomedOut = new PdfCoordinateMapper({ width: pdfWidth, height: pdfHeight, scale: 0.75 }).toViewport(stored);
    const zoomedIn = new PdfCoordinateMapper({ width: pdfWidth, height: pdfHeight, scale: 2 }).toViewport(stored);

    expect(zoomedOut).toEqual({ x: 90, y: 165 });
    expect(zoomedIn).toEqual({ x: 240, y: 440 });
  });

  it("prefers viewer scale when page data-scale would yield CSS-pixel page sizes", () => {
    const page = pageElement({
      scale: "1",
      rect: { width: 2055, height: 2661 },
      canvas: { width: 2055, height: 2661 }
    });
    Object.defineProperty(page.querySelector("canvas")!, "clientWidth", { value: 2055 });
    Object.defineProperty(page.querySelector("canvas")!, "clientHeight", { value: 2661 });
    page.querySelector("canvas")!.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 2055, bottom: 2661, width: 2055, height: 2661, toJSON: () => ({})
    });
    const wrapper = document.createElement("div");
    wrapper.className = "canvasWrapper";
    wrapper.append(page.querySelector("canvas")!);
    page.append(wrapper);
    const viewer = document.createElement("div");
    viewer.className = "pdf-viewer";
    viewer.append(page);
    const locator = new PdfPageLocator(viewer, { currentScale: 2.09 });
    const info = locator.pages()[0]!;
    expect(info.scale).toBeCloseTo(2.09, 2);
    expect(info.width).toBeGreaterThan(900);
    expect(info.width).toBeLessThan(1100);
  });
});
