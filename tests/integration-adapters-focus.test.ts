import { afterEach, describe, expect, it, vi } from "vitest";
import { FocusOverlay } from "../src/focus-view/FocusOverlay";
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
  canvas.width = 900;
  canvas.height = 1200;
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
    adapter.root.dispatchEvent(new Event("scroll"));
    expect(stateChanges).toHaveBeenCalledOnce();
    adapter.destroy();
    expect(overlay.isConnected).toBe(false);
    expect(toolbar.isConnected).toBe(false);
    adapter.root.dispatchEvent(new Event("scroll"));
    expect(stateChanges).toHaveBeenCalledOnce();
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
});

describe("focus overlay", () => {
  it("ignores internal/portaled controls and dismisses outside after flushing", async () => {
    const flush = vi.fn(async () => undefined);
    const closed = vi.fn();
    const overlay = new FocusOverlay({ document, autosave: () => true, isDirty: () => true, flush, decideUnsaved: vi.fn(), onClosed: closed });
    overlay.content.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(overlay.element.isConnected).toBe(true);
    const portal = document.createElement("button");
    portal.dataset.focusOverlayInternal = "true";
    document.body.append(portal);
    portal.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(overlay.element.isConnected).toBe(true);
    const outside = document.createElement("div");
    document.body.append(outside);
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledWith("outside");
    expect(overlay.element.isConnected).toBe(false);
  });

  it("honors cancel and save decisions when autosave is off", async () => {
    const flush = vi.fn(async () => undefined);
    const decide = vi.fn().mockResolvedValueOnce("cancel").mockResolvedValueOnce("save");
    const overlay = new FocusOverlay({ document, autosave: () => false, isDirty: () => true, flush, decideUnsaved: decide });
    expect(await overlay.requestClose("escape")).toBe(false);
    expect(overlay.element.isConnected).toBe(true);
    expect(await overlay.requestClose("close-button")).toBe(true);
    expect(flush).toHaveBeenCalledOnce();
  });
});
