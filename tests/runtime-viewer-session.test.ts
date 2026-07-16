import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsidianPdfAdapter, PdfViewState } from "../src/integration/ObsidianPdfAdapter";
import type { PdfPageInfo } from "../src/integration/PdfPageLocator";
import { DEFAULT_SETTINGS, type PluginSettings } from "../src/model";
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
  scale = 1;
  readonly zoomBySteps = vi.fn(() => true);
  readonly zoomByScaleFactor = vi.fn((factor: number) => {
    this.scale *= factor;
    return true;
  });
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
  getViewState(): PdfViewState { return { pageNumber: 1, scrollFraction: 0, scale: this.scale, rotation: 0 }; }
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

function pointer(type: string, x: number, y: number, pointerType = "pen"): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
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

function setEditorText(input: HTMLDivElement, text: string): void {
  input.textContent = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function textEditorPosition(input: HTMLDivElement, offset: number): { node: Node; offset: number } {
  const walker = input.ownerDocument.createTreeWalker(input, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (remaining <= text.length) return { node: text, offset: remaining };
    remaining -= text.length;
    last = text;
  }
  if (last) return { node: last, offset: last.length };
  return { node: input, offset: input.childNodes.length };
}

function setEditorSelection(input: HTMLDivElement, start: number, end: number): void {
  const selection = input.ownerDocument.getSelection()!;
  const range = input.ownerDocument.createRange();
  const from = textEditorPosition(input, start);
  const to = textEditorPosition(input, end);
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  selection.removeAllRanges();
  selection.addRange(range);
  input.ownerDocument.dispatchEvent(new Event("selectionchange"));
}

function editorSelection(input: HTMLDivElement): [number, number] {
  const selection = input.ownerDocument.getSelection()!;
  const range = selection.getRangeAt(0);
  const offset = (node: Node, position: number): number => {
    const before = input.ownerDocument.createRange();
    before.selectNodeContents(input);
    before.setEnd(node, position);
    return before.toString().length;
  };
  return [offset(range.startContainer, range.startOffset), offset(range.endContainer, range.endOffset)];
}

describe("viewer runtime tracer", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(), clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), closePath: vi.fn(),
      lineTo: vi.fn(), stroke: vi.fn(), setLineDash: vi.fn(), rect: vi.fn(), ellipse: vi.fn(), fillText: vi.fn(),
      measureText: vi.fn(() => ({ width: 80 })), strokeRect: vi.fn(), drawImage: vi.fn()
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
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

    const pan = adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='pan']");
    expect(pan).not.toBeNull();
    expect(adapter.root.classList.contains("native-pdf-handwriting-hide-native-cursor")).toBe(true);
    expect(adapter.root.classList.contains("native-pdf-handwriting-draw-active")).toBe(true);
    expect(adapter.pageElement.classList.contains("native-pdf-handwriting-draw-active")).toBe(true);
    const inkCanvas = adapter.pageElement.querySelector<HTMLCanvasElement>(".native-pdf-handwriting-canvas");
    expect(inkCanvas?.getAttribute("aria-label")).toBe("Annotations for PDF page 1");
    session.setStylusAnnotationLabelHidden(true);
    expect(inkCanvas?.hasAttribute("aria-label")).toBe(false);
    session.setStylusAnnotationLabelHidden(false);
    expect(inkCanvas?.getAttribute("aria-label")).toBe("Annotations for PDF page 1");

    pan?.click();
    expect(adapter.root.classList.contains("native-pdf-handwriting-draw-active")).toBe(false);
    expect(adapter.pageElement.classList.contains("native-pdf-handwriting-draw-active")).toBe(false);
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();

    const quickAction = vi.fn();
    document.addEventListener("pointerdown", quickAction, { capture: true });
    inkCanvas?.dispatchEvent(pointer("pointerdown", 100, 120));
    inkCanvas?.dispatchEvent(pointer("pointermove", 130, 150));
    inkCanvas?.dispatchEvent(pointer("pointerup", 160, 180));
    document.removeEventListener("pointerdown", quickAction, { capture: true });
    expect(quickAction).not.toHaveBeenCalled();
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

  it("uses replacement touch navigation settings without reopening the PDF", async () => {
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const settings = structuredClone(DEFAULT_SETTINGS);
    let navigationSettings: Pick<PluginSettings, "singleTouchMode" | "twoFingerPinchZoom" | "twoFingerSwipeScroll"> = {
      ...settings,
      singleTouchMode: "none"
    };
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/live-touch-settings.pdf",
      settings,
      touchNavigationSettings: () => navigationSettings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, "touch"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 140, 160, "touch"));
    await session.manualSave();
    const sidecarPath = [...files.values.keys()].find((path) => path.startsWith("annotations/"))!;
    expect(JSON.parse(files.values.get(sidecarPath)!).pages[0]?.strokes ?? []).toHaveLength(0);

    navigationSettings = { ...navigationSettings, singleTouchMode: "stylus" };
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120, "touch"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 140, 160, "touch"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180, "touch"));
    await session.manualSave();
    expect(JSON.parse(files.values.get(sidecarPath)!).pages[0].strokes).toHaveLength(1);

    await session.destroy();
  });

  it("opens and saves text input from a Windows mouse click", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input");
    expect(input).not.toBeNull();
    setEditorText(input!, "Windows text");
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).toBeNull();
    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts).toMatchObject([{ text: "Windows text", x: 120, y: 640 }]);
    await session.destroy();
  });

  it("keeps Korean IME composition intact until it is committed", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-korean-ime.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;

    input.textContent = "ㅎ";
    const composingNode = input.firstChild;
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ㅎ" }));
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "ㅎ" }));
    expect(input.firstChild).toBe(composingNode);

    const candidateEnter = new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true, isComposing: true
    });
    input.dispatchEvent(candidateEnter);
    expect(candidateEnter.defaultPrevented).toBe(false);

    input.textContent = "하";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertCompositionText", data: "하" }));
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "하" }));
    await Promise.resolve();
    expect(input.textContent).toBe("하");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts).toMatchObject([{ text: "하" }]);
    await session.destroy();
  });

  it("does not save an editor containing only Markdown emphasis delimiters", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-empty-markdown.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(input, "******");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0]?.texts ?? []).toEqual([]);
    await session.destroy();
  });

  it("commits the active text editor when Text clicks blank page space", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-blank-click-save.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(input, "Save on blank click");

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 360, 300, "mouse"));

    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).toBeNull();
    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts).toMatchObject([{ text: "Save on blank click" }]);
    await session.destroy();
  });

  it("asks again after Keep editing and remembers Discard selected with Escape", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const savePluginSettings = vi.fn(async () => undefined);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-cancel.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      savePluginSettings,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(input, "Discard me");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).not.toBeNull();
    const dialog = document.querySelector<HTMLElement>(".native-pdf-handwriting-text-cancel-dialog");
    expect(dialog?.textContent).toContain("Save text changes?");
    const remember = dialog?.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    expect(remember).not.toBeNull();
    remember.checked = true;
    dialog?.querySelector<HTMLButtonElement>("[data-action='keep-editing']")?.click();
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).not.toBeNull();
    expect(savePluginSettings).not.toHaveBeenCalled();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const discardDialog = document.querySelector<HTMLElement>(".native-pdf-handwriting-text-cancel-dialog");
    const discardRemember = discardDialog?.querySelector<HTMLInputElement>("input[type='checkbox']")!;
    discardRemember.checked = true;
    discardDialog?.querySelector<HTMLButtonElement>("[data-action='discard']")?.click();
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).toBeNull();
    expect(savePluginSettings).toHaveBeenCalledWith({ skipTextCancelConfirmation: true, textEscapeAction: "discard" });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 220, 260, "mouse"));
    const secondInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(secondInput, "Discard immediately");
    secondInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).toBeNull();
    expect(document.querySelector(".native-pdf-handwriting-text-cancel-dialog")).toBeNull();
    await session.destroy();
  });

  it("remembers Save selected with Escape", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const savePluginSettings = vi.fn(async () => undefined);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-escape-save.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      savePluginSettings,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(input, "Save me");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const dialog = document.querySelector<HTMLElement>(".native-pdf-handwriting-text-cancel-dialog")!;
    dialog.querySelector<HTMLInputElement>("input[type='checkbox']")!.checked = true;
    dialog.querySelector<HTMLButtonElement>("[data-action='save']")?.click();
    expect(savePluginSettings).toHaveBeenCalledWith({ skipTextCancelConfirmation: true, textEscapeAction: "save" });
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).toBeNull();

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 220, 260, "mouse"));
    const secondInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(secondInput, "Save immediately");
    secondInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).toBeNull();
    expect(document.querySelector(".native-pdf-handwriting-text-cancel-dialog")).toBeNull();
    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts).toMatchObject([{ text: "Save me" }, { text: "Save immediately" }]);
    await session.destroy();
  });

  it("formats selected text characters through Text and color controls", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-format.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const textButton = adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']");
    textButton?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(input, "Format me");
    setEditorSelection(input, 0, 6);
    textButton?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    expect(input.textContent).toBe("**Format** me");
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    expect(input.textContent).toBe("Format me");
    expect(editorSelection(input)).toEqual([0, 6]);
    document.querySelector<HTMLButtonElement>("[data-option-id='text-italic']")?.click();
    expect(input.textContent).toBe("*Format* me");
    document.querySelector<HTMLButtonElement>("[data-option-id='text-italic']")?.click();
    expect(input.textContent).toBe("Format me");
    expect(editorSelection(input)).toEqual([0, 6]);
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    expect(input.textContent).toBe("**Format** me");
    document.querySelector<HTMLButtonElement>("[data-option-id='text-size-increase']")?.click();
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='color']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='#dc2626']")?.click();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts[0].runs).toMatchObject([
      { text: "Format", color: "#dc2626", fontSize: 17, bold: true },
      { text: " me", bold: false }
    ]);
    await session.destroy();
  });

  it("persists selected-character formatting while editing text through the lasso", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-lasso-format.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const addInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(addInput, "Format me");
    addInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='lasso']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorSelection(input, 0, 6);

    const textButton = adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")!;
    textButton.dispatchEvent(pointer("pointerdown", 0, 0, "mouse"));
    textButton.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-size-increase']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-italic']")?.click();
    const colorButton = adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='color']")!;
    colorButton.dispatchEvent(pointer("pointerdown", 0, 0, "mouse"));
    colorButton.click();
    expect(document.activeElement).toBe(input);
    document.querySelector<HTMLButtonElement>("[data-option-id='#dc2626']")?.click();
    expect(editorSelection(input)).toEqual([3, 9]);
    expect(Array.from(input.children).map((element) => ({
      text: element.textContent,
      color: (element as HTMLElement).style.color,
      fontSize: (element as HTMLElement).style.fontSize,
      fontWeight: (element as HTMLElement).style.fontWeight,
      fontStyle: (element as HTMLElement).style.fontStyle
    }))).toEqual([
      { text: "***", color: "rgb(17, 24, 39)", fontSize: "17px", fontWeight: "400", fontStyle: "normal" },
      { text: "Format", color: "rgb(220, 38, 38)", fontSize: "17px", fontWeight: "700", fontStyle: "italic" },
      { text: "***", color: "rgb(17, 24, 39)", fontSize: "17px", fontWeight: "400", fontStyle: "normal" },
      { text: " me", color: "rgb(17, 24, 39)", fontSize: "16px", fontWeight: "400", fontStyle: "normal" }
    ]);
    const context = adapter.pageElement.querySelector<HTMLCanvasElement>(".native-pdf-handwriting-canvas")?.getContext("2d") as unknown as {
      fillText: (text: string, x: number, y: number) => void;
      fillStyle: string;
      font: string;
    };
    const painted: Array<{ text: string; color: string; font: string }> = [];
    context.fillText = (text) => painted.push({ text, color: context.fillStyle, font: context.font });
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(painted).toContainEqual({ text: "Format", color: "#dc2626", font: "italic 700 17px sans-serif" });

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts[0].runs).toMatchObject([
      { text: "Format", color: "#dc2626", fontSize: 17, bold: true, italic: true },
      { text: " me", color: "#111827", fontSize: 16, bold: false, italic: false }
    ]);
    await session.destroy();
  });

  it("formats a new blank editor instead of a prior lasso-selected annotation", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-new-editor-format.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const textButton = adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")!;
    textButton.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const initialInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(initialInput, "Prior text");
    initialInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='lasso']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 120, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 250, 120, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 250, 220, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 80, 220, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 80, 120, "mouse"));

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 360, 300, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 360, 300, "mouse"));
    textButton.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 360, 300, "mouse"));
    const newInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    textButton.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-size-increase']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    expect(newInput.style.fontSize).toBe("17px");
    expect(newInput.textContent).toBe("****");
    newInput.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertText", data: "New text", bubbles: true, cancelable: true
    }));
    newInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts).toMatchObject([
      { text: "Prior text", runs: [{ text: "Prior text", fontSize: 16, bold: false }] },
      { text: "New text", runs: [{ text: "New text", fontSize: 17, bold: true }] }
    ]);
    await session.destroy();
  });

  it("keeps prior lasso-selected text unchanged when toggling blank-editor bold and italic", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-blank-emphasis.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const textButton = adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")!;
    textButton.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const priorInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(priorInput, "Prior text");
    priorInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='lasso']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 120, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 250, 120, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 250, 220, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 80, 220, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 80, 120, "mouse"));

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 360, 300, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 360, 300, "mouse"));
    textButton.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 360, 300, "mouse"));
    const blankInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    textButton.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-italic']")?.click();
    expect(blankInput.textContent).toBe("******");
    blankInput.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertText", data: "New text", bubbles: true, cancelable: true
    }));
    blankInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts).toMatchObject([
      { text: "Prior text", runs: [{ text: "Prior text", bold: false, italic: false }] },
      { text: "New text", runs: [{ text: "New text", bold: true, italic: true }] }
    ]);
    await session.destroy();
  });

  it("formats selected text annotations without opening an editor", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-menu-default-style.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const textButton = adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")!;
    textButton.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(input, "Unchanged text");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='lasso']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 120, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 250, 120, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 250, 220, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 80, 220, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 80, 120, "mouse"));

    textButton.click();
    expect(document.querySelector(".native-pdf-handwriting-text-menu")).not.toBeNull();
    expect(document.querySelector<HTMLElement>(".native-pdf-handwriting-selection-toolbar")?.hidden).toBe(false);
    const font = document.querySelector<HTMLSelectElement>(".native-pdf-handwriting-text-menu select")!;
    font.value = "serif";
    font.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector<HTMLButtonElement>("[data-option-id='text-size-increase']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-italic']")?.click();
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='color']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='#dc2626']")?.click();

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts).toMatchObject([
      {
        text: "Unchanged text",
        runs: [{ text: "Unchanged text", color: "#dc2626", fontFamily: "serif", fontSize: 17, bold: true, italic: true }]
      }
    ]);
    await session.destroy();
  });

  it("inserts caret Markdown delimiters and applies collapsed size and color to later input", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-caret-formatting.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const textButton = adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")!;
    textButton.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(input, "LeftRight");
    setEditorSelection(input, 4, 4);
    textButton.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    expect(input.textContent).toBe("Left****Right");
    expect(editorSelection(input)).toEqual([6, 6]);
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    expect(input.textContent).toBe("LeftRight");
    expect(editorSelection(input)).toEqual([4, 4]);
    document.querySelector<HTMLButtonElement>("[data-option-id='text-italic']")?.click();
    expect(input.textContent).toBe("Left**Right");
    expect(editorSelection(input)).toEqual([5, 5]);
    document.querySelector<HTMLButtonElement>("[data-option-id='text-italic']")?.click();
    expect(input.textContent).toBe("LeftRight");
    expect(editorSelection(input)).toEqual([4, 4]);
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-italic']")?.click();
    expect(input.textContent).toBe("Left******Right");
    expect(editorSelection(input)).toEqual([7, 7]);
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    expect(input.textContent).toBe("Left**Right");
    expect(editorSelection(input)).toEqual([5, 5]);
    document.querySelector<HTMLButtonElement>("[data-option-id='text-italic']")?.click();
    expect(input.textContent).toBe("LeftRight");
    expect(editorSelection(input)).toEqual([4, 4]);
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-italic']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-size-increase']")?.click();
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='color']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='#dc2626']")?.click();
    input.dispatchEvent(new InputEvent("beforeinput", {
      inputType: "insertText", data: "X", bubbles: true, cancelable: true
    }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts[0].runs).toMatchObject([
      { text: "Left", color: "#111827", fontSize: 16, bold: false, italic: false },
      { text: "X", color: "#dc2626", fontSize: 17, bold: true, italic: true },
      { text: "Right", color: "#111827", fontSize: 16, bold: false, italic: false }
    ]);
    await session.destroy();
  });

  it("starts new formatted editors between their Markdown delimiters", async () => {
    const cases = [
      { bold: true, italic: false, marker: "**" },
      { bold: false, italic: true, marker: "*" },
      { bold: true, italic: true, marker: "***" }
    ];
    for (const testCase of cases) {
      const files = new MemoryFiles();
      const adapter = new FakeAdapter();
      const source = await PDFDocument.create();
      source.addPage([600, 800]);
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.toolPreferences.text.bold = testCase.bold;
      settings.toolPreferences.text.italic = testCase.italic;
      const session = await ViewerInkSession.create({
        adapter,
        pdfPath: `Notes/text-initial-${testCase.marker.length}.pdf`,
        settings,
        sidecars: new SidecarRepository(files, "annotations"),
        recovery: new RecoveryRepository(files, "recovery"),
        saveSettings: async () => undefined,
        readSourcePdf: async () => source.save(),
        writeExport: async () => undefined,
        notice: () => undefined
      });
      adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
      adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
      const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
      expect(input.textContent).toBe(testCase.marker.repeat(2));
      expect(editorSelection(input)).toEqual([testCase.marker.length, testCase.marker.length]);

      setEditorText(input, `${testCase.marker}Formatted${testCase.marker}`);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
      await session.manualSave();
      const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
      expect(JSON.parse(sidecar![1]).pages[0].texts[0].runs).toMatchObject([
        { text: "Formatted", bold: testCase.bold, italic: testCase.italic }
      ]);
      await session.destroy();
    }
  });

  it("previews and stores Markdown emphasis plus headings as formatted text runs", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-markdown.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(input, "**Bold** _italic_\n# Heading");
    const preview = Array.from(input.children).map((element) => ({
      text: element.textContent,
      fontWeight: (element as HTMLElement).style.fontWeight,
      fontStyle: (element as HTMLElement).style.fontStyle,
      fontSize: (element as HTMLElement).style.fontSize
    }));
    expect(preview).toContainEqual({ text: "italic", fontWeight: "400", fontStyle: "italic", fontSize: "16px" });
    expect(preview).toContainEqual({ text: "Heading", fontWeight: "700", fontStyle: "normal", fontSize: "27.2px" });
    expect(input.textContent).toBe("**Bold** _italic_\n# Heading");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts[0]).toMatchObject({
      text: "Bold italic\nHeading",
      runs: [
        { text: "Bold", bold: true, italic: false },
        { text: " ", bold: false, italic: false },
        { text: "italic", bold: false, italic: true },
        { text: "\n", bold: false, italic: false },
        { text: "Heading", fontSize: 27.2, bold: true, italic: false }
      ]
    });
    const headingSource = JSON.parse(sidecar![1]).pages[0].texts[0].sourceRuns;
    expect(headingSource.map((run: { text: string }) => run.text).join("")).toBe("**Bold** _italic_\n# Heading");
    expect(headingSource).toEqual([
      expect.objectContaining({ fontSize: 16, bold: false, italic: false })
    ]);
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='lasso']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    const reopened = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    expect(reopened.textContent).toBe("**Bold** _italic_\n# Heading");
    expect(Array.from(reopened.children).map((element) => ({
      text: element.textContent,
      fontSize: (element as HTMLElement).style.fontSize
    }))).toContainEqual({ text: "Heading", fontSize: "27.2px" });
    reopened.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    await session.manualSave();
    const savedAgain = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0].texts[0];
    expect(savedAgain.sourceRuns.map((run: { text: string }) => run.text).join("")).toBe("**Bold** _italic_\n# Heading");
    expect(savedAgain.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "Heading", fontSize: 27.2, bold: true, italic: false })
    ]));
    await session.destroy();
  });

  it("preserves Markdown source when reopening formatted text and renders strike", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-markdown-source.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(input, "***Both*** ~~crossed~~ plain");
    const preview = Array.from(input.children).map((element) => ({
      text: element.textContent,
      fontWeight: (element as HTMLElement).style.fontWeight,
      fontStyle: (element as HTMLElement).style.fontStyle,
      textDecorationLine: (element as HTMLElement).style.textDecorationLine,
      backgroundColor: (element as HTMLElement).style.backgroundColor
    }));
    expect(preview).toContainEqual({
      text: "Both", fontWeight: "700", fontStyle: "italic", textDecorationLine: "none", backgroundColor: ""
    });
    expect(preview).toContainEqual({
      text: "crossed", fontWeight: "400", fontStyle: "normal", textDecorationLine: "line-through", backgroundColor: ""
    });
    expect(preview).toContainEqual({
      text: "~~ plain", fontWeight: "400", fontStyle: "normal", textDecorationLine: "none", backgroundColor: ""
    });
    const context = adapter.pageElement.querySelector<HTMLCanvasElement>(".native-pdf-handwriting-canvas")?.getContext("2d") as unknown as {
      fillStyle: string;
      fillRect: (x: number, y: number, width: number, height: number) => void;
    };
    const rectangles: string[] = [];
    context.fillRect = () => rectangles.push(context.fillStyle);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(rectangles).toContain("#111827");

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    const saved = JSON.parse(sidecar![1]).pages[0].texts[0];
    expect(saved).toMatchObject({
      text: "Both crossed plain",
      sourceRuns: [{ text: "***Both*** ~~crossed~~ plain" }]
    });
    expect(saved.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "Both", bold: true, italic: true, strikethrough: false }),
      expect.objectContaining({ text: "crossed", bold: false, italic: false, strikethrough: true }),
      expect.objectContaining({ text: " plain", bold: false, italic: false, strikethrough: false })
    ]));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='lasso']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    const reopened = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    expect(reopened.textContent).toBe("***Both*** ~~crossed~~ plain");
    setEditorSelection(reopened, 0, 7);
    setEditorSelection(reopened, 7, 7);
    reopened.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    await session.manualSave();
    const savedAgain = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]);
    expect(savedAgain.pages[0].texts[0].runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "Both", bold: true, italic: true, strikethrough: false }),
      expect.objectContaining({ text: "crossed", strikethrough: true }),
      expect.objectContaining({ text: " plain", strikethrough: false })
    ]));
    await session.destroy();
  });

  it("parses Markdown emphasis while editing existing text through the lasso", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-lasso-markdown.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const addInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(addInput, "Original");
    addInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='lasso']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(input, "**Bold** *italic* ***both***");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts[0]).toMatchObject({
      text: "Bold italic both",
      runs: [
        { text: "Bold", bold: true, italic: false },
        { text: " ", bold: false, italic: false },
        { text: "italic", bold: false, italic: true },
        { text: " ", bold: false, italic: false },
        { text: "both", bold: true, italic: true }
      ]
    });
    await session.destroy();
  });

  it("shows lasso text actions and moves the editor by dragging its border", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-lasso-move.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const addInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(addInput, "Move me");
    addInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='lasso']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    Object.defineProperty(input, "getBoundingClientRect", {
      value: () => ({ left: 120, top: 160, right: 260, bottom: 200, width: 140, height: 40, x: 120, y: 160, toJSON: () => ({}) })
    });
    const actions = document.querySelector<HTMLElement>(".native-pdf-handwriting-selection-toolbar")!;
    expect(actions.hidden).toBe(false);
    expect(actions.textContent).toContain("Delete");
    expect(actions.textContent).toContain("Duplicate");
    expect(actions.textContent).toContain("Done");

    input.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    input.dispatchEvent(pointer("pointermove", 150, 190, "mouse"));
    input.dispatchEvent(pointer("pointerup", 150, 190, "mouse"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts).toMatchObject([{ text: "Move me", x: 150, y: 610 }]);
    await session.destroy();
  });

  it("clears lasso text selection with one blank-page click", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-lasso-clear.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const addInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(addInput, "Clear me");
    addInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='lasso']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    const actions = document.querySelector<HTMLElement>(".native-pdf-handwriting-selection-toolbar")!;
    expect(actions.hidden).toBe(false);

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 360, 300, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 360, 300, "mouse"));
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).toBeNull();
    expect(actions.hidden).toBe(true);
    await session.destroy();
  });

  it("selects text on first lasso click, edits it on second click, and deletes it", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const source = await PDFDocument.create();
    source.addPage([600, 800]);
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/text-lasso.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => source.save(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const addInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input");
    setEditorText(addInput!, "Editable text");
    addInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='lasso']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).toBeNull();
    expect(document.querySelector<HTMLElement>(".native-pdf-handwriting-selection-toolbar")?.hidden).toBe(false);
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    const editInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input");
    expect(editInput?.textContent).toBe("Editable text");
    setEditorSelection(editInput!, 0, 8);
    const textButton = adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']");
    textButton?.dispatchEvent(pointer("pointerdown", 0, 0, "mouse"));
    textButton?.focus();
    editInput!.dispatchEvent(new FocusEvent("blur"));
    await Promise.resolve();
    expect(editInput?.isConnected).toBe(true);
    expect(editorSelection(editInput!)).toEqual([0, 8]);
    textButton?.click();
    expect(document.querySelector(".native-pdf-handwriting-text-menu")).not.toBeNull();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    expect(editInput?.isConnected).toBe(true);
    const colorButton = adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='color']");
    colorButton?.dispatchEvent(pointer("pointerdown", 0, 0, "mouse"));
    colorButton?.focus();
    editInput!.dispatchEvent(new FocusEvent("blur"));
    await Promise.resolve();
    expect(editInput?.isConnected).toBe(true);
    colorButton?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='#dc2626']")?.click();
    await Promise.resolve();
    expect(editInput?.isConnected).toBe(true);
    expect(editorSelection(editInput!)).toEqual([2, 10]);
    setEditorText(editInput!, "Cancelled text");
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 400, 400, "mouse"));
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).toBeNull();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 125, 165, "mouse"));
    const reopenedInput = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input");
    expect(reopenedInput?.textContent).toBe("Cancelled text");
    setEditorText(reopenedInput!, "Edited text");
    reopenedInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 120, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 250, 120, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 250, 220, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 80, 220, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 80, 120, "mouse"));
    const selection = document.querySelector<HTMLElement>(".native-pdf-handwriting-selection-toolbar");
    expect(selection?.textContent).toContain("1 selected");
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='color']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='#dc2626']")?.click();
    expect(selection?.textContent).toContain("1 selected");
    selection?.querySelector<HTMLButtonElement>("button")?.click();
    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].texts).toEqual([]);
    await session.destroy();
  });

  it("zooms the PDF from a two-finger pinch while Draw is on", async () => {
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/example.pdf",
      settings: structuredClone(DEFAULT_SETTINGS),
      sidecars: new SidecarRepository(new MemoryFiles(), "annotations"),
      recovery: new RecoveryRepository(new MemoryFiles(), "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });
    const canvas = adapter.pageElement.querySelector<HTMLCanvasElement>(".native-pdf-handwriting-canvas");
    const touch = (type: string, distance: number): TouchEvent => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
      const touches = [{ identifier: 1, clientX: 0, clientY: 0 }, { identifier: 2, clientX: distance, clientY: 0 }];
      Object.defineProperties(event, {
        touches: { value: touches },
        changedTouches: { value: touches }
      });
      return event;
    };

    canvas?.dispatchEvent(touch("touchstart", 100));
    canvas?.dispatchEvent(touch("touchmove", 120));
    canvas?.dispatchEvent(touch("touchmove", 90));

    expect(adapter.zoomByScaleFactor).toHaveBeenNthCalledWith(1, 1.2, [60, 0]);
    expect(adapter.zoomByScaleFactor).toHaveBeenNthCalledWith(2, 0.75, [45, 0]);
    await session.destroy();
  });

  it("routes one touch to Pen and Text when stylus touch mode is enabled", async () => {
    const files = new MemoryFiles();
    const adapter = new FakeAdapter();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.singleTouchMode = "stylus";
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
    const canvas = adapter.pageElement.querySelector<HTMLCanvasElement>(".native-pdf-handwriting-canvas")!;

    canvas.dispatchEvent(pointer("pointerdown", 100, 120, "touch"));
    canvas.dispatchEvent(pointer("pointermove", 130, 150, "touch"));
    canvas.dispatchEvent(pointer("pointerup", 130, 150, "touch"));
    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].strokes).toHaveLength(1);

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    canvas.dispatchEvent(pointer("pointerdown", 180, 220, "touch"));
    expect(adapter.pageElement.querySelector(".native-pdf-handwriting-text-input")).not.toBeNull();
    await session.destroy();
  });

  it("stores highlighter strokes with independent default settings", async () => {
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
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='highlighter']")?.click();
    const canvas = adapter.pageElement.querySelector<HTMLCanvasElement>(".native-pdf-handwriting-canvas");
    canvas?.dispatchEvent(pointer("pointerdown", 100, 120));
    canvas?.dispatchEvent(pointer("pointermove", 130, 150));
    canvas?.dispatchEvent(pointer("pointerup", 160, 180));
    await session.manualSave();

    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].strokes[0]).toMatchObject({
      tool: "highlighter",
      color: "#facc15",
      width: 4.5,
      opacity: 0.3
    });
    await session.destroy();
  });

  it("straightens a stroke after a one-second hold despite jitter and adjusts its angle immediately", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.holdToStraighten = true;
    const files = new MemoryFiles();
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
    const canvas = adapter.pageElement.querySelector<HTMLCanvasElement>(".native-pdf-handwriting-canvas");
    vi.useFakeTimers();
    canvas?.dispatchEvent(pointer("pointerdown", 100, 120));
    canvas?.dispatchEvent(pointer("pointermove", 180, 220));
    await vi.advanceTimersByTimeAsync(500);
    canvas?.dispatchEvent(pointer("pointermove", 182, 218));
    await vi.advanceTimersByTimeAsync(500);
    canvas?.dispatchEvent(pointer("pointermove", 220, 180));
    canvas?.dispatchEvent(pointer("pointerup", 220, 180));
    await session.manualSave();

    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    const points = JSON.parse(sidecar![1]).pages[0].strokes[0].points;
    expect(points).toHaveLength(2);
    expect(points).toEqual([
      expect.objectContaining({ x: 100, y: 680 }),
      expect.objectContaining({ x: 220, y: 620 })
    ]);
    await session.destroy();
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

  it("moves selected text and ink together when dragging inside the text", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/mixed-selection-move.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='text']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 120, 160, "mouse"));
    const input = adapter.pageElement.querySelector<HTMLDivElement>(".native-pdf-handwriting-text-input")!;
    setEditorText(input, "Move both");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='lasso']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 100));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 260, 100));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 260, 220));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 80, 220));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 80, 100));
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 125, 165, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 225, 265, "mouse"));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 225, 265, "mouse"));

    await session.manualSave();
    const sidecar = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]).pages[0];
    expect(sidecar.strokes[0].points[0]).toMatchObject({ x: 200, y: 580 });
    expect(sidecar.texts[0]).toMatchObject({ text: "Move both", x: 220, y: 540 });
    expect(document.querySelector<HTMLElement>(".native-pdf-handwriting-selection-toolbar")?.hidden).toBe(false);
    await session.destroy();
  });

  it("updates selected ink color and width without clearing its selection", async () => {
    const files = new MemoryFiles();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.toolPreferences.activeTool = "pen";
    const adapter = new FakeAdapter();
    const session = await ViewerInkSession.create({
      adapter,
      pdfPath: "Notes/selected-ink-style.pdf",
      settings,
      sidecars: new SidecarRepository(files, "annotations"),
      recovery: new RecoveryRepository(files, "recovery"),
      saveSettings: async () => undefined,
      readSourcePdf: async () => new Uint8Array(),
      writeExport: async () => undefined,
      notice: () => undefined
    });

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    settings.toolPreferences.activeTool = "lasso";
    settings.toolPreferences.lasso.type = "rectangle";
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 100));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 180, 220));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 180, 220));

    const selection = document.querySelector<HTMLElement>(".native-pdf-handwriting-selection-toolbar")!;
    expect(selection.hidden).toBe(false);
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='color']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='#dc2626']")?.click();
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='width-4.5']")?.click();

    expect(selection.hidden).toBe(false);
    await session.manualSave();
    const sidecar = [...files.values.entries()].find(([path]) => path.startsWith("annotations/"));
    expect(JSON.parse(sidecar![1]).pages[0].strokes).toMatchObject([{ color: "#dc2626", width: 4.5 }]);
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
    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='pan']")?.click();
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

    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    settings.toolPreferences.activeTool = "lasso";
    settings.toolPreferences.lasso.type = "rectangle";
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 100));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 180, 220));

    adapter.toolbarHost.querySelector<HTMLButtonElement>("[data-control='pan']")?.click();
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
