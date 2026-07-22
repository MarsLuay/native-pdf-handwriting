import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsidianPdfAdapter, PdfViewState } from "../src/integration/ObsidianPdfAdapter";
import type { PdfPageInfo } from "../src/integration/PdfPageLocator";
import { DEFAULT_SETTINGS, type InkStroke, type PdfPoint, type PdfTextAnnotation } from "../src/model";
import { ViewerInkSession } from "../src/runtime/ViewerInkSession";
import { HN_DEV_PROBE_ACTIVE_KEY, HN_DEV_PROBE_EVENT, type HnDevProbeDiagnostic } from "../src/runtime/DevProbeDiagnostics";
import { RecoveryRepository } from "../src/storage/RecoveryRepository";
import { SidecarRepository, type TextFileAdapter } from "../src/storage/SidecarRepository";
import { createDocumentIdentity } from "../src/storage/DocumentIdentity";
import { serializeSidecar } from "../src/storage/SidecarSchema";
import type { TextStyleChange } from "../src/ui/TextDropdown";

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
    this.host.append(this.root);
    document.body.append(this.host);
  }

  pages(): PdfPageInfo[] {
    return [{ pageNumber: 1, width: 600, height: 800, scale: 1, rotation: 0, element: this.pageElement }];
  }
  page(pageNumber: number): PdfPageInfo | undefined {
    return this.pages().find((page) => page.pageNumber === pageNumber);
  }
  getViewState(): PdfViewState { return { pageNumber: 1, scrollFraction: 0, scale: 1, rotation: 0 }; }
  restoreViewState(): void {}
  scrollElement(): HTMLElement { return this.root; }
  mountOverlay(pageNumber: number): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "native-pdf-handwriting-page-overlay";
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

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

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

    const nativeSidebarHandle = document.createElement("div");
    nativeSidebarHandle.className = "pdf-sidebar-resizer";
    adapter.host.append(nativeSidebarHandle);
    const sidebarPointer = pointer("pointerdown", 16, 16);
    nativeSidebarHandle.dispatchEvent(sidebarPointer);
    // Draw-off drag panning must not take over the native sidebar's resize handle.
    expect(sidebarPointer.defaultPrevented).toBe(false);

    const nativePointer = pointer("pointerdown", 100, 120);
    adapter.pageElement.dispatchEvent(nativePointer);
    adapter.pageElement.dispatchEvent(pointer("pointerup", 100, 120));
    // Draw off: mouse/stylus claim is deferred until drag activates (clicks stay native).
    expect(nativePointer.defaultPrevented).toBe(false);

    const dragDown = pointer("pointerdown", 100, 120);
    const dragMove = pointer("pointermove", 100, 160);
    adapter.pageElement.dispatchEvent(dragDown);
    adapter.pageElement.dispatchEvent(dragMove);
    adapter.pageElement.dispatchEvent(pointer("pointerup", 100, 160));
    expect(dragDown.defaultPrevented).toBe(false);
    expect(dragMove.defaultPrevented).toBe(true);

    const draw = adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']");
    expect(draw).toMatchObject({ checked: false });
    draw?.click();
    expect(draw).toMatchObject({ checked: true });
    expect(adapter.root.classList.contains("native-pdf-handwriting-hide-native-cursor")).toBe(true);

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    const diagnostics: HnDevProbeDiagnostic[] = [];
    const listener = (event: Event) => diagnostics.push((event as CustomEvent<HnDevProbeDiagnostic>).detail);
    window.addEventListener(HN_DEV_PROBE_EVENT, listener);
    (window as Window & { [HN_DEV_PROBE_ACTIVE_KEY]?: boolean })[HN_DEV_PROBE_ACTIVE_KEY] = true;
    try {
      await session.manualSave();
    } finally {
      delete (window as Window & { [HN_DEV_PROBE_ACTIVE_KEY]?: boolean })[HN_DEV_PROBE_ACTIVE_KEY];
      window.removeEventListener(HN_DEV_PROBE_EVENT, listener);
    }

    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(sidecar).toBeDefined();
    expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);
    expect(diagnostics.find((diagnostic) => diagnostic.type === "sidecar-persist")).toMatchObject({
      metrics: { outcome: "saved", strokeCount: 1, textCount: 0 }
    });
    expect(diagnostics.find((diagnostic) => diagnostic.type === "manual-save")).toMatchObject({
      metrics: { ok: true, durationMs: expect.any(Number) }
    });

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

  it("consumes an outside text-tool click to close the active editor before creating another box", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
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
    adapter.pageElement.dispatchEvent(pointer("pointerup", 100, 120));
    const firstEditor = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-input");
    const overlay = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-page-overlay");
    expect(firstEditor).not.toBeNull();
    expect(firstEditor?.parentElement).toBe(overlay);
    expect(firstEditor?.tabIndex).toBe(0);
    expect(document.activeElement).toBe(firstEditor);

    // Empty editor: the next PDF click closes/discards it but does not open another editor.
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 240, 300));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 240, 300));
    expect(adapter.pageElement.querySelectorAll(".native-pdf-handwriting-text-input")).toHaveLength(0);
    expect(adapter.pageElement.querySelectorAll(".native-pdf-handwriting-text-box")).toHaveLength(0);

    // With no editor open, the following click is the one that creates a new box.
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 240, 300));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 240, 300));
    const editor = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-input");
    expect(editor).not.toBeNull();
    editor!.textContent = "Keep this annotation";
    editor!.dispatchEvent(new Event("input", { bubbles: true }));

    // Non-empty editor: outside click commits it and still does not open another editor.
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 360, 420));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 360, 420));
    expect(adapter.pageElement.querySelectorAll(".native-pdf-handwriting-text-input")).toHaveLength(0);
    expect(adapter.pageElement.querySelectorAll(".native-pdf-handwriting-text-box")).toHaveLength(1);

    await session.destroy();
  });

  it("updates an active text font size without a redundant session refresh", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
    const adapter = new FakeAdapter();
    const saveSettings = vi.fn(async () => undefined);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/example.pdf",
      settings,
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    try {
      adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
      adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
      adapter.pageElement.dispatchEvent(pointer("pointerup", 100, 120));
      const editor = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-input");
      expect(editor).not.toBeNull();

      const refresh = vi.spyOn(session, "refresh");
      adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
      const size = document.querySelector<HTMLInputElement>(".native-pdf-handwriting-text-menu input[type='number']");
      expect(size).not.toBeNull();
      size!.value = "36";
      size!.dispatchEvent(new Event("change", { bubbles: true }));

      expect(editor?.style.fontSize).toBe("36px");
      expect(settings.toolPreferences.text.fontSize).toBe(36);
      expect(saveSettings).toHaveBeenCalledWith(settings.toolPreferences);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      await session.destroy();
    }
  });

  it("patches an existing text box style without resetting its other properties and protects IME composition", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
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
    const existing: PdfTextAnnotation = {
      id: "existing", page: 1, text: "Keep my style", x: 100, y: 300, width: 180, height: 32,
      color: "#111827", fontSize: 18, fontFamily: "serif", bold: true, italic: true, strikethrough: true,
      runs: [{ text: "Keep my style", color: "#111827", fontSize: 18, fontFamily: "serif", bold: true, italic: true, strikethrough: true }],
      sourceRuns: [{ text: "Keep my style", color: "#111827", fontSize: 18, fontFamily: "serif", bold: true, italic: true, strikethrough: true }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      openTextEditor(surface: unknown, text: PdfTextAnnotation): void;
      applyTextStyleToActiveEditor(change: { property: "color"; value: string; source: "input" }): void;
      commitActiveTextEditor(reason: string): void;
      activeTextEditor: { element: HTMLElement } | null;
      selectedTexts: PdfTextAnnotation[];
      selectionPage: number | null;
    };
    internal.texts.add(existing);
    internal.openTextEditor(internal.surfaces.get(1), existing);
    const initialEditor = internal.activeTextEditor!.element;
    const allText = initialEditor.ownerDocument.createRange();
    allText.selectNodeContents(initialEditor);
    const nativeSelection = initialEditor.ownerDocument.getSelection();
    nativeSelection?.removeAllRanges();
    nativeSelection?.addRange(allText);
    internal.applyTextStyleToActiveEditor({ property: "color", value: "#dc2626", source: "input" });
    internal.commitActiveTextEditor("test");
    expect(internal.texts.all()[0]).toMatchObject({
      color: "#dc2626", fontSize: 18, fontFamily: "serif", bold: true, italic: true, strikethrough: true
    });

    internal.selectedTexts = [internal.texts.all()[0]!];
    internal.selectionPage = 1;
    internal.applyTextStyleToActiveEditor({ property: "color", value: "#2563eb", source: "input" });
    expect(internal.texts.all()[0]).toMatchObject({ color: "#2563eb", fontSize: 18, fontFamily: "serif", bold: true });
    expect(internal.texts.all()[0]?.runs[0]?.color).toBe("#2563eb");

    internal.openTextEditor(internal.surfaces.get(1), internal.texts.all()[0]!);
    const editor = internal.activeTextEditor!.element;
    editor.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    const composingEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    editor.dispatchEvent(composingEscape);
    expect(composingEscape.defaultPrevented).toBe(false);
    expect(internal.activeTextEditor?.element).toBe(editor);
    editor.dispatchEvent(new Event("compositionend", { bubbles: true }));
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    editor.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(internal.activeTextEditor).toBeNull();
    await session.destroy();
  });

  it("commits an active text editor when switching away from the Text tool", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
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
    const annotation: PdfTextAnnotation = {
      id: "switch-tools", page: 1, text: "Before", x: 100, y: 300, width: 160, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Before", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Before", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      openTextEditor(surface: unknown, text: PdfTextAnnotation): void;
      activeTextEditor: { element: HTMLElement } | null;
    };
    internal.texts.add(annotation);
    internal.openTextEditor(internal.surfaces.get(1), annotation);
    internal.activeTextEditor!.element.textContent = "After";
    internal.activeTextEditor!.element.dispatchEvent(new Event("input", { bubbles: true }));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='eraser']")?.click();

    expect(internal.activeTextEditor).toBeNull();
    expect(internal.texts.all()).toMatchObject([{ id: "switch-tools", text: "After" }]);
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).toBeNull();
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-box")).not.toBeNull();
    await session.destroy();
  });

  it("moves selected ink and text together from the normal selection outline", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
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
    const stroke = {
      id: "ink", page: 1, tool: "pen" as const, color: "#000000", width: 2, opacity: 1,
      inputType: "pen" as const, points: [{ x: 100, y: 680, pressure: 1, time: 0 }], createdAt: "now", updatedAt: "now"
    };
    const text: PdfTextAnnotation = {
      id: "text", page: 1, text: "Move with ink", x: 220, y: 650, width: 140, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Move with ink", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Move with ink", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const sample = (clientX: number, clientY: number) => ({
      pointerId: 7, pointerType: "pen" as const, clientX, clientY, pressure: 1, tiltX: 0, tiltY: 0,
      width: 1, height: 1, buttons: 1, timeStamp: 0
    });
    const internal = session as unknown as {
      ink: { add(value: InkStroke): void; all(): InkStroke[] };
      texts: { add(annotation: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      selectAllOnCurrentPage(): void;
      tryStartSelectionMove(surface: unknown, input: { clientX: number; clientY: number }): boolean;
      pointerMove(surface: unknown, samples: { clientX: number; clientY: number }[], route: "draw", event: PointerEvent): void;
      pointerEnd(surface: unknown, samples: { clientX: number; clientY: number }[], route: "draw", event: PointerEvent): void;
      history: { undo(): boolean; redo(): boolean };
    };

    internal.ink.add(stroke);
    internal.texts.add(text);
    internal.selectAllOnCurrentPage();
    const surface = internal.surfaces.get(1)!;
    expect(internal.tryStartSelectionMove(surface, sample(150, 150))).toBe(true);

    internal.pointerMove(surface, [sample(180, 180)], "draw", pointer("pointermove", 180, 180));
    internal.pointerEnd(surface, [sample(180, 180)], "draw", pointer("pointerup", 180, 180));

    expect(internal.ink.all()[0]?.points[0]).toMatchObject({ x: 130, y: 650 });
    expect(internal.texts.all()[0]).toMatchObject({ x: 250, y: 620 });
    expect(internal.history.undo()).toBe(true);
    expect(internal.ink.all()[0]?.points[0]).toMatchObject({ x: 100, y: 680 });
    expect(internal.texts.all()[0]).toMatchObject({ x: 220, y: 650 });

    await session.destroy();
  });

  it("moves selected text from the normal selection outline while the text tool is active", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
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
    const text: PdfTextAnnotation = {
      id: "move-in-text-mode", page: 1, text: "Move me", x: 220, y: 650, width: 140, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Move me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Move me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const sample = (clientX: number, clientY: number) => ({
      pointerId: 7, pointerType: "mouse" as const, clientX, clientY, pressure: 0.5, tiltX: 0, tiltY: 0,
      width: 1, height: 1, buttons: 1, timeStamp: 0
    });
    const internal = session as unknown as {
      texts: { add(value: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      selectAllOnCurrentPage(): void;
      pointerStart(surface: unknown, samples: ReturnType<typeof sample>[], route: "text", event: PointerEvent): void;
      pointerMove(surface: unknown, samples: ReturnType<typeof sample>[], route: "text", event: PointerEvent): void;
      pointerEnd(surface: unknown, samples: ReturnType<typeof sample>[], route: "text", event: PointerEvent): void;
    };
    internal.texts.add(text);
    internal.selectAllOnCurrentPage();
    const surface = internal.surfaces.get(1)!;
    internal.pointerStart(surface, [sample(250, 150)], "text", pointer("pointerdown", 250, 150));
    internal.pointerMove(surface, [sample(280, 180)], "text", pointer("pointermove", 280, 180));
    internal.pointerEnd(surface, [sample(280, 180)], "text", pointer("pointerup", 280, 180));

    expect(internal.texts.all()[0]).toMatchObject({ x: 250, y: 620 });
    await session.destroy();
  });

  it("clears selected text on the first empty click in text mode before creating a new box", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
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
    const text: PdfTextAnnotation = {
      id: "clear-on-click-away", page: 1, text: "Selected", x: 220, y: 650, width: 140, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Selected", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Selected", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const sample = (clientX: number, clientY: number) => ({
      pointerId: 7, pointerType: "mouse" as const, clientX, clientY, pressure: 0.5, tiltX: 0, tiltY: 0,
      width: 1, height: 1, buttons: 1, timeStamp: 0
    });
    const internal = session as unknown as {
      texts: { add(value: PdfTextAnnotation): void };
      surfaces: Map<number, unknown>;
      selectAllOnCurrentPage(): void;
      pointerStart(surface: unknown, samples: ReturnType<typeof sample>[], route: "text", event: PointerEvent): void;
      pointerEnd(surface: unknown, samples: ReturnType<typeof sample>[], route: "text", event: PointerEvent): void;
      selectedTexts: PdfTextAnnotation[];
      activeTextEditor: { element: HTMLElement } | null;
    };
    internal.texts.add(text);
    internal.selectAllOnCurrentPage();
    const surface = internal.surfaces.get(1)!;

    internal.pointerStart(surface, [sample(500, 500)], "text", pointer("pointerdown", 500, 500));
    internal.pointerEnd(surface, [sample(500, 500)], "text", pointer("pointerup", 500, 500));
    expect(internal.selectedTexts).toEqual([]);
    expect(internal.activeTextEditor).toBeNull();

    internal.pointerStart(surface, [sample(500, 500)], "text", pointer("pointerdown", 500, 500));
    internal.pointerEnd(surface, [sample(500, 500)], "text", pointer("pointerup", 500, 500));
    expect(internal.activeTextEditor).not.toBeNull();

    await session.destroy();
  });

  it("opens a selected text box for editing when its text is clicked", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
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
    const text: PdfTextAnnotation = {
      id: "click-selected-to-edit", page: 1, text: "Edit me", x: 220, y: 650, width: 140, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Edit me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Edit me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(value: PdfTextAnnotation): void };
      selectAllOnCurrentPage(): void;
      activeTextEditor: { draft: PdfTextAnnotation } | null;
      selectedTexts: PdfTextAnnotation[];
      selectionShape: unknown;
      selectionPage: number | null;
    };
    internal.texts.add(text);
    internal.selectAllOnCurrentPage();
    const box = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    expect(box).not.toBeNull();

    box!.dispatchEvent(pointer("pointerdown", 250, 150));
    box!.dispatchEvent(pointer("pointerup", 250, 150));
    expect(internal.activeTextEditor?.draft.id).toBe(text.id);
    expect(internal.selectedTexts).toEqual([]);
    expect(internal.selectionShape).toBeNull();
    expect(internal.selectionPage).toBeNull();

    await session.destroy();
  });

  it("persists only selected rich-text characters and renders their saved runs", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
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
    const existing: PdfTextAnnotation = {
      id: "rich", page: 1, text: "hello world", x: 100, y: 300, width: 180, height: 32,
      color: "#111827", fontSize: 18, fontFamily: "serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "hello world", color: "#111827", fontSize: 18, fontFamily: "serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "hello world", color: "#111827", fontSize: 18, fontFamily: "serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      openTextEditor(surface: unknown, text: PdfTextAnnotation): void;
      applyTextStyleToActiveEditor(change: TextStyleChange): void;
      commitActiveTextEditor(reason: string): void;
      activeTextEditor: { element: HTMLElement } | null;
    };
    internal.texts.add(existing);
    internal.openTextEditor(internal.surfaces.get(1), existing);
    const editor = internal.activeTextEditor!.element;
    const text = editor.querySelector("span")?.firstChild!;
    const range = editor.ownerDocument.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 11);
    const selection = editor.ownerDocument.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    internal.applyTextStyleToActiveEditor({ property: "color", value: "#dc2626", source: "input" });
    expect(editor.querySelectorAll(".native-pdf-handwriting-text-run")).toHaveLength(2);
    internal.commitActiveTextEditor("test-rich-runs");

    const saved = internal.texts.all()[0]!;
    expect(saved.runs).toEqual([
      { ...existing.runs[0]!, text: "hello " },
      { ...existing.runs[0]!, text: "world", color: "#dc2626" }
    ]);
    const staticRuns = adapter.pageElement.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-box .native-pdf-handwriting-text-run");
    expect(staticRuns).toHaveLength(2);
    expect(staticRuns[1]?.style.color).toBe("rgb(220, 38, 38)");

    internal.openTextEditor(internal.surfaces.get(1), saved);
    expect(internal.activeTextEditor!.element.querySelectorAll(".native-pdf-handwriting-text-run")).toHaveLength(2);
    await session.destroy();
  });

  it("uses NPDE-style text-box outlines, edge hit zones, and resize dots", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
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
    const annotation: PdfTextAnnotation = {
      id: "controls", page: 1, text: "Resize me", x: 100, y: 300, width: 140, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Resize me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Resize me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      renderTextAnnotations(surface: unknown): void;
      resizeTextAnnotation(annotation: PdfTextAnnotation, handle: "se", point: { x: number; y: number }): PdfTextAnnotation;
    };
    internal.texts.add(annotation);
    internal.renderTextAnnotations(internal.surfaces.get(1));

    const box = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    expect(box?.classList.contains("is-editable")).toBe(true);
    expect(box?.querySelector(".native-pdf-handwriting-text-selection-frame")).not.toBeNull();
    expect(box?.querySelectorAll("[data-handle]")).toHaveLength(12);
    expect(box?.querySelectorAll(".native-pdf-handwriting-text-resize-nw, .native-pdf-handwriting-text-resize-ne, .native-pdf-handwriting-text-resize-sw, .native-pdf-handwriting-text-resize-se")).toHaveLength(4);

    const preview = internal.resizeTextAnnotation(annotation, "se", { x: 320, y: 250 });
    expect(preview).toMatchObject({ x: 100, y: 300, width: 220, height: 50, text: "Resize me" });
    const handle = box?.querySelector<HTMLElement>(".native-pdf-handwriting-text-resize-se");
    const frame = box?.querySelector<HTMLElement>(".native-pdf-handwriting-text-selection-frame");
    handle?.dispatchEvent(pointer("pointerdown", 240, 528));
    internal.renderTextAnnotations(internal.surfaces.get(1));
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-selection-frame")).toBe(frame);
    document.dispatchEvent(pointer("pointermove", 320, 550));
    expect(frame?.style.width).toBe("226px");
    expect(internal.texts.all()[0]).toMatchObject({ width: 140, height: 28, text: "Resize me" });
    document.dispatchEvent(pointer("pointerup", 320, 550));
    expect(internal.texts.all()[0]).toMatchObject({ x: 100, y: 300, width: 220, height: 50, text: "Resize me" });

    const movedBox = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    movedBox?.querySelector<HTMLElement>(".native-pdf-handwriting-text-move-e")?.dispatchEvent(pointer("pointerdown", 320, 525));
    document.dispatchEvent(pointer("pointermove", 400, 575));
    expect(movedBox?.style.transform).toBe("translate(80px, 50px)");
    expect(internal.texts.all()[0]).toMatchObject({ x: 100, y: 300, width: 220, height: 50 });
    document.dispatchEvent(pointer("pointerup", 400, 575));
    expect(internal.texts.all()[0]).toMatchObject({ x: 180, y: 250, width: 220, height: 50, text: "Resize me" });
    await session.destroy();
  });

  it("paints stroke commits page-locally instead of full history refresh", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
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
    const internal = session as unknown as {
      refresh(reason: string): void;
      invalidateInkLayers(): void;
      ink: { all(): unknown[] };
    };
    const refresh = vi.spyOn(internal, "refresh");
    const invalidateAll = vi.spyOn(internal, "invalidateInkLayers");
    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    refresh.mockClear();
    invalidateAll.mockClear();

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 140));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 180, 200));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 220, 240));

    expect(internal.ink.all()).toHaveLength(1);
    expect(refresh).not.toHaveBeenCalledWith("history");
    expect(invalidateAll).not.toHaveBeenCalled();

    await session.destroy();
  });

  it("keeps committed ink layer pixels when switching to text after drawing", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    settings.toolPreferences.pen.color = "#dc2626";
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
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 140));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 180, 200));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 220, 240));

    const internal = session as unknown as {
      surfaces: Map<number, { inkLayerValid: boolean; builder?: unknown }>;
      ink: { all(): Array<{ color: string }> };
      invalidateInkLayers(): void;
    };
    const surface = internal.surfaces.get(1)!;
    expect(surface.builder).toBeUndefined();
    expect(internal.ink.all().at(-1)?.color).toBe("#dc2626");
    const layerValidBefore = surface.inkLayerValid;
    const invalidate = vi.spyOn(internal, "invalidateInkLayers");

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    expect(settings.toolPreferences.activeTool).toBe("text");
    // Tool-chrome refresh must not invalidate committed ink (zoom-blit snap).
    expect(invalidate).not.toHaveBeenCalled();
    expect(surface.inkLayerValid).toBe(layerValidBefore);
    expect(internal.ink.all().at(-1)?.color).toBe("#dc2626");

    await session.destroy();
  });

  it("makes text boxes interactable only in text or lasso mode while draw is on", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
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
    const annotation: PdfTextAnnotation = {
      id: "pass-through", page: 1, text: "Ink over me", x: 100, y: 300, width: 140, height: 28,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Ink over me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Ink over me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void };
      surfaces: Map<number, unknown>;
      renderTextAnnotations(surface: unknown): void;
      options: { settings: { toolPreferences: { activeTool: string } } };
      refreshToolChrome(reason?: string): void;
    };
    internal.texts.add(annotation);
    internal.renderTextAnnotations(internal.surfaces.get(1));

    let box = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    expect(box?.classList.contains("is-editable")).toBe(false);
    expect(box?.querySelector(".native-pdf-handwriting-text-selection-frame")).toBeNull();

    // Production tool/style prefs use chrome-only refresh (no ink invalidate).
    internal.options.settings.toolPreferences.activeTool = "lasso";
    internal.refreshToolChrome("tool-chrome");
    box = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    expect(box?.classList.contains("is-editable")).toBe(true);
    expect(box?.querySelector(".native-pdf-handwriting-text-selection-frame")).not.toBeNull();

    internal.options.settings.toolPreferences.activeTool = "text";
    internal.refreshToolChrome("tool-chrome");
    box = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    expect(box?.classList.contains("is-editable")).toBe(true);

    internal.options.settings.toolPreferences.activeTool = "eraser";
    internal.refreshToolChrome("tool-chrome");
    box = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-text-box");
    expect(box?.classList.contains("is-editable")).toBe(false);
    expect(box?.querySelector(".native-pdf-handwriting-text-selection-frame")).toBeNull();

    await session.destroy();
  });

  it("resizes a locked shape from a drawing tool when the pointer moves instead of reverting to raw ink", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
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

    const point = (x: number, y: number): PdfPoint => ({ x, y, pressure: 0.6, time: 0 });
    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    const surface = (session as unknown as {
      surfaces: Map<number, {
        shapeHoldTimer: number | null;
        shapePreview: PdfPoint[] | null;
        shapeResize: { recognition: { kind: "line"; points: PdfPoint[] }; anchor: PdfPoint; handle: PdfPoint } | null;
      }>;
    }).surfaces.get(1)!;
    expect(surface.shapeHoldTimer).not.toBeNull();
    surface.shapePreview = [point(100, 680), point(200, 680)];
    surface.shapeResize = {
      recognition: { kind: "line", points: [point(100, 680), point(200, 680)] },
      anchor: point(100, 680),
      handle: point(200, 680)
    };

    adapter.pageElement.dispatchEvent(pointer("pointermove", 260, 120));
    expect(surface.shapePreview).toEqual([
      expect.objectContaining({ x: 100, y: 680 }),
      expect.objectContaining({ x: 260, y: 680 })
    ]);
    adapter.pageElement.dispatchEvent(pointer("pointerup", 260, 120));
    const ink = (session as unknown as { ink: { all(): Array<{ points: PdfPoint[] }> } }).ink.all();
    expect(ink[0]?.points.at(-1)).toMatchObject({ x: 260, y: 680 });

    await session.destroy();
  });

  it("bounds a held laser draft so high-rate input cannot grow without limit", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    try {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "laser";
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
    for (let index = 0; index < 1_100; index += 1) {
      adapter.pageElement.dispatchEvent(pointer("pointermove", 100 + index, 120));
    }

    const surfaces = (session as unknown as {
      surfaces: Map<number, { builder?: { preview(simplify?: boolean): readonly unknown[] } }>;
    }).surfaces;
    expect(surfaces.get(1)?.builder?.preview(false)).toHaveLength(1_024);
    await session.destroy();
    } finally {
      debug.mockRestore();
    }
  }, 15_000);

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
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    expect(context.moveTo).toHaveBeenCalled();
    expect(context.lineTo).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
    const canvas = adapter.pageElement.querySelector<HTMLCanvasElement>(".native-pdf-handwriting-canvas");
    expect(canvas?.classList.contains("is-selection-chrome-raised")).toBe(true);
    await session.destroy();
  });

  it("keeps the shared lasso selection outline after selecting a text box", async () => {
    const context = {
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), rect: vi.fn(), ellipse: vi.fn()
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);

    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "lasso";
    settings.toolPreferences.lasso.type = "rectangle";
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
    const text: PdfTextAnnotation = {
      // PDF y grows upward; FakeAdapter maps clientY≈0 to pdfY≈800.
      id: "lasso-text", page: 1, text: "Select me", x: 120, y: 650, width: 160, height: 36,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Select me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Select me", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void };
      selectedTexts: PdfTextAnnotation[];
      selectionShape: unknown;
      renderPage(pageNumber: number): void;
    };
    internal.texts.add(text);
    internal.renderPage(1);

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    context.stroke.mockClear();
    context.rect.mockClear();
    context.setLineDash.mockClear();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 100));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 220, 240));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 220, 240));

    expect(internal.selectedTexts).toHaveLength(1);
    expect(internal.selectionShape).not.toBeNull();
    expect(context.setLineDash).toHaveBeenCalled();
    expect(context.rect).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
    const canvas = adapter.pageElement.querySelector<HTMLCanvasElement>(".native-pdf-handwriting-canvas");
    expect(canvas?.classList.contains("is-selection-chrome-raised")).toBe(true);
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-box.is-selected")).not.toBeNull();
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

    document.querySelector<HTMLButtonElement>(".native-pdf-handwriting-selection-toolbar button:last-of-type")?.click();
    expect(session.handleKeyDown(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }))).toBe(false);
    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    expect(session.handleKeyDown(paste)).toBe(false);
    expect(session.handleKeyDown(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true }))).toBe(false);

    await session.destroy();
  });

  it("selects all active text before native typing while leaving delete native", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "text";
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
    const text: PdfTextAnnotation = {
      id: "editor-shortcut", page: 1, text: "Select this text", x: 100, y: 300, width: 180, height: 32,
      color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false,
      runs: [{ text: "Select this text", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      sourceRuns: [{ text: "Select this text", color: "#111827", fontSize: 18, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }],
      createdAt: "now", updatedAt: "now"
    };
    const internal = session as unknown as {
      texts: { add(annotation: PdfTextAnnotation): void; all(): PdfTextAnnotation[] };
      surfaces: Map<number, unknown>;
      openTextEditor(surface: unknown, text: PdfTextAnnotation): void;
      commitActiveTextEditor(reason: string): void;
      activeTextEditor: { element: HTMLElement } | null;
      selectedTexts: PdfTextAnnotation[];
    };
    internal.texts.add(text);
    internal.openTextEditor(internal.surfaces.get(1), text);

    const editor = internal.activeTextEditor!.element;
    const selectAllInEditor = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true });
    const deleteInEditor = new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true });
    expect(editor.dispatchEvent(selectAllInEditor)).toBe(false);
    expect(selectAllInEditor.defaultPrevented).toBe(true);
    expect(editor.ownerDocument.getSelection()?.toString()).toBe("Select this text");
    expect(session.handleKeyDown(deleteInEditor)).toBe(false);
    expect(deleteInEditor.defaultPrevented).toBe(false);
    expect(internal.selectedTexts).toEqual([]);
    expect(internal.texts.all()).toHaveLength(1);

    // Browser editing replaces the native range selected above. Simulate that
    // native edit, then verify the runtime serializes the replacement only.
    const selection = editor.ownerDocument.getSelection()!;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const replacement = editor.ownerDocument.createTextNode("Replacement");
    range.insertNode(replacement);
    const caret = editor.ownerDocument.createRange();
    caret.setStartAfter(replacement);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    internal.commitActiveTextEditor("test-editor-shortcuts");
    expect(internal.texts.all()[0]?.text).toBe("Replacement");
    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    const selectAllAnnotations = new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true });
    expect(session.handleKeyDown(selectAllAnnotations)).toBe(true);
    expect(selectAllAnnotations.defaultPrevented).toBe(true);
    expect(internal.selectedTexts).toHaveLength(1);

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

  it("coalesces live stylus painting without dropping samples or letting a terminal frame go stale", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    frames.length = 0;
    requestFrame.mockClear();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 120, 140));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 140, 160));

    // One frame owns ink and one owns the independently batched cursor; raw
    // moves must not add more paint callbacks.
    expect(requestFrame).toHaveBeenCalledTimes(2);
    const queuedPaint = frames[0]!;
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    const surface = (session as unknown as {
      surfaces: Map<number, { livePaintFrame: number | null; pendingLivePaint: unknown }>;
    }).surfaces.get(1)!;
    expect(surface.livePaintFrame).toBeNull();
    expect(surface.pendingLivePaint).toBeNull();
    queuedPaint(0);
    expect(surface.pendingLivePaint).toBeNull();

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].strokes[0].points).toHaveLength(4);
    await session.destroy();
  });
});
