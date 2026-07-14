import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsidianPdfAdapter, PdfViewState } from "../src/integration/ObsidianPdfAdapter";
import type { PdfPageInfo } from "../src/integration/PdfPageLocator";
import { DEFAULT_SETTINGS } from "../src/model";
import { ViewerInkSession } from "../src/runtime/ViewerInkSession";
import { RecoveryRepository } from "../src/storage/RecoveryRepository";
import { SidecarRepository, type TextFileAdapter } from "../src/storage/SidecarRepository";
import { createDocumentIdentity } from "../src/storage/DocumentIdentity";
import { serializeSidecar } from "../src/storage/SidecarSchema";

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
  readonly host = document.createElement("div");
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
  scrollElement(): HTMLElement { return this.root; }
  mountOverlay(pageNumber: number): HTMLElement {
    const overlay = document.createElement("div");
    overlay.dataset.pageNumber = String(pageNumber);
    this.pageElement.append(overlay);
    return overlay;
  }
  mountToolbar(toolbar: HTMLElement): void { this.toolbarHost.append(toolbar); }
  compatibilityReport(): { errors: string[]; warnings: string[] } {
    return { errors: [], warnings: [] };
  }
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
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), rect: vi.fn(), ellipse: vi.fn()
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

    const nativePointer = pointer("pointerdown", 100, 120);
    adapter.pageElement.dispatchEvent(nativePointer);
    adapter.pageElement.dispatchEvent(pointer("pointerup", 100, 120));
    // Draw off: stylus tip is captured for drag-scroll (same as mouse).
    expect(nativePointer.defaultPrevented).toBe(true);

    const draw = adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']");
    expect(draw).toMatchObject({ checked: false });
    draw?.click();
    expect(draw).toMatchObject({ checked: true });
    expect(adapter.root.classList.contains("native-pdf-ink-hide-native-cursor")).toBe(true);

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    await session.manualSave();

    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(sidecar).toBeDefined();
    expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);

    settings.toolPreferences.activeTool = "eraser";
    settings.toolPreferences.eraser.size = 12;
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 130, 150));
    settings.toolPreferences.eraser.size = 1_000;
    adapter.pageElement.dispatchEvent(pointer("pointerup", 130, 150));
    await session.manualSave();
    const erasedSidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(erasedSidecar![1]).pages[0].strokes).toHaveLength(2);

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='undo']")?.click();
    await session.manualSave();
    const restoredSidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(restoredSidecar![1]).pages[0].strokes).toHaveLength(1);

    settings.toolPreferences.eraser.size = 12;
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointercancel", 130, 150));
    await session.manualSave();
    const cancelledSidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(cancelledSidecar![1]).pages[0].strokes).toHaveLength(1);

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='redo']")?.click();
    await session.manualSave();
    const redoneSidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(redoneSidecar![1]).pages[0].strokes).toHaveLength(2);

    await session.exportCopy();
    expect(exported).toBeDefined();
    await expect(PDFDocument.load(exported!)).resolves.toBeDefined();
    expect([...sourceBytes]).toEqual([...await source.save()]);

    await expect(session.destroy()).resolves.toBe(true);
    expect(adapter.destroyed).toBe(true);
  });

  it("renders a lasso outline while dragging", async () => {
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), rect: vi.fn(), ellipse: vi.fn()
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);

    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "lasso";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 180, 220));

    expect(context.moveTo).toHaveBeenCalled();
    expect(context.lineTo).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
    await session.destroy();
  });

  it("keeps the lasso visible and moves selected ink when dragged inside it", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    settings.toolPreferences.activeTool = "lasso";
    settings.toolPreferences.lasso.type = "rectangle";
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 100));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 180, 220));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 180, 220));
    await session.manualSave();
    const before = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes[0].points[0];

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 200));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 220, 360));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 220, 360));
    await session.manualSave();
    const after = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes[0].points[0];

    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeLessThan(before.y);
    await session.destroy();
  });

  it("moves selected ink when dragged in draw mode with pen active", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    settings.toolPreferences.activeTool = "lasso";
    settings.toolPreferences.lasso.type = "rectangle";
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 100));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 180, 220));
    await session.manualSave();
    const beforeCount = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes.length;
    const before = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes[0].points[0];

    settings.toolPreferences.activeTool = "pen";
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 140));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 220, 240));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 220, 240));
    await session.manualSave();
    const afterSidecar = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes;
    expect(afterSidecar).toHaveLength(beforeCount);
    expect(afterSidecar[0].points[0].x).toBeGreaterThan(before.x);
    expect(afterSidecar[0].points[0].y).toBeLessThan(before.y);
    await session.destroy();
  });

  it("supports copy, cut, paste, and delete shortcuts in draw mode", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));

    const selectAll = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true });
    expect(session.handleKeyDown(selectAll)).toBe(true);
    expect(selectAll.defaultPrevented).toBe(true);

    const strokeCount = () => {
      const entry = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
      if (!entry) return 0;
      return JSON.parse(entry[1]).pages.flatMap((page: { strokes: unknown[] }) => page.strokes).length;
    };

    const copy = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    expect(session.handleKeyDown(copy)).toBe(true);
    expect(copy.defaultPrevented).toBe(true);

    const del = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    expect(session.handleKeyDown(del)).toBe(true);
    await session.manualSave();
    expect(strokeCount()).toBe(0);

    const paste = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true });
    expect(session.handleKeyDown(paste)).toBe(true);
    await session.manualSave();
    const restored = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].strokes;
    expect(restored).toHaveLength(1);
    expect(restored[0].points[0].x).toBeGreaterThan(100);

    const cut = new KeyboardEvent("keydown", { key: "x", metaKey: true, bubbles: true, cancelable: true });
    expect(session.handleKeyDown(cut)).toBe(true);
    await session.manualSave();
    expect(strokeCount()).toBe(0);

    expect(session.handleKeyDown(paste)).toBe(true);
    await session.manualSave();
    expect(strokeCount()).toBe(1);

    document.querySelector<HTMLButtonElement>(".native-pdf-ink-selection-toolbar button:last-of-type")?.click();
    expect(session.handleKeyDown(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }))).toBe(false);
    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    expect(session.handleKeyDown(paste)).toBe(false);
    expect(session.handleKeyDown(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true }))).toBe(false);

    await session.destroy();
  });

  it("clears selection when draw mode turns off", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    settings.toolPreferences.activeTool = "lasso";
    settings.toolPreferences.lasso.type = "rectangle";
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 100));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 180, 220));

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    const del = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    expect(session.handleKeyDown(del)).toBe(false);
    await session.manualSave();
    const entry = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    const strokes = entry ? JSON.parse(entry[1]).pages.flatMap((page: { strokes: unknown[] }) => page.strokes) : [];
    expect(strokes).toHaveLength(1);

    await session.destroy();
  });

  it("emergency-persists dirty ink without waiting for autosave", async () => {
    const files = new MemoryFiles();
    const sidecars = new SidecarRepository(files, "annotations");
    const recovery = new RecoveryRepository(files, "recovery");
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.autosaveDelayMs = 60_000;
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/example.pdf",
      settings,
      sidecars,
      recovery,
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));

    const writes = new Map<string, string>();
    session.emergencyPersist((path, contents) => writes.set(path, contents));

    expect(writes.size).toBe(2);
    const persisted = [...writes.values()][0];
    expect(persisted).toBeDefined();
    expect(JSON.parse(persisted!).pages[0].strokes).toHaveLength(1);
    await session.destroy({ alreadyPersisted: true });
  });

  it("abandoned session refuses emergency and async persist", async () => {
    const files = new MemoryFiles();
    const sidecars = new SidecarRepository(files, "annotations");
    const recovery = new RecoveryRepository(files, "recovery");
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.autosaveDelayMs = 60_000;
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/example.pdf",
      settings,
      sidecars,
      recovery,
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));

    session.abandonWrites("test-stale");
    const writes = new Map<string, string>();
    session.emergencyPersist((path, contents) => writes.set(path, contents), { force: true, reason: "test" });
    expect(writes.size).toBe(0);

    await session.destroy({ silent: true, alreadyPersisted: true });
  });

  it("loads newer recovery data when the sidecar is stale", async () => {
    const files = new MemoryFiles();
    const sidecars = new SidecarRepository(files, "annotations");
    const recovery = new RecoveryRepository(files, "recovery");
    const adapter = new FakeAdapter();
    const settings = structuredClone(DEFAULT_SETTINGS);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/example.pdf",
      settings,
      sidecars,
      recovery,
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    await session.manualSave();

    const documentId = createDocumentIdentity({ vaultPath: "Notes/example.pdf" }).id;
    const saved = JSON.parse(await files.read(sidecars.pathFor(documentId)));
    saved.updatedAt = "2026-01-01";
    saved.pages = [];
    await files.write(sidecars.pathFor(documentId), serializeSidecar(saved));

    const recovered = structuredClone(saved);
    recovered.updatedAt = "2026-02-01";
    recovered.pages = [{
      page: 1,
      width: 600,
      height: 800,
      rotation: 0,
      strokes: [{
        id: "stroke-1",
        page: 1,
        tool: "pen",
        color: "#111827",
        width: 2.5,
        opacity: 1,
        inputType: "pen",
        points: [{ x: 100, y: 120, pressure: 0.6, time: 1 }],
        createdAt: "2026-02-01",
        updatedAt: "2026-02-01"
      }]
    }];
    await recovery.save(recovered);
    await session.destroy();

    const reloaded = await ViewerInkSession.create({
      adapter: new FakeAdapter(),
      pdfPath: "Notes/example.pdf",
      settings,
      sidecars,
      recovery,
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    await reloaded.manualSave();
    const entry = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(entry).toBeDefined();
    expect(JSON.parse(entry![1]).pages[0].strokes).toHaveLength(1);
    await reloaded.destroy();
  });
});
