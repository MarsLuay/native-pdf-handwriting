import { describe, expect, it } from "vitest";
import { selectPagesForInkMount } from "../src/runtime/selectPagesForInkMount";
import type { PdfPageInfo } from "../src/integration/PdfPageLocator";

function page(pageNumber: number, top: number, height = 800): PdfPageInfo {
  const element = document.createElement("div");
  element.dataset.pageNumber = String(pageNumber);
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => ({
      top,
      bottom: top + height,
      left: 0,
      right: 400,
      width: 400,
      height,
      x: 0,
      y: top,
      toJSON: () => ({})
    })
  });
  return {
    pageNumber,
    element,
    width: 400,
    height,
    scale: 1,
    rotation: 0
  };
}

describe("selectPagesForInkMount", () => {
  it("returns all pages on desktop", () => {
    const pages = [page(1, 0), page(2, 800), page(3, 1600), page(4, 2400)];
    expect(selectPagesForInkMount(pages, {
      mobile: false,
      currentPage: 1,
      scrollRoot: null
    })).toHaveLength(4);
  });

  it("keeps viewport pages plus pad on mobile", () => {
    const scrollRoot = document.createElement("div");
    Object.defineProperty(scrollRoot, "getBoundingClientRect", {
      value: () => ({
        top: 0,
        bottom: 900,
        left: 0,
        right: 400,
        width: 400,
        height: 900,
        x: 0,
        y: 0,
        toJSON: () => ({})
      })
    });
    const pages = [page(1, -100), page(2, 700), page(3, 1500), page(4, 2300), page(5, 3100)];
    const selected = selectPagesForInkMount(pages, {
      mobile: true,
      currentPage: 1,
      scrollRoot,
      pad: 1
    }).map((entry) => entry.pageNumber);
    // page1 + page2 visible; pad keeps neighbors of each seed
    expect(selected).toEqual([1, 2, 3]);
  });

  it("falls back to current page ± pad when nothing intersects", () => {
    const pages = [page(1, -5000), page(2, -4000), page(3, -3000), page(4, -2000)];
    const selected = selectPagesForInkMount(pages, {
      mobile: true,
      currentPage: 3,
      scrollRoot: null,
      pad: 1
    }).map((entry) => entry.pageNumber);
    expect(selected).toEqual([2, 3, 4]);
  });
});

