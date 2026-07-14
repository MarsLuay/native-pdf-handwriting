import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedPdfAdapter } from "../src/integration/EmbeddedPdfAdapter";
import { NativePdfViewAdapter } from "../src/integration/NativePdfViewAdapter";

afterEach(() => { document.body.replaceChildren(); });

function pdfViewer(): HTMLElement {
  const viewer = document.createElement("div");
  viewer.className = "pdf-viewer";
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  page.dataset.scale = "1.5";
  page.dataset.rotation = "90";
  const canvas = document.createElement("canvas");
  canvas.width = 2400;
  canvas.height = 1800;
  page.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 900,
    width: 1200, height: 900, toJSON: () => ({})
  });
  page.append(canvas);
  viewer.append(page);
  return viewer;
}

function compatibleHost(className = "workspace-leaf"): HTMLElement {
  const host = document.createElement("div");
  host.className = className;
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar";
  host.append(toolbar, pdfViewer());
  document.body.append(host);
  return host;
}

describe("PDF adapters", () => {
  it("fails clearly when direct or embedded selectors change", () => {
    const host = document.createElement("div");
    expect(() => NativePdfViewAdapter.attach(host)).toThrow(/PDF viewer root missing/);
    expect(() => EmbeddedPdfAdapter.attach(host)).toThrow(/embedded PDF adapter incompatible/);
  });

  it("locates page metrics, mounts shared UI, and reverses cleanup", () => {
    const host = compatibleHost();
    const stateChanges = vi.fn();
    const adapter = NativePdfViewAdapter.attach(host, { onViewStateChange: stateChanges });
    expect(adapter.pages()[0]).toMatchObject({ pageNumber: 1, width: 600, height: 800, scale: 1.5, rotation: 90 });
    const overlay = adapter.mountOverlay(1);
    const toolbar = document.createElement("div");
    adapter.mountToolbar(toolbar);
    adapter.scrollElement().dispatchEvent(new Event("scroll"));
    expect(stateChanges).toHaveBeenCalledOnce();
    adapter.destroy();
    expect(overlay.isConnected).toBe(false);
    expect(toolbar.isConnected).toBe(false);
    adapter.root.dispatchEvent(new Event("scroll"));
    expect(stateChanges).toHaveBeenCalledOnce();
  });

  it("replaces stale annotation toolbars when mounting again", () => {
    const host = compatibleHost();
    const adapter = NativePdfViewAdapter.attach(host);
    const stale = document.createElement("div");
    stale.className = "native-pdf-ink-toolbar";
    const fresh = document.createElement("div");
    fresh.className = "native-pdf-ink-toolbar";
    adapter.mountToolbar(stale);
    adapter.mountToolbar(fresh);
    const toolbars = host.querySelectorAll(".native-pdf-ink-toolbar");
    expect(toolbars).toHaveLength(1);
    expect(toolbars[0]).toBe(fresh);
    adapter.destroy();
  });

  it("ignores selection toolbar mount inside overlay", () => {
    const host = compatibleHost();
    const pageChanges = vi.fn();
    const adapter = NativePdfViewAdapter.attach(host, { onPagesChanged: pageChanges });
    const overlay = adapter.mountOverlay(1);
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-ink-selection-toolbar";
    toolbar.dataset.focusOverlayInternal = "true";
    overlay.append(toolbar);
    expect(pageChanges).not.toHaveBeenCalled();
    adapter.destroy();
  });

  it("ignores annotation overlay mutations when watching page changes", () => {
    const host = compatibleHost();
    const pageChanges = vi.fn();
    const adapter = NativePdfViewAdapter.attach(host, { onPagesChanged: pageChanges });
    adapter.mountOverlay(1);
    expect(pageChanges).not.toHaveBeenCalled();
    adapter.destroy();
  });

  it("routes data-scale attribute changes to view state instead of page remounts", async () => {
    const host = compatibleHost();
    const pageChanges = vi.fn();
    const stateChanges = vi.fn();
    const adapter = NativePdfViewAdapter.attach(host, {
      onPagesChanged: pageChanges,
      onViewStateChange: stateChanges
    });
    const page = host.querySelector(".page") as HTMLElement;
    page.dataset.scale = "2";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(pageChanges).not.toHaveBeenCalled();
    expect(stateChanges).toHaveBeenCalled();
    expect(stateChanges.mock.calls.at(-1)?.[1]).toBe("data-scale");
    adapter.destroy();
  });

  it("discovers embedded PDFs", () => {
    const note = document.createElement("div");
    const embed = document.createElement("div");
    embed.className = "internal-embed";
    embed.setAttribute("src", "paper.pdf");
    embed.append(pdfViewer());
    note.append(embed);
    expect(EmbeddedPdfAdapter.discover(note)).toHaveLength(1);
  });

  it("ignores PDF++ DOM mutations when watching page changes", async () => {
    const host = compatibleHost();
    const pageChanges = vi.fn();
    const adapter = NativePdfViewAdapter.attach(host, { onPagesChanged: pageChanges });
    const page = host.querySelector(".page") as HTMLElement;
    const layer = document.createElement("div");
    layer.className = "pdf-plus-backlink-highlight-layer";
    page.append(layer);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(pageChanges).not.toHaveBeenCalled();
    adapter.destroy();
  });

  it("mounts annotation toolbar after PDF++ color palette", () => {
    const host = compatibleHost();
    const toolbarHost = host.querySelector(".pdf-toolbar") as HTMLElement;
    const palette = document.createElement("div");
    palette.className = "pdf-plus-color-palette";
    toolbarHost.append(palette);
    const adapter = NativePdfViewAdapter.attach(host);
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-ink-toolbar";
    adapter.mountToolbar(toolbar);
    expect(palette.nextSibling).toBe(toolbar);
    adapter.destroy();
  });

  it("keeps sidebar rail outside the PDF scroll container", () => {
    const host = document.createElement("div");
    host.className = "workspace-leaf";
    const toolbarHost = document.createElement("div");
    toolbarHost.className = "pdf-toolbar";
    const scroll = document.createElement("div");
    scroll.className = "pdf-viewer-scroll-container";
    Object.defineProperty(scroll, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroll, "clientHeight", { value: 600, configurable: true });
    scroll.append(pdfViewer());
    host.append(toolbarHost, scroll);
    document.body.append(host);

    const adapter = NativePdfViewAdapter.attach(host);
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-ink-toolbar";
    adapter.mountToolbar(toolbar, "left");

    const chrome = host.querySelector(".native-pdf-ink-chrome");
    const rail = host.querySelector(".native-pdf-ink-rail");
    expect(chrome).not.toBeNull();
    expect(chrome?.classList.contains("is-toolbar-left")).toBe(true);
    expect(rail?.parentElement).toBe(chrome);
    expect(scroll.parentElement).toBe(chrome);
    expect(scroll.contains(rail!)).toBe(false);
    expect(chrome?.contains(adapter.root)).toBe(true);
    adapter.destroy();
  });

  it("pins right sidebar with chrome grid class even when remounting", () => {
    const host = document.createElement("div");
    host.className = "workspace-leaf";
    const toolbarHost = document.createElement("div");
    toolbarHost.className = "pdf-toolbar";
    const scroll = document.createElement("div");
    scroll.className = "pdf-viewer-scroll-container";
    Object.defineProperty(scroll, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroll, "clientHeight", { value: 600, configurable: true });
    scroll.append(pdfViewer());
    host.append(toolbarHost, scroll);
    document.body.append(host);

    const adapter = NativePdfViewAdapter.attach(host);
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-ink-toolbar";
    adapter.mountToolbar(toolbar, "left");
    adapter.mountToolbar(toolbar, "right");

    const chrome = host.querySelector(".native-pdf-ink-chrome");
    const rail = host.querySelector(".native-pdf-ink-rail");
    expect(chrome?.classList.contains("is-toolbar-right")).toBe(true);
    expect(chrome?.classList.contains("is-toolbar-left")).toBe(false);
    expect(rail?.classList.contains("is-right")).toBe(true);
    expect(toolbar.classList.contains("is-sidebar-right")).toBe(true);
    expect(rail?.parentElement?.lastElementChild).toBe(rail);
    adapter.destroy();
  });
});
