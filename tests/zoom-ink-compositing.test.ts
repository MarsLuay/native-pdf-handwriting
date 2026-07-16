/**
 * Regression: zoom-burst overlay sync + deferred settle paint for ViewerInkSession.
 *
 * Expected FINAL behavior (implementer-owned src):
 * - scalechanging / zoom ticks: sync overlay layout to PDF canvas box while
 *   zoomCompositing defers expensive committed-stroke paint until settle.
 * - Prefer: scheduleZoomRepaint / beginZoomCompositing calls syncOverlayLayout
 *   (after refreshing surface.page from adapter.pages()) without renderPage paint.
 * - Settle (~120ms): endZoomCompositing + repaintSurfaces. Canvas resize snapshots
 *   prior ink, blits scaled bitmap, rebuilds inkLayer at new size (valid again).
 * - Strokes stay PDF-space; viewport projection uses mapper at display scale.
 *
 * Temporary white-box: `surfaces` Map on session (inkLayerValid). Prefer a public
 * debug helper later if one lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsidianPdfAdapter, PdfViewState } from "../src/integration/ObsidianPdfAdapter";
import type { PdfPageInfo } from "../src/integration/PdfPageLocator";
import { PdfCoordinateMapper } from "../src/pdf/PdfCoordinateMapper";
import { DEFAULT_SETTINGS } from "../src/model";
import { ViewerInkSession } from "../src/runtime/ViewerInkSession";
import { RecoveryRepository } from "../src/storage/RecoveryRepository";
import { SidecarRepository, type TextFileAdapter } from "../src/storage/SidecarRepository";

class MemoryFiles implements TextFileAdapter {
  readonly values = new Map<string, string>();
  async exists(path: string): Promise<boolean> {
    return this.values.has(path);
  }
  async read(path: string): Promise<string> {
    const value = this.values.get(path);
    if (value === undefined) throw new Error(`Missing ${path}`);
    return value;
  }
  async write(path: string, contents: string): Promise<void> {
    this.values.set(path, contents);
  }
  async remove(path: string): Promise<void> {
    this.values.delete(path);
  }
}

type Rect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  x: number;
  y: number;
  toJSON: () => Record<string, never>;
};

function rect(left: number, top: number, width: number, height: number): Rect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({})
  };
}

/** Adapter with a real PDF.js-style canvas so pageLayout tracks content box during zoom. */
class ZoomAdapter implements ObsidianPdfAdapter {
  readonly kind = "direct" as const;
  readonly host = document.createElement("div");
  readonly root = document.createElement("div");
  readonly pageElement = document.createElement("div");
  readonly toolbarHost = document.createElement("div");
  readonly pdfCanvas = document.createElement("canvas");
  readonly canvasWrapper = document.createElement("div");
  destroyed = false;
  scale = 1;
  pageWidth = 600;
  pageHeight = 800;
  hostBox = rect(0, 0, 600, 800);
  contentBox = rect(0, 0, 600, 800);
  readonly zoomByScaleFactor = vi.fn((factor: number) => {
    this.scale *= factor;
    return true;
  });

  constructor() {
    this.pageElement.dataset.pageNumber = "1";
    this.canvasWrapper.className = "canvasWrapper";
    this.canvasWrapper.append(this.pdfCanvas);
    this.pageElement.append(this.canvasWrapper);
    this.root.append(this.toolbarHost, this.pageElement);
    document.body.append(this.root);
    this.applyRects();
  }

  applyRects(): void {
    Object.defineProperty(this.pageElement, "getBoundingClientRect", {
      configurable: true,
      value: () => this.hostBox
    });
    Object.defineProperty(this.pdfCanvas, "getBoundingClientRect", {
      configurable: true,
      value: () => this.contentBox
    });
  }

  /** Simulate PDF.js zoom: content canvas grows; host may gain margins. */
  zoomTo(scale: number, content: { left: number; top: number; width: number; height: number }): void {
    this.scale = scale;
    this.contentBox = rect(content.left, content.top, content.width, content.height);
    this.hostBox = rect(
      0,
      0,
      Math.max(this.hostBox.width, content.left + content.width),
      Math.max(this.hostBox.height, content.top + content.height)
    );
    this.applyRects();
  }

