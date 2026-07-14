import { describe, expect, it } from "vitest";
import { resolvePdfScrollRoot, scrollPdfBy, scrollPdfByDetailed } from "../src/integration/PdfScrollRoot";

describe("pdf scroll root", () => {
  it("prefers a scrollable pdf.js container over the viewer root", () => {
    const host = document.createElement("div");
    const viewerRoot = document.createElement("div");
    viewerRoot.className = "pdf-viewer";
    const container = document.createElement("div");
    container.id = "viewerContainer";
    let containerTop = 0;
    Object.defineProperty(container, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(container, "scrollTop", {
      get: () => containerTop,
      set: (value: number) => { containerTop = value; },
      configurable: true
    });
    Object.defineProperty(viewerRoot, "scrollHeight", { value: 600, configurable: true });
    Object.defineProperty(viewerRoot, "clientHeight", { value: 600, configurable: true });
    viewerRoot.append(container);
    host.append(viewerRoot);

    expect(resolvePdfScrollRoot(viewerRoot, { container })).toBe(container);
  });

  it("prefers Obsidian pdf-viewer-scroll-container", () => {
    const host = document.createElement("div");
    host.className = "pdf-container";
    const scrollContainer = document.createElement("div");
    scrollContainer.className = "pdf-viewer-scroll-container";
    const viewerRoot = document.createElement("div");
    viewerRoot.className = "pdf-viewer";
    scrollContainer.append(viewerRoot);
    host.append(scrollContainer);

    expect(resolvePdfScrollRoot(viewerRoot)).toBe(scrollContainer);
  });

  it("prefers an ancestor scroll container over a tall pdfViewer", () => {
    let scrollTop = 0;
    const scrollContainer = document.createElement("div");
    scrollContainer.className = "pdf-viewer-scroll-container";
    Object.defineProperty(scrollContainer, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scrollContainer, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scrollContainer, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
      configurable: true
    });

    const host = document.createElement("div");
    host.className = "pdf-container";
    const viewerRoot = document.createElement("div");
    viewerRoot.className = "pdfViewer";
    Object.defineProperty(viewerRoot, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(viewerRoot, "clientHeight", { value: 800, configurable: true });

    scrollContainer.append(host);
    host.append(viewerRoot);

    expect(resolvePdfScrollRoot(viewerRoot)).toBe(scrollContainer);
  });

  it("prefers pdf-viewer-scroll-container over privateViewer.container pdfViewer", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.className = "pdf-viewer-scroll-container";
    const viewerRoot = document.createElement("div");
    viewerRoot.className = "pdfViewer";
    Object.defineProperty(scrollContainer, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scrollContainer, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(viewerRoot, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(viewerRoot, "clientHeight", { value: 800, configurable: true });
    scrollContainer.append(viewerRoot);
    expect(resolvePdfScrollRoot(viewerRoot, { container: viewerRoot })).toBe(scrollContainer);
  });

  it("walks up to pdf-viewer-scroll-container from nested pdfViewer", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.className = "pdf-viewer-scroll-container";
    const viewerRoot = document.createElement("div");
    viewerRoot.className = "pdfViewer";
    const page = document.createElement("div");
    page.className = "page";
    viewerRoot.append(page);
    scrollContainer.append(viewerRoot);
    document.body.append(scrollContainer);
    expect(resolvePdfScrollRoot(viewerRoot)).toBe(scrollContainer);
    scrollContainer.remove();
  });

  it("prefers Obsidian view containerEl when pdfViewer cannot scroll", () => {
    let hostTop = 0;
    const host = document.createElement("div");
    host.className = "workspace-leaf";
    Object.defineProperty(host, "scrollHeight", { value: 2400, configurable: true });
    Object.defineProperty(host, "clientHeight", { value: 800, configurable: true });
    Object.defineProperty(host, "scrollTop", {
      get: () => hostTop,
      set: (value: number) => { hostTop = value; },
      configurable: true
    });

    const viewerRoot = document.createElement("div");
    viewerRoot.className = "pdfViewer";
    Object.defineProperty(viewerRoot, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(viewerRoot, "clientHeight", { value: 800, configurable: true });
    Object.defineProperty(viewerRoot, "scrollTop", {
      get: () => 0,
      set: () => undefined,
      configurable: true
    });
    host.append(viewerRoot);

    expect(resolvePdfScrollRoot(viewerRoot, { container: viewerRoot }, host)).toBe(host);
  });

  it("prefers Obsidian pdf-viewer-container when scrollable", () => {
    let scrollTop = 0;
    const host = document.createElement("div");
    host.className = "workspace-leaf-content";
    const scrollContainer = document.createElement("div");
    scrollContainer.className = "pdf-viewer-container";
    Object.defineProperty(scrollContainer, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scrollContainer, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scrollContainer, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
      configurable: true
    });
    const viewerRoot = document.createElement("div");
    viewerRoot.className = "pdfViewer";
    Object.defineProperty(viewerRoot, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(viewerRoot, "clientHeight", { value: 800, configurable: true });
    scrollContainer.append(viewerRoot);
    host.append(scrollContainer);

    expect(resolvePdfScrollRoot(viewerRoot, undefined, host)).toBe(scrollContainer);
  });

  it("prefers Obsidian container over inner pdfViewer when scrollTop assignment is ignored", () => {
    let containerTop = 0;
    const scrollContainer = document.createElement("div");
    scrollContainer.className = "pdf-viewer-container";
    Object.defineProperty(scrollContainer, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scrollContainer, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scrollContainer, "scrollTop", {
      get: () => containerTop,
      set: () => undefined,
      configurable: true
    });
    scrollContainer.addEventListener("wheel", (event) => {
      if (event instanceof WheelEvent) containerTop += event.deltaY;
    });

    const viewerRoot = document.createElement("div");
    viewerRoot.className = "pdfViewer";
    Object.defineProperty(viewerRoot, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(viewerRoot, "clientHeight", { value: 800, configurable: true });
    Object.defineProperty(viewerRoot, "scrollTop", {
      get: () => 0,
      set: () => undefined,
      configurable: true
    });
    scrollContainer.append(viewerRoot);
    const host = document.createElement("div");
    host.className = "workspace-leaf-content";
    host.append(scrollContainer);

    expect(resolvePdfScrollRoot(viewerRoot, undefined, host)).toBe(scrollContainer);
    const result = scrollPdfByDetailed(scrollContainer, 20);
    expect(result.changed).toBe(true);
    expect(result.via).toBe("wheel");
    expect(containerTop).toBe(20);
  });

  it("falls back to wheel scrolling when scrollTop assignment is ignored", () => {
    let scrollTop = 0;
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: () => undefined,
      configurable: true
    });
    scroller.addEventListener("wheel", (event) => {
      if (event instanceof WheelEvent) scrollTop += event.deltaY;
    });
    const detailed = scrollPdfByDetailed(scroller, 15);
    expect(detailed.changed).toBe(true);
    expect(detailed.via).toBe("wheel");
    expect(scrollTop).toBe(15);
  });

  it("scrolls the first ancestor that can move", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("div");
    let outerTop = 0;
    Object.defineProperty(outer, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(outer, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(inner, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(inner, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(inner, "scrollTop", {
      get: () => 0,
      set: () => undefined,
      configurable: true
    });
    Object.defineProperty(outer, "scrollTop", {
      get: () => outerTop,
      set: (value: number) => { outerTop = value; },
      configurable: true
    });
    outer.append(inner);
    expect(scrollPdfBy(inner, 25)).toBe(true);
    expect(outerTop).toBe(25);
  });
});
