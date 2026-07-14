import { describe, expect, it } from "vitest";
import type { PdfPageInfo } from "../src/integration/PdfPageLocator";
import { resolvePageCoordinateLayout } from "../src/pdf/PageCoordinateLayout";

function page(element: HTMLElement, width = 612, height = 792): PdfPageInfo {
  return { pageNumber: 1, width, height, scale: 1, rotation: 0, element };
}

describe("page coordinate layout", () => {
  it("uses the smaller axis scale when the PDF is width-fitted", () => {
    const host = document.createElement("div");
    host.className = "page";
    const canvas = document.createElement("canvas");
    host.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 500,
      width: 400, height: 500, toJSON: () => ({})
    });
    canvas.getBoundingClientRect = () => ({
      x: 75, y: 0, left: 75, top: 0, right: 325, bottom: 500,
      width: 250, height: 500, toJSON: () => ({})
    });
    host.append(canvas);

    const layout = resolvePageCoordinateLayout(page(host));
    expect(layout.scaleX).toBeCloseTo(250 / 612, 4);
    expect(layout.scaleY).toBeCloseTo(500 / 792, 4);
    expect(layout.scale).toBeCloseTo(layout.scaleX, 4);
    expect(layout.offsetX).toBe(75);
    expect(layout.offsetY).toBe(0);
  });

  it("offsets overlay to the PDF canvas within the page padding box", () => {
    const host = document.createElement("div");
    host.className = "page";
    const wrapper = document.createElement("div");
    wrapper.className = "canvasWrapper";
    const canvas = document.createElement("canvas");
    host.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 500,
      width: 400, height: 500, toJSON: () => ({})
    });
    wrapper.getBoundingClientRect = () => ({
      x: 75, y: 0, left: 75, top: 0, right: 325, bottom: 500,
      width: 250, height: 500, toJSON: () => ({})
    });
    canvas.getBoundingClientRect = () => ({
      x: 75, y: 0, left: 75, top: 0, right: 325, bottom: 500,
      width: 250, height: 500, toJSON: () => ({})
    });
    wrapper.append(canvas);
    host.append(wrapper);

    const layout = resolvePageCoordinateLayout(page(host));
    expect(layout.offsetX).toBe(75);
    expect(layout.offsetY).toBe(0);
    expect(layout.contentWidth).toBe(250);
  });
});