  pages(): PdfPageInfo[] {
    return [{
      pageNumber: 1,
      width: this.pageWidth,
      height: this.pageHeight,
      scale: this.scale,
      rotation: 0,
      element: this.pageElement
    }];
  }

  getViewState(): PdfViewState {
    return { pageNumber: 1, scrollFraction: 0, scale: this.scale, rotation: 0 };
  }

  restoreViewState(): void {}
  scrollElement(): HTMLElement {
    return this.root;
  }
  mountOverlay(pageNumber: number): HTMLElement {
    const overlay = document.createElement("div");
    overlay.dataset.pageNumber = String(pageNumber);
    overlay.className = "native-pdf-handwriting-overlay";
    this.pageElement.append(overlay);
    return overlay;
  }
  mountToolbar(toolbar: HTMLElement): void {
    this.toolbarHost.append(toolbar);
  }
  compatibilityReport(): { errors: string[]; warnings: string[] } {
    return { errors: [], warnings: [] };
  }
  destroy(): void {
    this.destroyed = true;
    this.root.remove();
  }
}

type CanvasSpy = {
  setTransform: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  closePath: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  setLineDash: ReturnType<typeof vi.fn>;
  rect: ReturnType<typeof vi.fn>;
  ellipse: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
};

function mockCanvas2d(): CanvasSpy {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    closePath: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    rect: vi.fn(),
    ellipse: vi.fn(),
    drawImage: vi.fn()
  };
}

type SurfaceProbe = {
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  inkLayer: HTMLCanvasElement | null;
  inkLayerValid: boolean;
};

function probeSurface(session: ViewerInkSession): SurfaceProbe {
  const surfaces = (session as unknown as { surfaces: Map<number, SurfaceProbe> }).surfaces;
  const surface = surfaces.get(1);
  if (!surface) throw new Error("expected page-1 surface");
  return surface;
}

function overlayOf(adapter: ZoomAdapter): HTMLElement {
  const overlay = adapter.pageElement.querySelector<HTMLElement>(".native-pdf-handwriting-overlay");
  if (!overlay) throw new Error("overlay missing");
  return overlay;
}

function pointer(type: string, x: number, y: number): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerType: { value: "pen" },
    pointerId: { value: 11 },
    pressure: { value: 0.55 },
    tiltX: { value: 0 },
    tiltY: { value: 0 },
    width: { value: 1 },
    height: { value: 1 },
    buttons: { value: type === "pointerup" ? 0 : 1 },
    getCoalescedEvents: { value: () => [] }
  });
  return event as unknown as PointerEvent;
}

async function createSession(adapter: ZoomAdapter, files = new MemoryFiles()): Promise<ViewerInkSession> {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.autosave = false;
  settings.toolPreferences.activeTool = "pen";
  return ViewerInkSession.create({
    adapter,
    pdfPath: "Notes/zoom-ink.pdf",
    settings,
    sidecars: new SidecarRepository(files, "annotations"),
    recovery: new RecoveryRepository(files, "recovery"),
    saveSettings: async () => undefined,
    readSourcePdf: async () => new Uint8Array(),
    writeExport: async () => undefined,
    notice: () => undefined
  });
}

function paintStampCalls(context: CanvasSpy): number {
  return context.arc.mock.calls.length + context.stroke.mock.calls.length + context.fill.mock.calls.length;
}

function debugCalls(event: string): unknown[][] {
  return (console.debug as ReturnType<typeof vi.fn>).mock.calls.filter((call) => call[1] === event);
}

