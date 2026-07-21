/*
 * Browser entry for scripts/code-analysis/run-hn-pdfjs-zoom-emulator.mjs.
 * It is a local performance emulator, not an Obsidian API replacement.
 */
import { PDFDocument } from "pdf-lib";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/build/pdf.mjs";
import { DEFAULT_SETTINGS } from "../src/model";
import type { ObsidianPdfAdapter, PdfViewState } from "../src/integration/ObsidianPdfAdapter";
import type { PdfPageInfo } from "../src/integration/PdfPageLocator";
import { ViewerInkSession } from "../src/runtime/ViewerInkSession";
import { RecoveryRepository } from "../src/storage/RecoveryRepository";
import { SidecarRepository, type TextFileAdapter } from "../src/storage/SidecarRepository";

type PdfJsPage = Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>>["promise"]["getPage"]>>;

type PageSurface = {
  pageNumber: number;
  pdfPage: PdfJsPage;
  element: HTMLElement;
  canvasWrapper: HTMLElement;
  canvas: HTMLCanvasElement;
  textLayer: HTMLElement;
  width: number;
  height: number;
};

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

function durationSummary(entries: { duration: number }[]): { count: number; p95: number; max: number } {
  const values = entries.map((entry) => entry.duration);
  return { count: values.length, p95: percentile(values, 0.95), max: Math.max(0, ...values) };
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function tripleFixture(source: Uint8Array): Promise<Uint8Array> {
  const input = await PDFDocument.load(source);
  const output = await PDFDocument.create();
  const [firstPage] = await output.copyPages(input, [0]);
  for (let index = 0; index < 3; index += 1) output.addPage(firstPage);
  return output.save();
}

class MemoryFiles implements TextFileAdapter {
  private readonly values = new Map<string, string>();
  async exists(path: string): Promise<boolean> { return this.values.has(path); }
  async read(path: string): Promise<string> {
    const value = this.values.get(path);
    if (value === undefined) throw new Error(`Missing ${path}`);
    return value;
  }
  async write(path: string, contents: string): Promise<void> { this.values.set(path, contents); }
  async remove(path: string): Promise<void> { this.values.delete(path); }
}

/** A PDF.js-backed approximation of the DOM seam HN gets from Obsidian. */
class PdfjsAdapter implements ObsidianPdfAdapter {
  readonly kind = "direct" as const;
  readonly host = document.createElement("div");
  readonly root = document.createElement("div");
  readonly toolbarHost = document.createElement("div");
  private readonly pagesByNumber: PageSurface[] = [];
  private scale = 1;
  private rotation = 0;

  constructor(private readonly pdfDocument: Awaited<ReturnType<typeof getDocument>>["promise"] extends Promise<infer T> ? T : never) {
    this.host.className = "hn-pdfjs-emulator-host";
    this.root.className = "pdfViewer";
    this.root.style.cssText = "position:relative; overflow:auto; box-sizing:border-box; width:1380px; height:900px; padding:24px; background:#20242b;";
    this.toolbarHost.style.cssText = "position:sticky; top:0; z-index:10;";
    this.root.append(this.toolbarHost);
    this.host.append(this.root);
    document.body.append(this.host);
  }

  async initialize(): Promise<void> {
    for (let pageNumber = 1; pageNumber <= this.pdfDocument.numPages; pageNumber += 1) {
      const pdfPage = await this.pdfDocument.getPage(pageNumber);
      const element = document.createElement("div");
      const canvasWrapper = document.createElement("div");
      const canvas = document.createElement("canvas");
      const textLayer = document.createElement("div");
      element.className = "page";
      element.dataset.pageNumber = String(pageNumber);
      canvasWrapper.className = "canvasWrapper";
      textLayer.className = "textLayer";
      element.style.cssText = "position:relative; margin:0 auto 24px; background:#fff; box-shadow:0 2px 10px #0008;";
      canvas.style.cssText = "display:block; width:100%; height:100%;";
      textLayer.style.cssText = "position:absolute; inset:0; overflow:hidden; opacity:0.01; user-select:text;";
      canvasWrapper.append(canvas);
      element.append(canvasWrapper, textLayer);
      this.root.append(element);
      this.pagesByNumber.push({ pageNumber, pdfPage, element, canvasWrapper, canvas, textLayer, width: 0, height: 0 });
    }
    await this.renderAt(1, 0);
  }

  async renderAt(scale: number, rotation: number): Promise<number[]> {
    this.scale = scale;
    this.rotation = rotation;
    const renderDurations: number[] = [];
    for (const surface of this.pagesByNumber) {
      const started = performance.now();
      const viewport = surface.pdfPage.getViewport({ scale, rotation });
      const nextCanvas = document.createElement("canvas");
      const pixelRatio = window.devicePixelRatio || 1;
      nextCanvas.width = Math.ceil(viewport.width * pixelRatio);
      nextCanvas.height = Math.ceil(viewport.height * pixelRatio);
      nextCanvas.style.cssText = "display:block; width:100%; height:100%;";
      surface.element.style.width = `${viewport.width}px`;
      surface.element.style.height = `${viewport.height}px`;
      const context = nextCanvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas2D unavailable.");
      await surface.pdfPage.render({ canvasContext: context, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] }).promise;
      surface.canvas.replaceWith(nextCanvas);
      surface.canvas = nextCanvas;
      surface.width = viewport.width;
      surface.height = viewport.height;
      if (surface.textLayer.childElementCount === 0) {
        const textContent = await surface.pdfPage.getTextContent();
        for (const item of textContent.items.slice(0, 40)) {
          if (!("str" in item) || !item.str) continue;
          const span = document.createElement("span");
          span.textContent = item.str;
          surface.textLayer.append(span);
        }
      }
      renderDurations.push(performance.now() - started);
    }
    return renderDurations;
  }

  pages(): PdfPageInfo[] {
    return this.pagesByNumber.map((surface) => ({
      pageNumber: surface.pageNumber,
      width: surface.width / this.scale,
      height: surface.height / this.scale,
      scale: this.scale,
      rotation: this.rotation,
      element: surface.element
    }));
  }
  getViewState(): PdfViewState { return { pageNumber: 1, scrollFraction: 0, scale: this.scale, rotation: this.rotation }; }
  restoreViewState(): void {}
  scrollElement(): HTMLElement { return this.root; }
  mountOverlay(pageNumber: number): HTMLElement {
    const surface = this.pagesByNumber.find((entry) => entry.pageNumber === pageNumber);
    if (!surface) throw new Error(`Missing page ${pageNumber}`);
    const overlay = document.createElement("div");
    overlay.dataset.pageNumber = String(pageNumber);
    overlay.className = "native-pdf-handwriting-overlay";
    surface.element.append(overlay);
    return overlay;
  }
  mountToolbar(toolbar: HTMLElement): void { this.toolbarHost.append(toolbar); }
  compatibilityReport(): { errors: string[]; warnings: string[] } { return { errors: [], warnings: [] }; }
  destroy(): void { this.host.remove(); }
}

