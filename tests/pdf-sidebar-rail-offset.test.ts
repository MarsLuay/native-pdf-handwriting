import { afterEach, describe, expect, it, vi } from "vitest";
import { NativePdfViewAdapter } from "../src/integration/NativePdfViewAdapter";
import {
  INK_PDF_SIDEBAR_OFFSET_VAR,
  isPdfSidebarOpen,
  pdfSidebarOverlapOffset,
  syncLeftChromeWithPdfSidebar
} from "../src/integration/PdfSidebarRailOffset";

afterEach(() => { document.body.replaceChildren(); });

function rect(left: number, width: number, top = 0, height = 600) {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({})
  };
}

describe("pdf sidebar rail offset", () => {
  it("treats sidebarOpen as open even when width is modest", () => {
    const content = document.createElement("div");
    content.className = "pdf-content-container sidebarOpen";
    const sidebar = document.createElement("div");
    sidebar.className = "pdf-sidebar-container";
    expect(isPdfSidebarOpen(content, sidebar)).toBe(true);
    expect(isPdfSidebarOpen(document.createElement("div"), null)).toBe(false);
  });

  it("returns 0 when the content pane is already clear of the sidebar", () => {
    const chrome = document.createElement("div");
    const sidebar = document.createElement("div");
    const content = document.createElement("div");
    content.classList.add("pdf-content-container", "sidebarOpen");
    chrome.getBoundingClientRect = () => rect(200, 800);
    sidebar.getBoundingClientRect = () => rect(0, 200);
    Object.defineProperty(sidebar, "offsetWidth", { value: 200 });
    Object.defineProperty(sidebar, "offsetHeight", { value: 600 });
    expect(pdfSidebarOverlapOffset(chrome, sidebar, content)).toBe(0);
  });

  it("tracks geometric overlap while the sidebar is still animating closed", () => {
    const chrome = document.createElement("div");
    const sidebar = document.createElement("div");
    const content = document.createElement("div");
    content.className = "pdf-content-container";
    chrome.getBoundingClientRect = () => rect(0, 1000);
    sidebar.getBoundingClientRect = () => rect(0, 90);
    Object.defineProperty(sidebar, "offsetWidth", { value: 90 });
    Object.defineProperty(sidebar, "offsetHeight", { value: 600 });
    // sidebarOpen already cleared, but the pane still covers the rail mid-transition.
    expect(pdfSidebarOverlapOffset(chrome, sidebar, content)).toBe(90);
  });

  it("does not snap back to --sidebar-width after geometry clears on close", () => {
    const chrome = document.createElement("div");
    const sidebar = document.createElement("div");
    const content = document.createElement("div");
    // Class may still say open for a frame while the transform has cleared the rail.
    content.classList.add("pdf-content-container", "sidebarOpen");
    document.body.append(content, sidebar, chrome);
    chrome.getBoundingClientRect = () => rect(0, 1000);
    sidebar.getBoundingClientRect = () => rect(-200, 200);
    Object.defineProperty(sidebar, "offsetWidth", { value: 200 });
    Object.defineProperty(sidebar, "offsetHeight", { value: 600 });
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
      if (el === content) {
        return {
          getPropertyValue: (name: string) => (name === "--sidebar-width" ? "200px" : name === "margin-left" ? "0px" : "")
        } as CSSStyleDeclaration;
      }
      return {
        getPropertyValue: () => "",
        display: "block",
        visibility: "visible"
      } as unknown as CSSStyleDeclaration;
    });
    try {
      expect(pdfSidebarOverlapOffset(chrome, sidebar, content, content.parentElement)).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("measures overlap when the sidebar covers the chrome left edge", () => {
    const chrome = document.createElement("div");
    const sidebar = document.createElement("div");
    const content = document.createElement("div");
    content.classList.add("pdf-content-container", "sidebarOpen");
    chrome.getBoundingClientRect = () => rect(0, 1000);
    sidebar.getBoundingClientRect = () => rect(0, 240);
    Object.defineProperty(sidebar, "offsetWidth", { value: 240 });
    Object.defineProperty(sidebar, "offsetHeight", { value: 600 });
    expect(pdfSidebarOverlapOffset(chrome, sidebar, content)).toBe(240);
  });

  it("falls back to --sidebar-width when geometry is empty but sidebarOpen", () => {
    const chrome = document.createElement("div");
    const sidebar = document.createElement("div");
    const content = document.createElement("div");
    content.classList.add("pdf-content-container", "sidebarOpen");
    document.body.append(content, sidebar, chrome);
    chrome.getBoundingClientRect = () => rect(0, 1000);
    sidebar.getBoundingClientRect = () => rect(0, 0);
    Object.defineProperty(sidebar, "offsetWidth", { value: 0 });
    Object.defineProperty(sidebar, "offsetHeight", { value: 0 });
    const style = {
      getPropertyValue: (name: string) => (name === "--sidebar-width" ? "200px" : name === "margin-left" ? "0px" : "")
    };
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
      if (el === content) return style as CSSStyleDeclaration;
      return {
        getPropertyValue: () => "",
        display: "block",
        visibility: "visible"
      } as unknown as CSSStyleDeclaration;
    });
    try {
      expect(pdfSidebarOverlapOffset(chrome, sidebar, content, content.parentElement)).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it("writes the CSS variable on left chrome and clears it for right chrome", () => {
    const scope = document.createElement("div");
    const content = document.createElement("div");
    content.className = "pdf-content-container sidebarOpen";
    const sidebar = document.createElement("div");
    sidebar.className = "pdf-sidebar-container";
    Object.defineProperty(sidebar, "offsetWidth", { value: 180 });
    Object.defineProperty(sidebar, "offsetHeight", { value: 600 });
    sidebar.getBoundingClientRect = () => rect(0, 180);
    const chrome = document.createElement("div");
    chrome.className = "native-pdf-handwriting-chrome is-toolbar-left";
    chrome.getBoundingClientRect = () => rect(0, 900);
    scope.append(content, sidebar, chrome);
    document.body.append(scope);

    expect(syncLeftChromeWithPdfSidebar(chrome, scope)).toMatchObject({
      offset: 180,
      reason: "geometry-overlap"
    });
    expect(chrome.style.getPropertyValue(INK_PDF_SIDEBAR_OFFSET_VAR)).toBe("180px");

    chrome.classList.remove("is-toolbar-left");
    chrome.classList.add("is-toolbar-right");
    expect(syncLeftChromeWithPdfSidebar(chrome, scope)).toMatchObject({
      offset: 0,
      reason: "not-left-toolbar"
    });
    expect(chrome.style.getPropertyValue(INK_PDF_SIDEBAR_OFFSET_VAR)).toBe("");
  });

  it("offsets the left ink rail when the Obsidian PDF sidebar opens over it", async () => {
    const host = document.createElement("div");
    host.className = "pdf-container workspace-leaf";
    const toolbarHost = document.createElement("div");
    toolbarHost.className = "pdf-toolbar";
    const content = document.createElement("div");
    content.className = "pdf-content-container";
    content.style.position = "relative";
    const sidebar = document.createElement("div");
    sidebar.className = "pdf-sidebar-container";
    Object.defineProperty(sidebar, "offsetWidth", { configurable: true, get: () => content.classList.contains("sidebarOpen") ? 220 : 0 });
    Object.defineProperty(sidebar, "offsetHeight", { value: 600 });
    sidebar.getBoundingClientRect = () => (
      content.classList.contains("sidebarOpen") ? rect(0, 220) : rect(0, 0)
    );
    const scroll = document.createElement("div");
    scroll.className = "pdf-viewer-scroll-container";
    Object.defineProperty(scroll, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroll, "clientHeight", { value: 600, configurable: true });
    const viewer = document.createElement("div");
    viewer.className = "pdf-viewer";
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "1";
    page.dataset.scale = "1";
    page.dataset.rotation = "0";
    page.append(document.createElement("canvas"));
    viewer.append(page);
    scroll.append(viewer);
    content.append(sidebar, scroll);
    host.append(toolbarHost, content);
    document.body.append(host);

    const adapter = NativePdfViewAdapter.attach(host);
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-handwriting-toolbar";
    adapter.mountToolbar(toolbar, "left");

    const chrome = host.querySelector<HTMLElement>(".native-pdf-handwriting-chrome");
    expect(chrome).not.toBeNull();
    chrome!.getBoundingClientRect = () => rect(0, 1000);
    expect(chrome!.style.getPropertyValue(INK_PDF_SIDEBAR_OFFSET_VAR)).toBe("");

    content.classList.add("sidebarOpen");
    content.dispatchEvent(new Event("transitionend"));
    // MutationObserver + rAF — flush both.
    await Promise.resolve();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    syncLeftChromeWithPdfSidebar(chrome!, host);
    expect(chrome!.style.getPropertyValue(INK_PDF_SIDEBAR_OFFSET_VAR)).toBe("220px");
    expect(scroll.contains(host.querySelector(".native-pdf-handwriting-rail")!)).toBe(false);
    adapter.destroy();
  });
});