describe("zoom ink compositing", () => {
  let context: CanvasSpy;

  beforeEach(() => {
    context = mockCanvas2d();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("defers expensive stroke paint during zoom burst and repaints after settle", async () => {
    const adapter = new ZoomAdapter();
    const session = await createSession(adapter);
    const overlay = overlayOf(adapter);

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 140, 160));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 180, 200));

    context.arc.mockClear();
    context.fill.mockClear();
    context.stroke.mockClear();
    const stampsBeforeBurst = paintStampCalls(context);

    vi.useFakeTimers();
    adapter.zoomTo(1.5, { left: 40, top: 20, width: 900, height: 1200 });
    session.onViewStateChange(adapter.getViewState(), "scalechanging");
    session.onViewStateChange({ ...adapter.getViewState(), scale: 1.55 }, "scalechanging");

    expect(overlay.classList.contains("native-pdf-handwriting-zoom-compositing")).toBe(true);
    expect(paintStampCalls(context)).toBe(stampsBeforeBurst);

    const zoomTicks = debugCalls("ink zoom tick");
    expect(zoomTicks.length).toBeGreaterThanOrEqual(2);
    expect(zoomTicks.every((call) => (call[2] as { deferred?: boolean }).deferred === true)).toBe(true);
    expect(debugCalls("ink zoom repaint")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(120);

    expect(overlay.classList.contains("native-pdf-handwriting-zoom-compositing")).toBe(false);
    // Settle blits scaled ink — no graphite stamp rebuild on the settle tick.
    expect(paintStampCalls(context)).toBe(stampsBeforeBurst);
    expect(context.drawImage).toHaveBeenCalled();

    const repaints = debugCalls("ink zoom repaint");
    expect(repaints.length).toBeGreaterThanOrEqual(1);
    expect(repaints.at(-1)?.[2]).toMatchObject({
      reason: expect.stringContaining("scalechanging"),
      pagesRepainted: 1,
      strokesRedrawn: 0,
      burstTicks: expect.any(Number)
    });

    // Deferred HQ rebuild after settle.
    await vi.advanceTimersByTimeAsync(280);
    expect(paintStampCalls(context)).toBeGreaterThan(stampsBeforeBurst);

    // Settle path reattaches + syncs layout even if burst sync is missing.
    expect(overlay.style.left).toBe("40px");
    expect(overlay.style.top).toBe("20px");
    expect(overlay.style.width).toBe("900px");
    expect(overlay.style.height).toBe("1200px");

    await session.destroy();
  });

  it("starts compositing before the viewer applies a pinch scale change", async () => {
    const adapter = new ZoomAdapter();
    const session = await createSession(adapter);
    const overlay = overlayOf(adapter);
    let compositingAtZoomCall = false;
    adapter.zoomByScaleFactor.mockImplementation(() => {
      compositingAtZoomCall = overlay.classList.contains("native-pdf-handwriting-zoom-compositing");
      return true;
    });

    (session as unknown as { zoomAroundPinch(factor: number, clientX: number, clientY: number): void })
      .zoomAroundPinch(1.1, 200, 300);

    expect(adapter.zoomByScaleFactor).toHaveBeenCalledWith(1.1, [200, 300]);
    expect(compositingAtZoomCall).toBe(true);
    expect(overlay.classList.contains("native-pdf-handwriting-zoom-compositing")).toBe(true);

    await session.destroy();
  });

  it("syncs overlay layout to PDF canvas box during zoom burst (not only on settle)", async () => {
    const adapter = new ZoomAdapter();
    const session = await createSession(adapter);
    const overlay = overlayOf(adapter);

    vi.useFakeTimers();
    adapter.zoomTo(1.5, { left: 40, top: 20, width: 900, height: 1200 });
    session.onViewStateChange(adapter.getViewState(), "scalechanging");

    expect(overlay.classList.contains("native-pdf-handwriting-zoom-compositing")).toBe(true);
    // FINAL design: scheduleZoomRepaint/beginZoomCompositing must syncOverlayLayout
    // while stamp redraw stays deferred (zoomCompositing → renderPage early-return).
    expect(overlay.style.left).toBe("40px");
    expect(overlay.style.top).toBe("20px");
    expect(overlay.style.width).toBe("900px");
    expect(overlay.style.height).toBe("1200px");

    await session.destroy();
  });

  it("resizes inkLayer on settle, blits via drawImage, then rebuilds a warm cache", async () => {
    const adapter = new ZoomAdapter();
    const session = await createSession(adapter);

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 80, 90));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 110, 120));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 140, 150));

    context.drawImage.mockClear();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 160, 170));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 190, 200));
    expect(context.drawImage).toHaveBeenCalled();
    expect(probeSurface(session).inkLayerValid).toBe(true);
    expect(probeSurface(session).inkLayer).not.toBeNull();

    const canvasBefore = probeSurface(session).canvas.width;
    const layerBefore = probeSurface(session).inkLayer!.width;

    context.drawImage.mockClear();
    vi.useFakeTimers();
    adapter.zoomTo(2, { left: 0, top: 0, width: 1200, height: 1600 });
    session.onViewStateChange(adapter.getViewState(), "scalechanging");
    await vi.advanceTimersByTimeAsync(120);

    const surface = probeSurface(session);
    expect(surface.overlay.style.width).toBe("1200px");
    expect(surface.overlay.style.height).toBe("1600px");
    expect(surface.canvas.width).not.toBe(canvasBefore);
    // Resize seeds layer from scaled blit (no stroke rebuild on settle); still valid for live draw.
    expect(surface.inkLayer).not.toBeNull();
    expect(surface.inkLayer!.width).not.toBe(layerBefore);
    expect(surface.inkLayer!.width).toBe(surface.canvas.width);
    expect(surface.inkLayerValid).toBe(true);
    expect(context.drawImage).toHaveBeenCalled();
    expect(debugCalls("ink zoom repaint").at(-1)?.[2]).toMatchObject({ canvasesResized: 1, strokesRedrawn: 0 });

    // Deferred HQ upgrade after settle.
    await vi.advanceTimersByTimeAsync(280);
    expect(debugCalls("ink zoom repaint").length).toBeGreaterThanOrEqual(1);

    context.drawImage.mockClear();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 200, 220));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 230, 250));
    expect(context.drawImage).toHaveBeenCalled();
    expect(probeSurface(session).inkLayerValid).toBe(true);

    await session.destroy();
  });

  it("keeps stroke points in PDF space across zoom settle (mapper projects at new scale)", async () => {
    const files = new MemoryFiles();
    const adapter = new ZoomAdapter();
    const session = await createSession(adapter, files);

    adapter.toolbarHost.querySelector<HTMLInputElement>("[data-control='draw']")?.click();
    adapter.pageElement.dispatchEvent(pointer("pointerdown", 100, 120));
    adapter.pageElement.dispatchEvent(pointer("pointermove", 130, 150));
    adapter.pageElement.dispatchEvent(pointer("pointerup", 160, 180));
    await session.manualSave();

    const sidecarBefore = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]);
    const pointsBefore = sidecarBefore.pages[0].strokes[0].points as Array<{ x: number; y: number }>;
    expect(pointsBefore.length).toBeGreaterThanOrEqual(1);

    vi.useFakeTimers();
    adapter.zoomTo(1.8, { left: 10, top: 10, width: 1080, height: 1440 });
    session.onViewStateChange(adapter.getViewState(), "scalechanging");
    await vi.advanceTimersByTimeAsync(120);

    await session.manualSave();
    const sidecarAfter = JSON.parse([...files.values.entries()].find(([path]) => path.startsWith("annotations/"))![1]);
    const pointsAfter = sidecarAfter.pages[0].strokes[0].points as Array<{ x: number; y: number }>;
    expect(pointsAfter).toEqual(pointsBefore);

    const layoutScale = 1080 / 600;
    const mapper = new PdfCoordinateMapper({
      width: 600,
      height: 800,
      scale: layoutScale,
      rotation: 0,
      offsetX: 0,
      offsetY: 0
    });
    const expected = mapper.toViewport({ x: pointsAfter[0]!.x, y: pointsAfter[0]!.y });

    context.arc.mockClear();
    session.refresh("post-zoom-verify");
    const arcXs = context.arc.mock.calls.map((call) => call[0] as number);
    const arcYs = context.arc.mock.calls.map((call) => call[1] as number);
    expect(arcXs.some((x) => Math.abs(x - expected.x) < 1.5)).toBe(true);
    expect(arcYs.some((y) => Math.abs(y - expected.y) < 1.5)).toBe(true);

    await session.destroy();
  });

  it("treats data-scale like scalechanging for compositing deferral", async () => {
    const adapter = new ZoomAdapter();
    const session = await createSession(adapter);
    const overlay = overlayOf(adapter);

    vi.useFakeTimers();
    adapter.zoomTo(1.25, { left: 0, top: 0, width: 750, height: 1000 });
    session.onViewStateChange(adapter.getViewState(), "data-scale");

    expect(overlay.classList.contains("native-pdf-handwriting-zoom-compositing")).toBe(true);
    expect(debugCalls("ink zoom tick").length).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(120);
    expect(overlay.classList.contains("native-pdf-handwriting-zoom-compositing")).toBe(false);
    expect(overlay.style.width).toBe("750px");
    expect(overlay.style.height).toBe("1000px");
    await session.destroy();
  });
});