async function createSession(adapter: PdfjsAdapter): Promise<ViewerInkSession> {
  const files = new MemoryFiles();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.autosave = false;
  settings.toolPreferences.activeTool = "pen";
  return ViewerInkSession.create({
    adapter,
    pdfPath: "Fixtures/lorem-ipsum.pdf",
    settings,
    sidecars: new SidecarRepository(files, "annotations"),
    recovery: new RecoveryRepository(files, "recovery"),
    saveSettings: async () => undefined,
    readSourcePdf: async () => new Uint8Array(),
    writeExport: async () => undefined,
    notice: () => undefined
  });
}

function pointer(type: string, clientX: number, clientY: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: "pen",
    pointerId: 7,
    clientX,
    clientY,
    pressure: type === "pointerup" ? 0 : 0.55,
    buttons: type === "pointerup" ? 0 : 1,
    button: 0
  });
}

async function drawInk(adapter: PdfjsAdapter): Promise<void> {
  adapter.toolbarHost.querySelector<HTMLElement>("[data-control='draw']")?.click();
  const firstPage = adapter.pages()[0]?.element;
  if (!firstPage) throw new Error("Missing first PDF.js page.");
  firstPage.dispatchEvent(pointer("pointerdown", 110, 150));
  for (let index = 1; index <= 220; index += 1) {
    firstPage.dispatchEvent(pointer("pointermove", 110 + index * 1.8, 150 + Math.sin(index / 9) * 35 + index));
  }
  firstPage.dispatchEvent(pointer("pointerup", 510, 410));
  await nextFrame();
  await nextFrame();
}

