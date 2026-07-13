import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsidianPdfAdapter, PdfViewState } from "../src/integration/ObsidianPdfAdapter";
import type { PdfPageInfo } from "../src/integration/PdfPageLocator";
import { DEFAULT_SETTINGS } from "../src/model";
import { ViewerInkSession } from "../src/runtime/ViewerInkSession";
import { RecoveryRepository } from "../src/storage/RecoveryRepository";
import { SidecarRepository, type TextFileAdapter } from "../src/storage/SidecarRepository";

class MemoryFiles implements TextFileAdapter {
  readonly values = new Map<string, string>();
  async exists(path: string): Promise<boolean> { return this.values.has(path); }
  async read(path: string): Promise<string> {
    const value = this.values.get(path);
    if (value === undefined) throw new Error(`Missing ${path}`);
    return value;
  }
  async write(path: string, contents: string): Promise<void> { this.values.set(path, contents); }
  async remove(path: string): Promise<void> { this.values.delete(path); }
}

class FakeAdapter implements ObsidianPdfAdapter {
  readonly kind = "direct" as const;
  readonly root = document.createElement("div");
  readonly pageElement = document.createElement("div");
  readonly toolbarHost = document.createElement("div");
  destroyed = false;

  constructor() {
    this.pageElement.dataset.pageNumber = "1";
    Object.defineProperty(this.pageElement, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800, x: 0, y: 0, toJSON: () => ({}) })
    });
    this.root.append(this.toolbarHost, this.pageElement);
    document.body.append(this.root);
  }

  pages(): PdfPageInfo[] {
    return [{ pageNumber: 1, width: 600, height: 800, scale: 1, rotation: 0, element: this.pageElement }];
  }
  getViewState(): PdfViewState { return { pageNumber: 1, scrollFraction: 0, scale: 1, rotation: 0 }; }
  restoreViewState(): void {}
  mountOverlay(pageNumber: number): HTMLElement {
    const overlay = document.createElement("div");
    overlay.dataset.pageNumber = String(pageNumber);
    this.pageElement.append(overlay);
    return overlay;
  }
  mountToolbar(toolbar: HTMLElement): void { this.toolbarHost.append(toolbar); }
  destroy(): void { this.destroyed = true; this.root.remove(); }
}

function pointer(type: string, x: number, y: number): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerType: { value: "pen" },
    pointerId: { value: 7 },
    pressure: { value: 0.6 },
    tiltX: { value: 4 },
    tiltY: { value: 2 },
    width: { value: 1 },
    height: { value: 1 },
    buttons: { value: type === "pointerup" ? 0 : 1 },
    getCoalescedEvents: { value: () => [] }
  });
  return event as unknown as PointerEvent;
}

describe("viewer runtime tracer", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn()
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => document.body.replaceChildren());

  it("draws a stylus stroke, saves sidecar, exports copy, and cleans up", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const sourceBytes = await source.save();
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    let exported: Uint8Array | undefined;
    const settings = structuredClone(DEFAULT_SETTINGS);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => sourceBytes,
      writeExport: async (_name, bytes) => { exported = bytes; },
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    await session.manualSave();

    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(sidecar).toBeDefined();
    expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);

    await session.exportCopy();
    expect(exported).toBeDefined();
    await expect(PDFDocument.load(exported!)).resolves.toBeDefined();
    expect([...sourceBytes]).toEqual([...await source.save()]);

    await expect(session.destroy()).resolves.toBe(true);
    expect(adapter.destroyed).toBe(true);
  });
});