export async function runPdfjsZoomEmulator(options: { fixtureBase64: string; cycles?: number; withHandwriting?: boolean } ): Promise<Record<string, unknown>> {
  GlobalWorkerOptions.workerSrc = String((globalThis as typeof globalThis & { __HN_PDFJS_WORKER_URL?: string }).__HN_PDFJS_WORKER_URL);
  const source = bytesFromBase64(options.fixtureBase64);
  const stressFixture = await tripleFixture(source);
  const loadingTask = getDocument({ data: stressFixture });
  const pdfDocument = await loadingTask.promise;
  const adapter = new PdfjsAdapter(pdfDocument);
  await adapter.initialize();
  const withHandwriting = options.withHandwriting !== false;
  const session = withHandwriting ? await createSession(adapter) : null;
  if (session) await drawInk(adapter);
  const before = {
    canvases: adapter.root.querySelectorAll("canvas").length,
    overlays: adapter.root.querySelectorAll(".native-pdf-handwriting-overlay").length,
    textLayers: adapter.root.querySelectorAll(".textLayer").length,
    nodes: adapter.root.querySelectorAll("*").length
  };
  const tickWorkMs: number[] = [];
  const renderWorkMs: number[] = [];
  const frameGapMs: number[] = [];
  const longTasks: { duration: number; startTime: number }[] = [];
  const observer = typeof PerformanceObserver === "undefined" ? null : new PerformanceObserver((entries) => {
    for (const entry of entries.getEntries()) longTasks.push({ duration: entry.duration, startTime: entry.startTime });
  });
  try { observer?.observe({ type: "longtask" }); } catch { /* Unsupported in this browser. */ }
  const cycles = options.cycles ?? 4;
  let previousFrame = performance.now();
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (let tick = 0; tick <= 24; tick += 1) {
      const phase = tick / 24;
      const scale = phase <= 0.5 ? 1 + phase * 6 : 4 - (phase - 0.5) * 6;
      const started = performance.now();
      session?.onViewStateChange({ ...adapter.getViewState(), scale }, "scalechanging");
      tickWorkMs.push(performance.now() - started);
      // PDF.js replaces raster canvases during a real zoom. Rendering every
      // fourth tick approximates its coalesced work without serializing 25 full
      // page renders into every gesture.
      if (tick % 4 === 0 || tick === 24) {
        renderWorkMs.push(...await adapter.renderAt(scale, cycle % 2 === 0 ? 0 : 90));
        session?.onPagesChanged("pdfjs-canvas-replaced");
      }
      const frame = await nextFrame();
      frameGapMs.push(frame - previousFrame);
      previousFrame = frame;
    }
    const settleUntil = performance.now() + 180;
    while (performance.now() < settleUntil) {
      const frame = await nextFrame();
      frameGapMs.push(frame - previousFrame);
      previousFrame = frame;
    }
    adapter.root.scrollTop = cycle % 2 === 0 ? 420 : 0;
    session?.onViewStateChange(adapter.getViewState(), "scroll");
  }
  observer?.disconnect();
  const after = {
    canvases: adapter.root.querySelectorAll("canvas").length,
    overlays: adapter.root.querySelectorAll(".native-pdf-handwriting-overlay").length,
    textLayers: adapter.root.querySelectorAll(".textLayer").length,
    nodes: adapter.root.querySelectorAll("*").length
  };
  const result = {
    emulator: "HN + PDF.js browser host — not native Obsidian",
    mode: withHandwriting ? "pdfjs-plus-hn" : "pdfjs-baseline",
    fixture: { sourcePages: (await PDFDocument.load(source)).getPageCount(), emulatedPages: pdfDocument.numPages },
    cycles,
    zoomRange: "1.0x → 4.0x → 1.0x",
    rotations: [0, 90],
    tickWorkMs: { median: percentile(tickWorkMs, 0.5), p95: percentile(tickWorkMs, 0.95), max: Math.max(...tickWorkMs) },
    pdfRenderWorkMs: { median: percentile(renderWorkMs, 0.5), p95: percentile(renderWorkMs, 0.95), max: Math.max(...renderWorkMs) },
    frameGapMs: { median: percentile(frameGapMs, 0.5), p95: percentile(frameGapMs, 0.95), max: Math.max(...frameGapMs), over33ms: frameGapMs.filter((value) => value > 33).length },
    longTasksOver50ms: durationSummary(longTasks.filter((entry) => entry.duration > 50)),
    before,
    after,
    growth: {
      canvases: after.canvases - before.canvases,
      overlays: after.overlays - before.overlays,
      textLayers: after.textLayers - before.textLayers,
      nodes: after.nodes - before.nodes
    }
  };
  if (session) await session.destroy();
  else adapter.destroy();
  await loadingTask.destroy();
  return result;
}
