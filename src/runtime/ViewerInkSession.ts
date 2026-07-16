import { isDrawingTool, resolveDrawingTool, type DrawingTool, type InkStroke, type PdfPoint, type PdfTextAnnotation, type PdfTextRun, type PluginSettings, type TextStyle, type ToolbarPlacement, type ToolPreferences, type TouchNavigationSettings } from "../model";
import type { ObsidianPdfAdapter } from "../integration/ObsidianPdfAdapter";
import type { PdfPageInfo } from "../integration/PdfPageLocator";
import { PointerRouter } from "../input/PointerRouter";
import { ViewerMousePan, type MousePanPhase } from "../input/ViewerMousePan";
import { shouldIgnoreSelectionShortcut, parseSelectionShortcut, parseHistoryShortcut, type SelectionShortcutAction } from "../input/SelectionShortcuts";
import { PointerCapabilities, type PointerSample } from "../input/PointerCapabilities";
import { InkSession } from "../ink/InkSession";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeClipboard } from "../ink/StrokeClipboard";
import { simplifyPoints } from "../ink/StrokeStabilizer";
import { PdfCoordinateMapper, type PageRotation } from "../pdf/PdfCoordinateMapper";
import { normalizeRotation, pdfRenderCanvas, resolvePageCoordinateLayout, type PageCoordinateLayout } from "../pdf/PageCoordinateLayout";
import { setElementCssProps } from "../dom/typeGuards";
import { PdfExportService, annotatedFilename, editableAnnotatedFilename, type PdfExportMode } from "../pdf/PdfExportService";
import { AddStrokeCommand, AddStrokesCommand, DeleteStrokesCommand, ReplacePageStrokesCommand, ReplaceStrokesCommand, translateStrokes } from "../history/AnnotationCommands";
import { CommandHistory, type Command } from "../history/CommandHistory";
import { eraseStrokes, eraseWholeStrokes } from "../tools/EraserTool";
import { boundingShapeFromStrokes, filterSelectableStrokes, selectStrokes, selectionShapeArea, shapeBounds, shapeContainsPoint, translateShape, type SelectionShape } from "../tools/LassoTool";
import { drawGraphiteStroke, seedFromId } from "../tools/PencilTool";
import { drawLaserStroke, laserTrailStillVisible, mapLaserPoints } from "../tools/LaserTool";
import { drawPenStroke } from "../tools/PenTool";
import { AutosaveQueue } from "../storage/AutosaveQueue";
import { createDocumentIdentity } from "../storage/DocumentIdentity";
import { RecoveryRepository } from "../storage/RecoveryRepository";
import { SaveCoordinator, type CloseChoice } from "../storage/SaveCoordinator";
import { SidecarRepository } from "../storage/SidecarRepository";
import { pickNewerSidecar, serializeSidecar, countSidecarStrokes, type SidecarSchemaV1 } from "../storage/SidecarSchema";
import type { VaultSyncWriter } from "../storage/VaultSyncWriter";
import { AnnotationToolbar, type MoreAction } from "../ui/AnnotationToolbar";
import { inkBackingSize } from "./inkBackingSize";
import type { DebugState } from "../ui/DebugPanel";
import { SelectionToolbar, type ViewportPoint } from "../ui/SelectionToolbar";
import { SessionLogger, type DrawPositionLog, type ViewStateSource } from "../logging/SessionLogger";
import type { VaultLogSink } from "../logging/VaultLogSink";
import type { PdfViewState } from "../integration/ObsidianPdfAdapter";
import { describeScrollElement } from "../integration/PdfScrollRoot";

export interface SessionDiagnostics {
  pdfPath: string;
  compatibility: { errors: string[]; warnings: string[] };
  debug: DebugState;
}

export interface ViewerInkSessionOptions {
  adapter: ObsidianPdfAdapter;
  pdfPath: string;
  settings: PluginSettings;
  sidecars: SidecarRepository;
  recovery: RecoveryRepository;
  saveSettings(preferences: ToolPreferences): Promise<void>;
  savePluginSettings?(patch: Partial<PluginSettings>): Promise<void>;
  readSourcePdf(): Promise<Uint8Array>;
  writeExport(name: string, bytes: Uint8Array): Promise<string | void>;
  notice(message: string): void;
  decideUnsaved?(): Promise<CloseChoice>;
  touchNavigationSettings?(): TouchNavigationSettings;
  simplifyStrokesEnabled?(): boolean;
  toolbarPlacement?: () => ToolbarPlacement;
  vaultLog?: VaultLogSink;
  /** PDF++/viewer reload detached our DOM — plugin should drop session and rescan. */
  onDetached?: () => void;
  /** Sync filesystem writer for unload/detach — flush must not race async vault I/O. */
  writeSync?: VaultSyncWriter | null;
  /** Monotonic epoch per document so a replaced session cannot overwrite a newer one. */
  claimPersistEpoch?: (documentId: string) => number;
  livePersistEpoch?: (documentId: string) => number;
}

interface PageSurface {
  page: PdfPageInfo;
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  /** Committed-stroke cache — blit for live draw + zoom settle before HQ rebuild. */
  inkLayer: HTMLCanvasElement | null;
  inkLayerContext: CanvasRenderingContext2D | null;
  inkLayerValid: boolean;
  router: PointerRouter | null;
  builder: StrokeBuilder | undefined;
  laserDraft: boolean;
  straightenTimer: number | null;
  straightenAnchor: PdfPoint | undefined;
  editPath: PdfPoint[];
  editTool: "eraser" | "lasso" | undefined;
  textEditActive: boolean;
  eraserSize: number | undefined;
  eraserWholeStrokes: boolean | undefined;
}

interface ActiveTextEditor {
  input: HTMLDivElement;
  runs: PdfTextRun[];
  composing: boolean;
  point: Pick<PdfPoint, "x" | "y">;
  selectionStart: number;
  selectionEnd: number;
  style: TextStyle;
  page: number;
  annotationId: string | undefined;
  abort: AbortController;
  commit: () => void;
  preserveBlur: boolean;
  cancelled: boolean;
  cancelDialog: HTMLElement | null;
  drag: { pointerId: number; start: PdfPoint; origin: Pick<PdfPoint, "x" | "y"> } | null;
}

interface ZoomBurst {
  startedAt: number;
  tickCount: number;
  scaleStart: number | null;
  scaleEnd: number | null;
  reason: string;
}

interface LaserTrail {
  id: string;
  page: number;
  points: PdfPoint[];
  color: string;
  width: number;
  opacity: number;
  holdMs: number;
  fadeMs: number;
}

export class ViewerInkSession {
  private readonly ink = new InkSession();
  private readonly textAnnotations = new Map<number, PdfTextAnnotation[]>();
  private activeTextEditor: ActiveTextEditor | null = null;
  private readonly identity;
  private readonly surfaces = new Map<number, PageSurface>();
  private readonly exporter = new PdfExportService();
  private readonly laserTrails: LaserTrail[] = [];
  private laserFadeFrame: number | null = null;
  private readonly createdAt = new Date().toISOString();
  private readonly toolbar: AnnotationToolbar;
  private readonly selectionToolbar: SelectionToolbar;
  private readonly history: CommandHistory;
  private readonly autosave: AutosaveQueue<SidecarSchemaV1>;
  private readonly saveCoordinator: SaveCoordinator;
  private selected: InkStroke[] = [];
  private selectedTexts: PdfTextAnnotation[] = [];
  private selectionShape: SelectionShape | null = null;
  private selectionPage: number | null = null;
  private moveDrag: {
    page: number;
    start: PdfPoint;
    before: InkStroke[];
    beforeTexts: PdfTextAnnotation[];
    beforeShape: SelectionShape;
    openTextOnClick?: PdfTextAnnotation;
  } | null = null;
  private movePreview: InkStroke[] | null = null;
  private moveTextPreview: PdfTextAnnotation[] | null = null;
  private moveShapePreview: SelectionShape | null = null;
  private drawEnabled = true;
  private debugState: DebugState = {};
  private destroyed = false;
  private detachNotified = false;
  private persistEpoch = 0;
  private alreadyEmergencyPersisted = false;
  private writesAbandoned = false;
  private detachCheckTimer: number | null = null;
  private refreshDepth = 0;
  private resizeFrame: number | null = null;
  private pendingScheduledRefresh: { reason: string; repaintOnly: boolean } | null = null;
  private zoomSettleTimer: number | null = null;
  private zoomBurst: ZoomBurst = {
    startedAt: 0,
    tickCount: 0,
    scaleStart: null,
    scaleEnd: null,
    reason: "view-scalechanging"
  };
  private lastZoomSignalAt = 0;
  private zoomCompositing = false;
  private static readonly ZOOM_SETTLE_MS = 120;
  private static readonly ZOOM_ACTIVE_MS = 500;
  private inkUpgradeTimer: number | null = null;
  private readonly inkUpgradePages = new Set<number>();
  /** Wait after zoom settle before HQ graphite rebuild — avoids hitching mid-pinch. */
  private static readonly INK_UPGRADE_MS = 280;
  private pasteGeneration = 0;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly logger: SessionLogger;
  private readonly viewerMousePan: ViewerMousePan;
  private readonly pointerProbeAbort = new AbortController();
  private lastPointerPdf: { x: number; y: number } | undefined;
  /** Stable PDF point sizes from sidecar / first trusted live measurement — survives bad data-scale inference. */
  private readonly pageMetrics = new Map<number, { width: number; height: number }>();

  private constructor(private readonly options: ViewerInkSessionOptions) {
    this.identity = createDocumentIdentity({ vaultPath: options.pdfPath });
    this.logger = new SessionLogger(options.pdfPath, options.vaultLog);
    this.toolbar = new AnnotationToolbar({
      preferences: options.settings.toolPreferences,
      autosave: options.settings.autosave,
      drawEnabled: this.drawEnabled,
      supportedMoreActions: ["export-flattened", "export-editable", "toolbar-main", "toolbar-left", "toolbar-right"],
      callbacks: {
        onPreferencesChange: (preferences) => {
          void options.saveSettings(preferences);
          this.refresh("preferences");
        },
        onTextStyleChange: (patch) => this.applyTextStyle(patch),
        onTextMarkdownFormat: (format) => this.insertTextMarkdownFormat(format),
        selectedTextFontSize: () => this.activeTextSelectionFontSize(),
        selectedTextColor: () => this.activeTextColor(),
        onSelectionColorChange: (color) => this.recolorSelection(color),
        onSelectionWidthChange: (width) => this.resizeSelection(width),
        hasActiveTextInput: () => this.activeTextEditor !== null,
        hasSelectedText: () => this.selectedTexts.length > 0,
        onTextEditorInteractionStart: () => this.preserveTextEditorSelection(),
        onEraserSizePreview: () => {
          this.refreshSurfaceCursors();
        },
        onDrawModeChange: (enabled) => {
          this.drawEnabled = enabled;
          if (!enabled) this.clearSelection();
          this.logMousePanConfig("draw-mode");
          this.refresh("draw-mode");
        },
        onUndo: () => this.history.undo(),
        onRedo: () => this.history.redo(),
        onSave: () => this.manualSave(),
        onMore: (action) => void this.handleMore(action),
        toolbarPlacement: () => this.options.toolbarPlacement?.() ?? this.options.settings.toolbarPlacement
      }
    });
    this.selectionToolbar = new SelectionToolbar({
      onDelete: () => this.deleteSelection(),
      onDuplicate: () => this.duplicateSelection(),
      onClear: () => {
        this.commitActiveTextInput();
        this.clearSelection();
      }
    });
    this.selectionToolbar.bindViewport(options.adapter.root);
    this.autosave = new AutosaveQueue<SidecarSchemaV1>({
      delayMs: options.settings.autosaveDelayMs,
      retryFailed: options.settings.retryFailedAutosaves,
      write: async (_documentId, snapshot) => this.persist(snapshot, "autosave"),
      onStatus: (_documentId, status, error) => {
        this.toolbar.setSaveStatus(status, status === "saved" ? new Date() : undefined);
        if (status === "saved") this.saveCoordinator.markSaved();
        if (status === "failed") {
          this.logger.sidecarPersist({
            reason: "autosave",
            documentId: this.identity.id,
            strokeCount: this.ink.all().length,
            dirty: this.isDirty(),
            updatedAt: new Date().toISOString(),
            error: this.errorMessage(error)
          });
        }
      }
    });
    this.saveCoordinator = new SaveCoordinator({
      autosave: options.settings.autosave,
      saveWhenClosing: options.settings.saveWhenClosing,
      save: () => this.persist(this.snapshot(), "manual"),
      scheduleAutosave: () => this.autosave.schedule(this.identity.id, this.snapshot())
    });
    this.history = new CommandHistory(() => {
      this.saveCoordinator.completedCommand();
      this.toolbar.setSaveStatus("dirty");
      this.refresh("history");
    });
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        this.scheduleRefresh("resize", true);
      });
    this.resizeObserver?.observe(options.adapter.root);
    const adapter = options.adapter;
    this.viewerMousePan = new ViewerMousePan(adapter.host.ownerDocument, {
      enabled: () => !this.drawEnabled,
      touchPanEnabled: () => this.touchNavigationSettings().singleTouchMode === "touch",
      scrollRoot: () => adapter.scrollElement(),
      withinTarget: (target) => {
        if (!(target instanceof Element)) return false;
        if (target.closest(".native-pdf-handwriting-toolbar, .native-pdf-handwriting-dropdown, .native-pdf-handwriting-selection-toolbar")) return false;
        return adapter.host.contains(target) || adapter.root.contains(target);
      },
      captureElement: () => adapter.root,
      onPan: (phase, event, details) => this.logMousePan(phase, event, details)
    });
    this.installPointerProbe(adapter);
  }

  private installPointerProbe(adapter: ViewerInkSessionOptions["adapter"]): void {
    const doc = adapter.host.ownerDocument;
    const options = { capture: true, signal: this.pointerProbeAbort.signal };
    let wheelPinchCount = 0;
    let lastWheelLogAt = 0;
    const within = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      return adapter.host.contains(target) || adapter.root.contains(target);
    };
    const targetLabel = (target: EventTarget | null): string => {
      if (target === null) return "null";
      if (!(target instanceof Element)) return Object.prototype.toString.call(target);
      const tag = target.tagName.toLowerCase();
      const classes = [...target.classList].slice(0, 3).join(".");
      return classes ? `${tag}.${classes}` : tag;
    };
    const routeDrawModePen = (event: Event): void => {
      const pointer = event as PointerEvent;
      if (!this.drawEnabled || pointer.pointerType !== "pen" || !within(pointer.target)) return;
      const surface = this.surfaceForPointerTarget(pointer.target);
      if (!surface?.router) return;
      pointer.preventDefault();
      pointer.stopImmediatePropagation();
      surface.router.routePointer(pointer);
    };
    const win = doc.defaultView;
    if (win) {
      const penOptions = { capture: true, passive: false, signal: this.pointerProbeAbort.signal };
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const) {
        win.addEventListener(type, routeDrawModePen, penOptions);
      }
    }
    doc.addEventListener("pointerdown", (e: PointerEvent) => {
      this.logger.pointerSeen({
        source: "pointerdown",
        pointerType: e.pointerType || "(empty)",
        pointerId: e.pointerId,
        isPrimary: e.isPrimary,
        button: e.button,
        buttons: e.buttons,
        width: e.width,
        height: e.height,
        pressure: e.pressure,
        tiltX: e.tiltX,
        tiltY: e.tiltY,
        clientX: Math.round(e.clientX),
        clientY: Math.round(e.clientY),
        within: within(e.target),
        target: targetLabel(e.target)
      });
    }, options);
    doc.addEventListener("touchstart", (e: TouchEvent) => {
      const touches = [...e.changedTouches].map((touch) => ({
        identifier: touch.identifier,
        clientX: Math.round(touch.clientX),
        clientY: Math.round(touch.clientY),
        radiusX: touch.radiusX,
        radiusY: touch.radiusY,
        force: touch.force
      }));
      this.logger.pointerSeen({
        source: "touchstart",
        pointerType: "touch",
        touchCount: e.touches.length,
        changedCount: e.changedTouches.length,
        within: within(e.target),
        target: targetLabel(e.target),
        touches
      });
    }, { ...options, passive: true });
    // Mac trackpad pinch = wheel+ctrl in Chromium/Electron — not pointerType "touch".
    doc.addEventListener("wheel", (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const now = performance.now();
      wheelPinchCount += 1;
      if (wheelPinchCount > 1 && now - lastWheelLogAt < 80) return;
      lastWheelLogAt = now;
      this.logger.pointerSeen({
        source: "wheel-pinch",
        pointerType: "wheel",
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        clientX: Math.round(e.clientX),
        clientY: Math.round(e.clientY),
        within: within(e.target),
        target: targetLabel(e.target),
        burstIndex: wheelPinchCount
      });
    }, { ...options, passive: true });
    // Safari / some WebKit builds expose gesture* for pinch.
    for (const name of ["gesturestart", "gesturechange", "gestureend"] as const) {
      doc.addEventListener(name, (event) => {
        const e = event as Event & { scale?: number; rotation?: number };
        this.logger.pointerSeen({
          source: name,
          pointerType: "gesture",
          scale: e.scale,
          rotation: e.rotation,
          within: within(e.target),
          target: targetLabel(e.target)
        });
      }, options);
    }
  }

  private surfaceForPointerTarget(target: EventTarget | null): PageSurface | null {
    if (!(target instanceof Element)) return null;
    for (const surface of this.surfaces.values()) {
      if (surface.page.element.contains(target)) return surface;
    }
    return null;
  }

  private scheduleRefresh(reason: string, repaintOnly = false): void {
    if (this.destroyed) return;
    if (repaintOnly) {
      this.scheduleZoomRepaint(reason, this.options.adapter.getViewState().scale);
      return;
    }
    if (this.isZoomGestureActive()) {
      this.logger.zoomRepaintInterrupt(reason, { kind: "full-refresh-during-zoom" });
    }
    if (this.pendingScheduledRefresh) {
      this.pendingScheduledRefresh.reason = reason;
      if (!repaintOnly) this.pendingScheduledRefresh.repaintOnly = false;
    } else {
      this.pendingScheduledRefresh = { reason, repaintOnly };
    }
    if (this.resizeFrame !== null) return;
    this.resizeFrame = window.requestAnimationFrame(() => {
      const pending = this.pendingScheduledRefresh;
      this.resizeFrame = null;
      this.pendingScheduledRefresh = null;
      if (!pending) return;
      if (pending.repaintOnly) this.repaintSurfaces(pending.reason);
      else this.refresh(pending.reason);
    });
  }

  private isZoomGestureActive(): boolean {
    return this.lastZoomSignalAt > 0
      && performance.now() - this.lastZoomSignalAt < ViewerInkSession.ZOOM_ACTIVE_MS;
  }

  private scheduleZoomRepaint(reason: string, scale?: number): void {
    if (this.destroyed) return;
    const now = performance.now();
    this.lastZoomSignalAt = now;
    if (!this.zoomBurst.startedAt || now - this.zoomBurst.startedAt > ViewerInkSession.ZOOM_ACTIVE_MS) {
      this.zoomBurst = {
        startedAt: now,
        tickCount: 0,
        scaleStart: scale ?? null,
        scaleEnd: null,
        reason
      };
    }
    this.zoomBurst.tickCount += 1;
    this.zoomBurst.reason = reason;
    // Only freeze ink bitmap during real zoom/rotation — pages-dom storms must keep repainting.
    if (ViewerInkSession.shouldCompositeDuring(reason) && !this.zoomCompositing) {
      this.beginZoomCompositing();
    }
    // Burst: keep overlay box glued to PDF canvas content box; skip stroke redraw.
    if (this.zoomCompositing) this.syncZoomOverlayLayouts();
    this.refreshSurfaceCursors();
    if (scale !== undefined) {
      if (this.zoomBurst.scaleStart === null) this.zoomBurst.scaleStart = scale;
      this.zoomBurst.scaleEnd = scale;
    }
    this.logger.zoomTick({
      reason,
      tick: this.zoomBurst.tickCount,
      ...(scale !== undefined ? { scale: Number(scale.toFixed(4)) } : {})
    });
    if (this.zoomSettleTimer !== null) window.clearTimeout(this.zoomSettleTimer);
    this.zoomSettleTimer = window.setTimeout(() => {
      this.zoomSettleTimer = null;
      const burst = this.zoomBurst;
      this.zoomBurst = { startedAt: 0, tickCount: 0, scaleStart: null, scaleEnd: null, reason: burst.reason };
      this.lastZoomSignalAt = 0;
      this.endZoomCompositing();
      this.repaintSurfaces(burst.reason, {
        burstTicks: burst.tickCount,
        burstDurationMs: roundMs(performance.now() - burst.startedAt),
        ...(burst.scaleStart !== null ? { scaleStart: burst.scaleStart } : {}),
        ...(burst.scaleEnd !== null ? { scaleEnd: burst.scaleEnd } : {})
      });
    }, ViewerInkSession.ZOOM_SETTLE_MS);
  }

  private static isZoomRepaintSource(source: ViewStateSource): boolean {
    return source === "scalechanging" || source === "data-scale" || source === "rotationchanging";
  }

  private static shouldCompositeDuring(reason: string): boolean {
    return reason.includes("scalechanging")
      || reason.includes("data-scale")
      || reason.includes("rotationchanging")
      || reason.includes("rotation");
  }

  private static isZoomPaintReason(reason: string): boolean {
    return ViewerInkSession.shouldCompositeDuring(reason)
      || reason.includes("resize")
      || reason.includes("zoom");
  }

  private beginZoomCompositing(): void {
    this.cancelInkLayerUpgrades();
    this.zoomCompositing = true;
    for (const surface of this.surfaces.values()) {
      this.captureInkLayerFromCanvas(surface);
      surface.overlay.classList.add("native-pdf-handwriting-zoom-compositing");
    }
  }

  private endZoomCompositing(): void {
    this.zoomCompositing = false;
    for (const surface of this.surfaces.values()) {
      surface.overlay.classList.remove("native-pdf-handwriting-zoom-compositing");
    }
  }

  /** Align overlay boxes during zoom burst without paintCommittedStrokes. */
  private syncZoomOverlayLayouts(): void {
    const pages = this.options.adapter.pages();
    const byNumber = new Map(pages.map((page) => [page.pageNumber, page]));
    for (const [pageNumber, surface] of this.surfaces) {
      const current = byNumber.get(pageNumber);
      if (!current) continue;
      if (!this.reattachSurface(surface, current)) continue;
      surface.overlay.classList.add("native-pdf-handwriting-zoom-compositing");
      this.syncOverlayLayout(surface);
    }
  }

  private repaintSurfaces(
    reason: string,
    burst?: { burstTicks: number; burstDurationMs: number; scaleStart?: number; scaleEnd?: number }
  ): void {
    if (this.destroyed) return;
    const started = performance.now();
    const stats = { pagesRepainted: 0, canvasesResized: 0, strokesRedrawn: 0, skippedDisconnected: 0 };
    const pages = this.options.adapter.pages();
    const byNumber = new Map(pages.map((page) => [page.pageNumber, page]));
    for (const [pageNumber, surface] of this.surfaces) {
      const current = byNumber.get(pageNumber);
      if (!current) {
        stats.skippedDisconnected += 1;
        continue;
      }
      if (!this.reattachSurface(surface, current)) {
        stats.skippedDisconnected += 1;
        continue;
      }
      this.renderPage(pageNumber, stats, reason);
      stats.pagesRepainted += 1;
    }
    this.ensureSelectionToolbar();
    this.refreshSurfaceCursors();
    const view = this.options.adapter.getViewState();
    this.logger.zoomRepaint({
      reason,
      durationMs: roundMs(performance.now() - started),
      pagesRepainted: stats.pagesRepainted,
      canvasesResized: stats.canvasesResized,
      strokesRedrawn: stats.strokesRedrawn,
      skippedDisconnected: stats.skippedDisconnected,
      scale: Number(view.scale.toFixed(4)),
      ...(burst ? {
        burstTicks: burst.burstTicks,
        burstDurationMs: burst.burstDurationMs,
        ...(burst.scaleStart !== undefined ? { scaleStart: burst.scaleStart } : {}),
        ...(burst.scaleEnd !== undefined ? { scaleEnd: burst.scaleEnd } : {})
      } : {})
    });
  }

  static async create(options: ViewerInkSessionOptions): Promise<ViewerInkSession> {
    const session = new ViewerInkSession(options);
    session.persistEpoch = options.claimPersistEpoch?.(session.identity.id) ?? 1;
    const sidecar = await options.sidecars.load(session.identity.id);
    const recovery = await options.recovery.load(session.identity.id);
    const stored = pickNewerSidecar(sidecar, recovery);
    const sidecarStrokes = countSidecarStrokes(sidecar);
    const recoveryStrokes = countSidecarStrokes(recovery);
    const loadedStrokes = countSidecarStrokes(stored);
    session.logger.sidecarLoad({
      documentId: session.identity.id,
      sidecarStrokes,
      recoveryStrokes,
      loadedStrokes,
      sidecarUpdatedAt: sidecar?.updatedAt ?? null,
      recoveryUpdatedAt: recovery?.updatedAt ?? null
    });
    for (const page of stored?.pages ?? []) {
      if (page.width > 1 && page.height > 1) {
        session.pageMetrics.set(page.page, { width: page.width, height: page.height });
      }
      for (const stroke of page.strokes) session.ink.add(stroke);
      for (const text of page.texts ?? []) {
        session.textAnnotations.set(page.page, [...(session.textAnnotations.get(page.page) ?? []), text]);
      }
    }
    options.adapter.mountToolbar(session.toolbar.element, session.currentToolbarPlacement());
    session.logger.sessionAttach({
      scrollRoot: describeScrollElement(options.adapter.scrollElement()),
      panCapture: "document-capture",
      panBoundary: describeScrollElement(options.adapter.host),
      drawEnabled: session.drawEnabled,
      toolbarPlacement: session.currentToolbarPlacement(),
      loadedStrokes,
      sidecarStrokes,
      recoveryStrokes,
      persistEpoch: session.persistEpoch
    });
    session.refreshDiagnostics();
    session.refresh("create");
    return session;
  }

  refresh(reason = "manual"): void {
    if (this.destroyed) return;
    if (this.isZoomGestureActive() && (reason.startsWith("pages-") || reason.startsWith("view-"))) {
      this.scheduleZoomRepaint(reason, this.options.adapter.getViewState().scale);
      return;
    }
    if (this.isZoomGestureActive()) {
      this.logger.zoomRepaintInterrupt(reason, { kind: "full-refresh-during-zoom" });
    }
    if (this.refreshDepth >= 4) {
      this.logger.loopBlocked("refresh", this.refreshDepth);
      return;
    }
    this.refreshDepth += 1;
    this.reconcileSelection();
    this.invalidateInkLayers();
    this.logger.refresh(reason, {
      selected: this.selected.length,
      surfaces: this.surfaces.size
    });
    try {
      const pages = this.options.adapter.pages();
      const live = new Set(pages.map((page) => page.pageNumber));
      for (const [pageNumber, surface] of this.surfaces) {
        const current = pages.find((page) => page.pageNumber === pageNumber);
        if (!current) {
          surface.router?.destroy();
          surface.overlay.remove();
          this.surfaces.delete(pageNumber);
          continue;
        }
        if (current.element !== surface.page.element) {
          surface.router?.destroy();
          surface.overlay.remove();
          this.surfaces.delete(pageNumber);
          continue;
        }
        if (!this.reattachSurface(surface, current)) {
          surface.router?.destroy();
          surface.overlay.remove();
          this.surfaces.delete(pageNumber);
          continue;
        }
      }
      for (const page of pages) {
        if (!this.surfaces.has(page.pageNumber)) this.surfaces.set(page.pageNumber, this.mountPage(page));
        const surface = this.surfaces.get(page.pageNumber);
        surface?.page.element.classList.toggle("native-pdf-handwriting-draw-active", this.drawEnabled);
        surface?.router?.syncToolState();
        this.renderPage(page.pageNumber);
      }
      for (const pageNumber of [...this.surfaces.keys()]) {
        if (!live.has(pageNumber)) {
          const surface = this.surfaces.get(pageNumber);
          surface?.router?.destroy();
          surface?.overlay.remove();
          this.surfaces.delete(pageNumber);
        }
      }
      this.ensureSelectionToolbar();
      this.syncAnnotationCursorMode();
    } finally {
      this.refreshDepth -= 1;
    }
  }

  private ensureSelectionToolbar(options?: { resetPlacement?: boolean }): void {
    const count = this.selected.length + this.selectedTexts.length;
    if (!count || this.selectionPage === null) return;
    if (options?.resetPlacement) this.selectionToolbar.resetPlacement();
    const anchor = this.autoToolbarAnchor();
    this.selectionToolbar.show(count, anchor);
    this.selectionToolbar.reposition(anchor);
    this.toolbar.refresh();
  }

  private autoToolbarAnchor(): ViewportPoint {
    const root = this.options.adapter.root;
    const rootRect = root.getBoundingClientRect();
    const defaultAnchor: ViewportPoint = {
      x: Math.max(8, (rootRect.width - 280) / 2),
      y: 8
    };
    const surface = this.selectionPage ? this.surfaces.get(this.selectionPage) : undefined;
    if (!surface || !this.selectionShape) return defaultAnchor;

    const editor = this.activeTextEditor;
    if (editor?.annotationId && editor.page === this.selectionPage) {
      const point = this.mapper(surface).toViewport(editor.point);
      return { x: point.x - 140, y: point.y - 56 };
    }

    const bounds = shapeBounds(this.selectionShape);
    const mapper = this.mapper(surface);
    const topCenterView = mapper.toViewport({ x: (bounds.minX + bounds.maxX) / 2, y: bounds.maxY });
    const overlayRect = surface.overlay.getBoundingClientRect();
    const clientCenterX = overlayRect.left + topCenterView.x;
    const clientTopY = overlayRect.top + topCenterView.y;
    const visible = clientCenterX >= rootRect.left && clientCenterX <= rootRect.right
      && clientTopY >= rootRect.top && clientTopY <= rootRect.bottom;
    if (!visible) return defaultAnchor;

    return {
      x: clientCenterX - rootRect.left - 140,
      y: clientTopY - rootRect.top - 56
    };
  }

  onViewStateChange(state: PdfViewState, source: ViewStateSource): void {
    this.logger.viewState(state, source);
    if (source === "scroll") {
      if (this.selected.length) this.selectionToolbar.relayout();
      return;
    }
    if (ViewerInkSession.isZoomRepaintSource(source)) {
      if (this.selected.length) this.selectionToolbar.relayout();
      this.scheduleZoomRepaint(`view-${source}`, state.scale);
      return;
    }
    this.refresh(`view-${source}`);
  }

  onPagesChanged(reason: string): void {
    const pages = this.options.adapter.pages();
    const overlayConnected = Object.fromEntries(
      [...this.surfaces.entries()].map(([pageNumber, surface]) => [pageNumber, surface.overlay.isConnected])
    );
    this.logger.pagesChanged(reason, pages.length, overlayConnected);

    // PDF++ reload often replaces the viewer tree — root disconnects and MutationObserver dies.
    if (!this.options.adapter.host.isConnected || !this.options.adapter.root.isConnected) {
      this.notifyDetached("root-disconnected");
      return;
    }

    if (!pages.length) {
      // Transient empty during rebuild — wait, then detach so plugin re-attaches to the new viewer.
      this.scheduleDetachCheck();
      return;
    }

    if (this.detachCheckTimer !== null) {
      window.clearTimeout(this.detachCheckTimer);
      this.detachCheckTimer = null;
    }

    if (this.isZoomGestureActive() && ViewerInkSession.shouldCompositeDuring(this.zoomBurst.reason)) {
      this.scheduleZoomRepaint(`pages-${reason}`, this.options.adapter.getViewState().scale);
      return;
    }

    if (this.tryReattachDisconnectedSurfaces(pages)) {
      this.scheduleRefresh(`pages-reattach-${reason}`, true);
      return;
    }

    if (this.canSyncPagesWithoutRefresh(pages)) {
      for (const page of pages) {
        const surface = this.surfaces.get(page.pageNumber);
        if (surface) surface.page = page;
      }
      this.scheduleRefresh(`pages-sync-${reason}`, true);
      return;
    }

    this.scheduleRefresh(`pages-${reason}`);
  }

  private scheduleDetachCheck(): void {
    if (this.destroyed || this.detachNotified || this.detachCheckTimer !== null) return;
    this.detachCheckTimer = window.setTimeout(() => {
      this.detachCheckTimer = null;
      if (this.destroyed || this.detachNotified) return;
      const { adapter } = this.options;
      if (!adapter.host.isConnected || !adapter.root.isConnected) {
        this.notifyDetached("root-disconnected-settled");
        return;
      }
      const pages = adapter.pages();
      if (!pages.length) {
        this.notifyDetached("pages-empty-settled");
        return;
      }
      // Pages returned under the same root — recover without full recreate.
      this.onPagesChanged("pages-settled");
    }, 450);
  }

  private notifyDetached(reason: string): void {
    if (this.destroyed || this.detachNotified) return;
    this.detachNotified = true;
    if (this.detachCheckTimer !== null) {
      window.clearTimeout(this.detachCheckTimer);
      this.detachCheckTimer = null;
    }
    this.logger.pagesChanged(`detach:${reason}`, 0, {});
    this.options.onDetached?.();
  }

  private reattachSurface(surface: PageSurface, page: PdfPageInfo): boolean {
    if (surface.overlay.isConnected) {
      surface.page = page;
      this.rememberPageMetrics(page);
      this.syncOverlayLayout(surface);
      return true;
    }
    if (!page.element.isConnected) return false;
    this.ensurePagePositioning(page.element);
    page.element.append(surface.overlay);
    surface.page = page;
    this.rememberPageMetrics(page);
    this.syncOverlayLayout(surface);
    return true;
  }

  private tryReattachDisconnectedSurfaces(pages: PdfPageInfo[]): boolean {
    let reattached = false;
    for (const page of pages) {
      const surface = this.surfaces.get(page.pageNumber);
      if (!surface) continue;
      if (surface.overlay.isConnected && surface.page.element === page.element) continue;
      if (!page.element.isConnected) continue;
      // PDF++ reload replaces page nodes — remount overlay + router onto the new element.
      if (surface.page.element !== page.element) {
        surface.router?.destroy();
        surface.router = null;
        surface.page = page;
        this.ensurePagePositioning(page.element);
        page.element.append(surface.overlay);
        this.rememberPageMetrics(page);
        this.syncOverlayLayout(surface);
        surface.router = this.createPageRouter(surface);
        reattached = true;
        continue;
      }
      if (this.reattachSurface(surface, page)) reattached = true;
    }
    return reattached;
  }

  private canSyncPagesWithoutRefresh(pages: PdfPageInfo[]): boolean {
    if (pages.length !== this.surfaces.size) return false;
    return pages.every((page) => {
      const surface = this.surfaces.get(page.pageNumber);
      if (!surface) return false;
      return surface.page.element === page.element && surface.overlay.isConnected;
    });
  }

  isDirty(): boolean {
    return this.saveCoordinator.hasUnsavedChanges() || this.autosave.isDirty(this.identity.id);
  }

  async manualSave(): Promise<void> {
    this.toolbar.setSaveStatus("saving");
    try {
      await this.saveCoordinator.manualSave();
      this.toolbar.setSaveStatus("saved", new Date());
      this.options.notice("Annotations saved in the sidecar. Export PDF to use them in another viewer.");
    } catch (error) {
      this.toolbar.setSaveStatus("failed");
      this.options.notice(`Save failed: ${this.errorMessage(error)}`);
      throw error;
    }
  }

  async flush(): Promise<void> {
    if (this.writesAbandoned) return;
    if (this.options.settings.autosave) await this.autosave.flush(this.identity.id);
    else if (this.options.settings.saveWhenClosing && this.isDirty()) await this.manualSave();
  }

  /** Stop this session from writing the sidecar — a newer session owns the document. */
  abandonWrites(reason = "abandoned"): void {
    if (this.writesAbandoned) return;
    this.writesAbandoned = true;
    this.autosave.abandon();
    this.saveCoordinator.markSaved();
    this.logger.sidecarPersist({
      reason,
      documentId: this.identity.id,
      strokeCount: this.ink.all().length,
      dirty: false,
      updatedAt: new Date().toISOString(),
      skipped: "abandoned-writer"
    });
  }

  getDocumentId(): string {
    return this.identity.id;
  }

  getPersistEpoch(): number {
    return this.persistEpoch;
  }

  emergencyPersist(writeSync: VaultSyncWriter, options: { force?: boolean; reason?: string } = {}): void {
    const reason = options.reason ?? "emergency";
    const strokeCount = this.ink.all().length;
    if (this.writesAbandoned) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        dirty: false,
        updatedAt: new Date().toISOString(),
        skipped: "abandoned-writer"
      });
      return;
    }
    const liveEpoch = this.options.livePersistEpoch?.(this.identity.id);
    if (liveEpoch !== undefined && liveEpoch !== this.persistEpoch) {
      this.abandonWrites(`stale-epoch-emergency:${this.persistEpoch}<${liveEpoch}`);
      return;
    }
    if (!options.force && !this.isDirty()) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        dirty: false,
        updatedAt: new Date().toISOString(),
        skipped: "not-dirty"
      });
      return;
    }
    try {
      const snapshot = this.snapshot();
      const serialized = serializeSidecar(snapshot);
      writeSync(this.options.sidecars.pathFor(this.identity.id), serialized);
      writeSync(this.options.recovery.pathFor(this.identity.id), serialized);
      this.autosave.markClean(this.identity.id);
      this.saveCoordinator.markSaved();
      this.alreadyEmergencyPersisted = true;
      // Block further async persist; in-flight drains re-check stillOwnsPersist.
      this.writesAbandoned = true;
      this.autosave.abandon();
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount: countSidecarStrokes(snapshot),
        dirty: false,
        updatedAt: snapshot.updatedAt
      });
    } catch (error) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        dirty: this.isDirty(),
        updatedAt: new Date().toISOString(),
        error: this.errorMessage(error)
      });
    }
  }

  getDiagnostics(): SessionDiagnostics {
    return {
      pdfPath: this.options.pdfPath,
      compatibility: this.options.adapter.compatibilityReport(),
      debug: this.debugState
    };
  }

  refreshDiagnostics(): void {
    this.updateDebug();
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (this.destroyed) return false;
    const editor = this.activeTextEditor;
    if (editor && this.isTextEditorCommitShortcut(event) && event.target instanceof Node && this.isTextEditorNode(editor.input, event.target)) {
      event.preventDefault();
      event.stopPropagation();
      editor.commit();
      return true;
    }
    if (shouldIgnoreSelectionShortcut(event.target)) return false;
    const historyAction = parseHistoryShortcut(event);
    if (historyAction) {
      const ok = historyAction === "undo" ? this.history.undo() : this.history.redo();
      if (!ok) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    const action = parseSelectionShortcut(event);
    if (!action || !this.canSelectionShortcut(action)) return false;
    this.applySelectionShortcut(action);
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  canSelectionShortcut(action: SelectionShortcutAction): boolean {
    if (this.destroyed) return false;
    if (action === "selectAll") return this.drawEnabled;
    if (action === "paste") {
      return this.drawEnabled && Boolean(StrokeClipboard.peek()?.strokes.length);
    }
    this.reconcileSelection();
    return this.selected.length > 0;
  }

  applySelectionShortcut(action: SelectionShortcutAction): void {
    if (action === "selectAll") this.selectAllOnCurrentPage();
    else if (action === "copy") this.copySelection();
    else if (action === "cut") this.cutSelection();
    else if (action === "paste") this.pasteSelection();
    else if (action === "delete") this.deleteSelection();
  }

  async exportCopy(mode: PdfExportMode = "flattened"): Promise<void> {
    await this.autosave.flush(this.identity.id);
    const bytes = await this.exporter.export({
      sourceBytes: await this.options.readSourcePdf(),
      getStrokes: () => this.ink.all(),
      getTexts: () => [...this.textAnnotations.values()].flat(),
      pageMetrics: this.exportPageMetrics(),
      mode
    });
    const sourceName = this.options.pdfPath.split("/").pop() ?? "document.pdf";
    const name = mode === "editable" ? editableAnnotatedFilename(sourceName) : annotatedFilename(sourceName);
    const path = await this.options.writeExport(name, bytes);
    const exportType = mode === "editable" ? "editable annotations" : "flattened ink";
    this.options.notice(`Exported ${typeof path === "string" ? path : name} with ${exportType}. Original PDF unchanged.`);
  }

  async destroy(options: { silent?: boolean; alreadyPersisted?: boolean } = {}): Promise<boolean> {
    if (this.destroyed) return true;
    if (this.detachCheckTimer !== null) {
      window.clearTimeout(this.detachCheckTimer);
      this.detachCheckTimer = null;
    }
    const strokeCount = this.ink.all().length;
    const dirty = this.isDirty();
    const alreadyPersisted = Boolean(options.alreadyPersisted || this.alreadyEmergencyPersisted);
    this.logger.sessionDestroy({
      reason: options.silent ? "silent" : "close",
      silent: Boolean(options.silent),
      strokeCount,
      dirty,
      alreadyPersisted
    });
    if (!alreadyPersisted) {
      const writeSync = this.options.writeSync;
      if (writeSync) this.emergencyPersist(writeSync, { force: dirty || strokeCount > 0, reason: options.silent ? "destroy-silent" : "destroy" });
    }
    if (!options.silent) {
      if (!this.options.settings.autosave && this.isDirty()) {
        const choice = await this.options.decideUnsaved?.() ?? "cancel";
        if (!await this.saveCoordinator.prepareClose(choice)) return false;
      } else if (this.options.settings.saveWhenClosing && !alreadyPersisted) {
        try {
          await this.autosave.flush(this.identity.id);
        } catch (error) {
          await this.options.recovery.save(this.snapshot());
          this.options.notice(`Pending annotations kept for recovery: ${this.errorMessage(error)}`);
        }
      }
    } else if (!alreadyPersisted) {
      try {
        await this.autosave.flush(this.identity.id);
      } catch {
        await this.options.recovery.save(this.snapshot()).catch(() => undefined);
      }
    }
    this.destroyed = true;
    if (this.resizeFrame !== null) {
      window.cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    if (this.zoomSettleTimer !== null) {
      window.clearTimeout(this.zoomSettleTimer);
      this.zoomSettleTimer = null;
    }
    if (this.laserFadeFrame !== null) {
      window.cancelAnimationFrame(this.laserFadeFrame);
      this.laserFadeFrame = null;
    }
    this.laserTrails.length = 0;
    this.cancelInkLayerUpgrades();
    this.endZoomCompositing();
    this.syncAnnotationCursorMode(false);
    this.resizeObserver?.disconnect();
    for (const surface of this.surfaces.values()) {
      this.cancelStraighten(surface);
      surface.router?.destroy();
    }
    this.surfaces.clear();
    this.selectionToolbar.destroy();
    this.viewerMousePan.destroy();
    this.pointerProbeAbort.abort();
    this.toolbar.destroy();
    this.options.adapter.destroy();
    await this.autosave.close().catch(() => undefined);
    return true;
  }

  private syncAnnotationCursorMode(enabled = this.drawEnabled): void {
    const tool = this.options.settings.toolPreferences.activeTool;
    const hideNativeCursor = enabled
      && (isDrawingTool(tool) || tool === "laser" || tool === "eraser");
    this.options.adapter.root.classList.toggle("native-pdf-handwriting-draw-active", enabled);
    this.options.adapter.root.classList.toggle("native-pdf-handwriting-hide-native-cursor", hideNativeCursor);
  }

  private activeDrawingTool(): DrawingTool {
    return resolveDrawingTool(this.options.settings.toolPreferences.activeTool);
  }

  private refreshSurfaceCursors(): void {
    for (const surface of this.surfaces.values()) surface.router?.refreshCursors();
  }

  private logMousePanConfig(reason: string): void {
    this.logger.mousePan("config", this.mousePanContext(reason));
  }

  private logMousePan(phase: MousePanPhase, event: PointerEvent, details: Record<string, unknown>): void {
    this.logger.mousePan(phase, {
      ...this.mousePanContext(),
      clientX: Math.round(event.clientX),
      clientY: Math.round(event.clientY),
      pointerId: event.pointerId,
      pointerType: event.pointerType || "(empty)",
      buttons: event.buttons,
      width: event.width,
      height: event.height,
      pressure: event.pressure,
      ...details
    });
  }

  private mousePanContext(reason?: string): Record<string, unknown> {
    return {
      drawEnabled: this.drawEnabled,
      panEnabled: !this.drawEnabled,
      scrollRoot: describeScrollElement(this.options.adapter.scrollElement()),
      ...(reason ? { reason } : {})
    };
  }

  private mountPage(page: PdfPageInfo): PageSurface {
    this.rememberPageMetrics(page);
    const overlay = this.options.adapter.mountOverlay(page.pageNumber);
    const canvas = overlay.ownerDocument.createElement("canvas");
    canvas.className = "native-pdf-handwriting-canvas";
    this.setCanvasAccessibilityLabel(canvas, page.pageNumber, this.options.settings.hideStylusAnnotationLabel);
    overlay.append(canvas);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D rendering is unavailable");
    const surface: PageSurface = {
      page,
      overlay,
      canvas,
      context,
      inkLayer: null,
      inkLayerContext: null,
      inkLayerValid: false,
      router: null,
      builder: undefined,
      laserDraft: false,
      straightenTimer: null,
      straightenAnchor: undefined,
      editPath: [],
      editTool: undefined,
      textEditActive: false,
      eraserSize: undefined,
      eraserWholeStrokes: undefined
    };
    surface.router = this.createPageRouter(surface);
    this.ensurePagePositioning(page.element);
    this.syncOverlayLayout(surface);
    return surface;
  }

  private setCanvasAccessibilityLabel(canvas: HTMLCanvasElement, pageNumber: number, hidden: boolean): void {
    if (hidden) canvas.removeAttribute("aria-label");
    else canvas.setAttribute("aria-label", `Annotations for PDF page ${pageNumber}`);
  }

  private touchNavigationSettings(): TouchNavigationSettings {
    return this.options.touchNavigationSettings?.() ?? this.options.settings;
  }

  private createPageRouter(surface: PageSurface): PointerRouter {
    return new PointerRouter(surface.page.element, {
      activeTool: () => this.options.settings.toolPreferences.activeTool,
      drawingEnabled: () => this.drawEnabled,
      onStylusEraser: () => this.selectStylusEraser(),
      onStylusEraserEnd: () => this.restoreLastDrawingTool(),
      onTextInput: (event) => this.openTextInput(surface, event),
      rightMouseEraserEnabled: () => this.options.settings.toolPreferences.eraser.eraseWithRightMouseButton,
      singleTouchMode: () => this.touchNavigationSettings().singleTouchMode,
      twoFingerPinchZoomEnabled: () => this.touchNavigationSettings().twoFingerPinchZoom,
      twoFingerSwipeScrollEnabled: () => this.touchNavigationSettings().twoFingerSwipeScroll,
      scrollRoot: () => null,
      cursorParent: () => surface.overlay,
      eraserCursorDiameter: () => this.options.settings.toolPreferences.eraser.size * this.displayScale(surface),
      drawCursorColor: () => {
        const preferences = this.options.settings.toolPreferences;
        return preferences.activeTool === "laser"
          ? preferences.laser.color
          : preferences[this.activeDrawingTool()].color;
      },
      projectCursor: (clientX, clientY) => this.projectInkScreenPoint(surface, clientX, clientY),
      onStart: (samples, route, event) => this.pointerStart(surface, samples, route, event),
      onMove: (samples, route, event) => this.pointerMove(surface, samples, route, event),
      onEnd: (samples, route, event) => this.pointerEnd(surface, samples, route, event),
      onCancel: (_route, event, reason) => this.pointerCancel(surface, event, reason),
      onRoute: (route, event) => {
        this.updateDebug(surface, event);
        this.logger.pointerRoute(route, {
          page: surface.page.pageNumber,
          pointerType: event.pointerType || "(empty)",
          pointerId: event.pointerId,
          isPrimary: event.isPrimary,
          button: event.button,
          buttons: event.buttons,
          width: event.width,
          height: event.height,
          pressure: event.pressure,
          clientX: Math.round(event.clientX),
          clientY: Math.round(event.clientY)
        });
      },
      onPinch: (factor, clientX, clientY) => this.zoomAroundPinch(factor, clientX, clientY),
      onTwoFingerPan: (deltaX, deltaY) => this.scrollFromTwoFingerPan(deltaX, deltaY),
      onMousePan: (phase, _event, details) => this.logger.mousePan(phase, { page: surface.page.pageNumber, ...details })
    }, undefined, surface.canvas);
  }

  private selectStylusEraser(): void {
    const preferences = this.options.settings.toolPreferences;
    this.toolbar.selectEraser();
    void this.options.saveSettings(preferences);
    this.refresh("stylus-eraser");
  }

  private restoreLastDrawingTool(): void {
    const preferences = this.options.settings.toolPreferences;
    this.toolbar.restoreLastDrawingTool();
    void this.options.saveSettings(preferences);
    this.refresh("stylus-eraser-end");
  }

  private scrollFromTwoFingerPan(deltaX: number, deltaY: number): void {
    const root = this.options.adapter.scrollElement();
    if (typeof root.scrollBy === "function") {
      root.scrollBy(-deltaX, -deltaY);
      return;
    }
    root.scrollLeft -= deltaX;
    root.scrollTop -= deltaY;
  }

  private openTextInput(surface: PageSurface, event: PointerEvent, existing?: PdfTextAnnotation): void {
    if (this.activeTextEditor) {
      this.commitActiveTextInput();
      this.clearSelection();
      return;
    }
    if (!existing && (this.selected.length || this.selectedTexts.length)) this.clearSelection();
    const point = existing ? { x: existing.x, y: existing.y } : this.toPdfPoint(surface, PointerCapabilities.sample(event), true);
    const viewport = this.mapper(surface).toViewport(point);
    const input = surface.overlay.ownerDocument.createElement("div");
    input.className = "native-pdf-handwriting-text-input";
    input.contentEditable = "true";
    input.tabIndex = 0;
    input.dataset.placeholder = "Text";
    input.setAttribute("role", "textbox");
    input.setAttribute("aria-multiline", "true");
    input.style.left = `${viewport.x}px`;
    input.style.top = `${viewport.y}px`;
    const style = this.textStyle(existing);
    input.style.color = style.color;
    input.style.fontSize = `${style.fontSize * this.displayScale(surface)}px`;
    input.style.fontFamily = style.fontFamily ?? "sans-serif";
    input.style.fontWeight = style.bold ? "700" : "400";
    input.style.fontStyle = style.italic ? "italic" : "normal";
    const editor: ActiveTextEditor = {
      input,
      runs: this.textSourceRuns(existing, style),
      composing: false,
      point,
      selectionStart: 0,
      selectionEnd: 0,
      style,
      page: surface.page.pageNumber,
      annotationId: existing?.id,
      abort: new AbortController(),
      commit: () => undefined,
      preserveBlur: false,
      cancelled: false,
      cancelDialog: null,
      drag: null
    };
    this.activeTextEditor = editor;
    const rememberSelection = (): void => {
      this.captureTextEditorSelection(editor);
      this.toolbar.refresh();
    };
    const commit = (): void => {
      if (editor.cancelled) return;
      editor.cancelled = true;
      editor.runs = this.readTextEditorRuns(editor);
      const sourceRuns = this.trimTextRuns(editor.runs);
      const sourceText = sourceRuns.map((run) => run.text).join("");
      const runs = this.normalizeTextRuns(sourceRuns, sourceText, style);
      const renderedText = runs.map((run) => run.text).join("");
      editor.abort.abort();
      editor.cancelDialog?.remove();
      editor.cancelDialog = null;
      input.remove();
      if (this.activeTextEditor === editor) this.activeTextEditor = null;
      if (!renderedText || this.isMarkdownDelimiterOnly(sourceText)) {
        this.renderPage(surface.page.pageNumber);
        return;
      }
      const now = new Date().toISOString();
      const annotation: PdfTextAnnotation = {
        id: existing?.id ?? this.id(), page: surface.page.pageNumber, text: renderedText, x: editor.point.x, y: editor.point.y,
        color: style.color, fontSize: style.fontSize, fontFamily: style.fontFamily ?? "sans-serif",
        bold: style.bold ?? false, italic: style.italic ?? false,
        runs,
        sourceRuns,
        createdAt: existing?.createdAt ?? now, updatedAt: now
      };
      if (existing && annotation.text === existing.text &&
          annotation.x === existing.x && annotation.y === existing.y &&
          this.sameTextRuns(this.textRuns(existing, style), runs) &&
          this.sameTextRuns(this.textSourceRuns(existing, style), sourceRuns)) {
        this.renderPage(surface.page.pageNumber);
        return;
      }
      this.history.execute({
        label: existing ? "Edit text" : "Add text",
        execute: () => existing ? this.replaceTextAnnotation(existing, annotation) : this.addTextAnnotation(annotation),
        undo: () => existing ? this.replaceTextAnnotation(annotation, existing) : this.removeTextAnnotation(annotation)
      });
      this.refresh(existing ? "text-edit" : "text-add");
    };
    editor.commit = commit;
    input.addEventListener("keydown", (keyEvent) => {
      if (editor.composing || keyEvent.isComposing) return;
      if (this.isTextEditorCommitShortcut(keyEvent)) {
        keyEvent.preventDefault();
        commit();
      } else if (keyEvent.key === "Enter") {
        keyEvent.preventDefault();
        this.insertTextIntoEditor(editor, "\n");
      }
      if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        this.requestCancelTextInput(editor);
      }
    });
    input.addEventListener("blur", () => {
      const preserveBlur = editor.preserveBlur;
      queueMicrotask(() => {
        if (preserveBlur || editor.preserveBlur) {
          if (this.activeTextEditor === editor && editor.input.isConnected) {
            editor.preserveBlur = false;
            editor.input.focus({ preventScroll: true });
            this.setTextEditorSelection(editor, editor.selectionStart, editor.selectionEnd);
          }
          return;
        }
        const target = input.ownerDocument.activeElement;
        if (target instanceof Element && target.closest(".native-pdf-handwriting-toolbar, .native-pdf-handwriting-dropdown, .native-pdf-handwriting-text-cancel-dialog")) return;
        commit();
      });
    });
    input.addEventListener("keyup", rememberSelection);
    input.addEventListener("pointerup", rememberSelection);
    input.ownerDocument.addEventListener("selectionchange", rememberSelection, { signal: editor.abort.signal });
    input.addEventListener("beforeinput", (inputEvent) => {
      if (editor.composing || inputEvent.isComposing) return;
      if (inputEvent.inputType !== "insertText" || !inputEvent.data) return;
      inputEvent.preventDefault();
      this.insertTextIntoEditor(editor, inputEvent.data);
    });
    input.addEventListener("compositionstart", () => {
      editor.composing = true;
    });
    input.addEventListener("compositionend", () => {
      editor.composing = false;
      queueMicrotask(() => {
        if (this.activeTextEditor !== editor || !editor.input.isConnected || editor.composing) return;
        editor.runs = this.readTextEditorRuns(editor);
        rememberSelection();
        this.renderTextEditor(editor);
        this.setTextEditorSelection(editor, editor.selectionStart, editor.selectionEnd);
      });
    });
    input.addEventListener("pointerdown", (pointerEvent) => this.startTextEditorDrag(editor, surface, pointerEvent));
    input.addEventListener("pointermove", (pointerEvent) => this.moveTextEditorDrag(editor, surface, pointerEvent));
    input.addEventListener("pointerup", (pointerEvent) => this.endTextEditorDrag(editor, pointerEvent));
    input.addEventListener("pointercancel", (pointerEvent) => this.endTextEditorDrag(editor, pointerEvent));
    input.addEventListener("input", () => {
      editor.runs = this.readTextEditorRuns(editor);
      rememberSelection();
      if (editor.composing) return;
      this.renderTextEditor(editor);
      this.setTextEditorSelection(editor, editor.selectionStart, editor.selectionEnd);
    });
    surface.overlay.append(input);
    this.renderTextEditor(editor);
    input.focus();
    const initialCaret = existing ? 0 : this.markdownEmphasisMarker(style).length;
    this.setTextEditorSelection(editor, initialCaret, initialCaret);
    if (existing) {
      this.selectedTexts = [existing];
      this.selectionPage = surface.page.pageNumber;
      this.selectionShape = { type: "rectangle", bounds: this.textBounds(existing) };
      this.ensureSelectionToolbar({ resetPlacement: true });
    }
    this.renderPage(surface.page.pageNumber);
  }

  private cancelActiveTextInput(editor = this.activeTextEditor): void {
    if (!editor) return;
    editor.cancelled = true;
    editor.abort.abort();
    editor.cancelDialog?.remove();
    editor.cancelDialog = null;
    editor.input.remove();
    if (this.activeTextEditor === editor) this.activeTextEditor = null;
    this.renderPage(editor.page);
  }

  private startTextEditorDrag(editor: ActiveTextEditor, surface: PageSurface, event: PointerEvent): void {
    if (!editor.annotationId || event.button !== 0) return;
    const rect = editor.input.getBoundingClientRect();
    const border = 6;
    const onBorder = event.clientX - rect.left <= border || rect.right - event.clientX <= border ||
      event.clientY - rect.top <= border || rect.bottom - event.clientY <= border;
    if (!onBorder) return;
    event.preventDefault();
    event.stopPropagation();
    editor.drag = {
      pointerId: event.pointerId,
      start: this.toPdfPoint(surface, PointerCapabilities.sample(event), true),
      origin: { ...editor.point }
    };
    editor.input.setPointerCapture?.(event.pointerId);
  }

  private moveTextEditorDrag(editor: ActiveTextEditor, surface: PageSurface, event: PointerEvent): void {
    const drag = editor.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const point = this.toPdfPoint(surface, PointerCapabilities.sample(event), true);
    editor.point = { ...drag.origin, x: drag.origin.x + point.x - drag.start.x, y: drag.origin.y + point.y - drag.start.y };
    const viewport = this.mapper(surface).toViewport(editor.point);
    editor.input.style.left = `${viewport.x}px`;
    editor.input.style.top = `${viewport.y}px`;
    const annotation = this.textAnnotations.get(editor.page)?.find((item) => item.id === editor.annotationId);
    if (annotation) this.selectionShape = { type: "rectangle", bounds: this.textBounds({ ...annotation, ...editor.point }) };
    this.ensureSelectionToolbar();
  }

  private endTextEditorDrag(editor: ActiveTextEditor, event: PointerEvent): void {
    if (!editor.drag || editor.drag.pointerId !== event.pointerId) return;
    editor.drag = null;
    if (editor.input.hasPointerCapture?.(event.pointerId)) editor.input.releasePointerCapture?.(event.pointerId);
  }

  setTextEscapeBehavior(skipConfirmation: boolean, action: PluginSettings["textEscapeAction"]): void {
    this.options.settings.skipTextCancelConfirmation = skipConfirmation;
    this.options.settings.textEscapeAction = skipConfirmation ? action ?? "discard" : null;
  }

  private requestCancelTextInput(editor = this.activeTextEditor): void {
    if (!editor || editor.cancelled) return;
    if (this.options.settings.skipTextCancelConfirmation) {
      if (this.options.settings.textEscapeAction === "save") editor.commit();
      else this.cancelActiveTextInput(editor);
      return;
    }
    if (editor.cancelDialog) return;
    const document = editor.input.ownerDocument;
    const dialog = document.createElement("div");
    dialog.className = "native-pdf-handwriting-text-cancel-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Save text changes");
    const content = document.createElement("div");
    content.className = "native-pdf-handwriting-text-cancel-dialog-content";
    const message = document.createElement("p");
    message.textContent = "Save text changes?";
    const option = document.createElement("label");
    const remember = document.createElement("input");
    remember.type = "checkbox";
    option.append(remember, " Don't ask again");
    const actions = document.createElement("div");
    actions.className = "native-pdf-handwriting-text-cancel-dialog-actions";
    const keepEditing = document.createElement("button");
    keepEditing.type = "button";
    keepEditing.dataset.action = "keep-editing";
    keepEditing.textContent = "Keep editing";
    const save = document.createElement("button");
    save.type = "button";
    save.dataset.action = "save";
    save.textContent = "Save";
    const discard = document.createElement("button");
    discard.type = "button";
    discard.dataset.action = "discard";
    discard.textContent = "Discard";
    const close = (): void => {
      dialog.remove();
      if (editor.cancelDialog === dialog) editor.cancelDialog = null;
      if (this.activeTextEditor === editor && editor.input.isConnected) {
        editor.input.focus({ preventScroll: true });
        this.setTextEditorSelection(editor, editor.selectionStart, editor.selectionEnd);
      }
    };
    keepEditing.addEventListener("click", close);
    const rememberAction = (action: "save" | "discard"): void => {
      if (!remember.checked) return;
      this.options.settings.skipTextCancelConfirmation = true;
      this.options.settings.textEscapeAction = action;
      const persisted = this.options.savePluginSettings?.({
        skipTextCancelConfirmation: true,
        textEscapeAction: action
      });
      void persisted?.catch(() => undefined);
    };
    save.addEventListener("click", () => {
      rememberAction("save");
      editor.commit();
    });
    discard.addEventListener("click", () => {
      rememberAction("discard");
      this.cancelActiveTextInput(editor);
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });
    actions.append(keepEditing, save, discard);
    content.append(message, option, actions);
    dialog.append(content);
    document.body.append(dialog);
    editor.cancelDialog = dialog;
    keepEditing.focus();
  }

  private commitActiveTextInput(): void {
    this.activeTextEditor?.commit();
  }

  private isTextEditorCommitShortcut(event: KeyboardEvent): boolean {
    return (event.ctrlKey || event.metaKey) && !event.altKey &&
      (event.key === "Enter" || event.code === "NumpadEnter");
  }

  private preserveTextEditorSelection(): void {
    const editor = this.activeTextEditor;
    if (!editor) return;
    this.captureTextEditorSelection(editor);
    editor.preserveBlur = true;
  }

  private restoreTextEditorSelection(editor: ActiveTextEditor): void {
    queueMicrotask(() => {
      if (this.activeTextEditor !== editor || !editor.input.isConnected) return;
      editor.preserveBlur = false;
      editor.input.focus({ preventScroll: true });
      this.setTextEditorSelection(editor, editor.selectionStart, editor.selectionEnd);
    });
  }

  private addTextAnnotation(annotation: PdfTextAnnotation): void {
    this.textAnnotations.set(annotation.page, [...(this.textAnnotations.get(annotation.page) ?? []), annotation]);
  }

  private removeTextAnnotation(annotation: PdfTextAnnotation): void {
    this.textAnnotations.set(annotation.page, (this.textAnnotations.get(annotation.page) ?? []).filter((item) => item.id !== annotation.id));
  }

  private replaceTextAnnotation(before: PdfTextAnnotation, after: PdfTextAnnotation): void {
    this.textAnnotations.set(before.page, (this.textAnnotations.get(before.page) ?? []).map((item) => item.id === before.id ? after : item));
  }

  private applyTextStyle(patch: Partial<TextStyle>): boolean {
    const editor = this.activeTextEditor;
    if (editor) {
      this.captureTextEditorSelection(editor);
      editor.style = { ...editor.style, ...patch };
      this.updateTextEditorStyle(editor);
      if (editor.selectionStart === editor.selectionEnd) {
        this.restoreTextEditorSelection(editor);
        return true;
      }
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.runs = this.applyTextRunStyle(editor.runs, editor.selectionStart, editor.selectionEnd, patch);
      this.renderTextEditor(editor);
      this.setTextEditorSelection(editor, start, end);
      this.restoreTextEditorSelection(editor);
      return true;
    }
    return this.styleSelectedTextAnnotations(patch);
  }

  private activeTextSelectionFontSize(): { fontSize: number; mixed: boolean } | undefined {
    const editor = this.activeTextEditor;
    if (!editor) return undefined;
    this.captureTextEditorSelection(editor);
    if (editor.selectionStart === editor.selectionEnd) return undefined;
    let position = 0;
    let largest = 0;
    const sizes = new Set<number>();
    for (const run of this.previewMarkdownTextRuns(editor.runs)) {
      const end = position + run.text.length;
      if (editor.selectionStart < end && editor.selectionEnd > position) {
        largest = Math.max(largest, run.fontSize);
        sizes.add(run.fontSize);
      }
      position = end;
    }
    return largest > 0 ? { fontSize: largest, mixed: sizes.size > 1 } : undefined;
  }

  private updateTextEditorStyle(editor: ActiveTextEditor): void {
    const surface = this.surfaces.get(editor.page);
    if (!surface) return;
    const style = editor.style;
    editor.input.style.color = style.color;
    editor.input.style.fontSize = `${style.fontSize * this.displayScale(surface)}px`;
    editor.input.style.fontFamily = style.fontFamily ?? "sans-serif";
    editor.input.style.fontWeight = style.bold ? "700" : "400";
    editor.input.style.fontStyle = style.italic ? "italic" : "normal";
  }

  private insertTextMarkdownFormat(format: "bold" | "italic"): boolean {
    const editor = this.activeTextEditor;
    if (!editor) {
      if (!this.selectedTexts.length) return false;
      const selectedRuns = this.selectedTexts.flatMap((annotation) => this.textRuns(annotation, this.textStyle(annotation)));
      return this.styleSelectedTextAnnotations({ [format]: !selectedRuns.every((run) => run[format]) });
    }
    this.captureTextEditorSelection(editor);
    if (editor.selectionStart === editor.selectionEnd) {
      const markerLength = this.markdownEmphasisMarkerLengthAtCaret(editor, format);
      if (markerLength > 0) {
        const start = editor.selectionStart;
        editor.runs = this.mergeTextRuns([
          ...this.sliceTextRuns(editor.runs, 0, start - markerLength),
          ...this.sliceTextRuns(editor.runs, start + markerLength, Number.POSITIVE_INFINITY)
        ]);
        editor.selectionStart = start - markerLength;
        editor.selectionEnd = start - markerLength;
        this.renderTextEditor(editor);
        this.setTextEditorSelection(editor, editor.selectionStart, editor.selectionEnd);
        this.restoreTextEditorSelection(editor);
        return true;
      }
      const marker = format === "bold" ? "**" : "*";
      const start = editor.selectionStart;
      const markerStyle = this.textRunAt(editor.runs, start) ?? this.textRun("", editor.style);
      const before = this.sliceTextRuns(editor.runs, 0, start);
      const after = this.sliceTextRuns(editor.runs, start, Number.POSITIVE_INFINITY);
      editor.runs = this.mergeTextRuns([
        ...before,
        { ...markerStyle, text: marker },
        { ...markerStyle, text: marker },
        ...after
      ]);
      editor.selectionStart = start + marker.length;
      editor.selectionEnd = start + marker.length;
      this.renderTextEditor(editor);
      this.setTextEditorSelection(editor, editor.selectionStart, editor.selectionEnd);
      this.restoreTextEditorSelection(editor);
      return true;
    }
    const marker = format === "bold" ? "**" : "*";
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const markerLength = this.markdownEmphasisMarkerLengthAroundSelection(editor, format);
    if (markerLength > 0) {
      editor.runs = this.mergeTextRuns([
        ...this.sliceTextRuns(editor.runs, 0, start - markerLength),
        ...this.sliceTextRuns(editor.runs, start, end),
        ...this.sliceTextRuns(editor.runs, end + markerLength, Number.POSITIVE_INFINITY)
      ]);
      editor.selectionStart = start - markerLength;
      editor.selectionEnd = end - markerLength;
      this.renderTextEditor(editor);
      this.setTextEditorSelection(editor, editor.selectionStart, editor.selectionEnd);
      this.restoreTextEditorSelection(editor);
      return true;
    }
    const markerStyle = this.textRunAt(editor.runs, start) ?? this.textRun("", editor.style);
    const before = this.sliceTextRuns(editor.runs, 0, start);
    const selected = this.sliceTextRuns(editor.runs, start, end);
    const after = this.sliceTextRuns(editor.runs, end, Number.POSITIVE_INFINITY);
    editor.runs = this.mergeTextRuns([
      ...before,
      { ...markerStyle, text: marker },
      ...selected,
      { ...markerStyle, text: marker },
      ...after
    ]);
    editor.selectionStart = start + marker.length;
    editor.selectionEnd = end + marker.length;
    this.renderTextEditor(editor);
    this.setTextEditorSelection(editor, editor.selectionStart, editor.selectionEnd);
    this.restoreTextEditorSelection(editor);
    return true;
  }

  private markdownEmphasisMarkerLengthAroundSelection(editor: ActiveTextEditor, format: "bold" | "italic"): number {
    const text = editor.runs.map((run) => run.text).join("");
    const countMarkers = (start: number, direction: -1 | 1): number => {
      let count = 0;
      for (let index = start; text[index] === "*"; index += direction) count += 1;
      return count;
    };
    const before = countMarkers(editor.selectionStart - 1, -1);
    const after = countMarkers(editor.selectionEnd, 1);
    if (format === "bold") return before >= 2 && after >= 2 ? 2 : 0;
    return (before === 1 && after === 1) || (before >= 3 && after >= 3) ? 1 : 0;
  }

  private markdownEmphasisMarkerLengthAtCaret(editor: ActiveTextEditor, format: "bold" | "italic"): number {
    const text = editor.runs.map((run) => run.text).join("");
    const countMarkers = (direction: -1 | 1): number => {
      let count = 0;
      for (let index = editor.selectionStart + (direction < 0 ? -1 : 0);
        text[index] === "*";
        index += direction) count += 1;
      return count;
    };
    const before = countMarkers(-1);
    const after = countMarkers(1);
    if (format === "bold") return before >= 2 && after >= 2 ? 2 : 0;
    return (before === 1 && after === 1) || (before >= 3 && after >= 3) ? 1 : 0;
  }

  private activeTextColor(): string | undefined {
    const editor = this.activeTextEditor;
    if (editor) {
      this.captureTextEditorSelection(editor);
      if (editor.selectionStart === editor.selectionEnd) return undefined;
      let position = 0;
      for (const run of editor.runs) {
        if (editor.selectionStart < position + run.text.length) return run.color;
        position += run.text.length;
      }
    }
    return this.selectedTexts[0]?.color ?? this.selected[0]?.color;
  }

  private styleTextAnnotation(annotation: PdfTextAnnotation, patch: Partial<ToolPreferences["text"]>): PdfTextAnnotation {
    const style = { ...this.textStyle(annotation), ...patch };
    return {
      ...annotation,
      ...style,
      runs: this.applyTextRunStyle(this.textRuns(annotation, style), 0, annotation.text.length, patch),
      sourceRuns: this.applyTextRunStyle(
        this.textSourceRuns(annotation, style),
        0,
        this.textSourceRuns(annotation, style).reduce((length, run) => length + run.text.length, 0),
        patch
      ),
      updatedAt: new Date().toISOString()
    };
  }

  private styleSelectedTextAnnotations(patch: Partial<ToolPreferences["text"]>): boolean {
    if (!this.selectedTexts.length) return false;
    const before = this.selectedTexts;
    const after = before.map((annotation) => this.styleTextAnnotation(annotation, patch));
    this.history.execute({
      label: "Style selected text",
      execute: () => before.forEach((annotation, index) => this.replaceTextAnnotation(annotation, after[index]!)),
      undo: () => after.forEach((annotation, index) => this.replaceTextAnnotation(annotation, before[index]!))
    });
    this.selectedTexts = after;
    if (after.length === 1) this.selectionShape = { type: "rectangle", bounds: this.textBounds(after[0]!) };
    this.ensureSelectionToolbar();
    return true;
  }

  private textStyle(annotation: PdfTextAnnotation | undefined, fallback = this.options.settings.toolPreferences.text): ToolPreferences["text"] {
    return {
      color: annotation?.color ?? fallback.color,
      fontSize: annotation?.fontSize ?? fallback.fontSize,
      fontFamily: annotation?.fontFamily ?? fallback.fontFamily,
      bold: annotation?.bold ?? fallback.bold,
      italic: annotation?.italic ?? fallback.italic
    };
  }

  private textRun(text: string, style: ToolPreferences["text"]): PdfTextRun {
    return {
      text, color: style.color, fontSize: style.fontSize, fontFamily: style.fontFamily,
      bold: style.bold, italic: style.italic, strikethrough: false
    };
  }

  private textRuns(annotation: PdfTextAnnotation | undefined, fallback: ToolPreferences["text"]): PdfTextRun[] {
    if (annotation?.runs?.length) return annotation.runs.map((run) => ({
      ...run, strikethrough: run.strikethrough ?? false
    }));
    return [this.textRun(annotation?.text ?? "", this.textStyle(annotation, fallback))];
  }

  private textSourceRuns(annotation: PdfTextAnnotation | undefined, fallback: ToolPreferences["text"]): PdfTextRun[] {
    if (annotation?.sourceRuns?.length) {
      return annotation.sourceRuns.map((run) => ({
        ...run, strikethrough: run.strikethrough ?? false
      }));
    }
    return this.markdownSourceRuns(this.textRuns(annotation, fallback));
  }

  private markdownEmphasisMarker(style: Pick<PdfTextRun, "bold" | "italic">): string {
    return style.bold && style.italic ? "***" : style.bold ? "**" : style.italic ? "*" : "";
  }

  private markdownSourceRuns(runs: readonly PdfTextRun[]): PdfTextRun[] {
    const source: PdfTextRun[] = [];
    for (const run of runs) {
      const emphasis = this.markdownEmphasisMarker(run);
      const prefix = `${run.strikethrough ? "~~" : ""}${emphasis}`;
      const suffix = `${emphasis}${run.strikethrough ? "~~" : ""}`;
      const style = { ...run, bold: false, italic: false, strikethrough: false };
      if (prefix) source.push({ ...style, text: prefix });
      source.push({ ...style, text: run.text });
      if (suffix) source.push({ ...style, text: suffix });
    }
    return this.mergeTextRuns(source);
  }

  private applyTextRunStyle(
    runs: readonly PdfTextRun[],
    start: number,
    end: number,
    patch: Partial<ToolPreferences["text"]>
  ): PdfTextRun[] {
    let position = 0;
    const styled: PdfTextRun[] = [];
    for (const run of runs) {
      const runStart = position;
      const runEnd = position + run.text.length;
      const selectedStart = Math.max(start, runStart);
      const selectedEnd = Math.min(end, runEnd);
      if (selectedStart >= selectedEnd) styled.push({ ...run });
      else {
        const before = run.text.slice(0, selectedStart - runStart);
        const selected = run.text.slice(selectedStart - runStart, selectedEnd - runStart);
        const after = run.text.slice(selectedEnd - runStart);
        if (before) styled.push({ ...run, text: before });
        if (selected) styled.push({ ...run, ...patch, text: selected });
        if (after) styled.push({ ...run, text: after });
      }
      position = runEnd;
    }
    return this.mergeTextRuns(styled);
  }

  private normalizeTextRuns(
    runs: readonly PdfTextRun[],
    text: string,
    fallback = this.options.settings.toolPreferences.text
  ): PdfTextRun[] {
    const trimmed = this.trimTextRuns(runs);
    const normalized = trimmed.reduce((joined, run) => joined + run.text, "") === text
      ? trimmed
      : [this.textRun(text, fallback)];
    return this.parseMarkdownTextRuns(normalized);
  }

  private isMarkdownDelimiterOnly(text: string): boolean {
    return text.trim().length > 0 && /^[*_~\s]+$/.test(text);
  }

  private trimTextRuns(runs: readonly PdfTextRun[]): PdfTextRun[] {
    const trimmed = this.mergeTextRuns(runs).map((run) => ({ ...run }));
    while (trimmed[0]?.text) {
      const text = trimmed[0].text.replace(/^\s+/, "");
      if (text) {
        trimmed[0].text = text;
        break;
      }
      trimmed.shift();
    }
    while (trimmed.at(-1)?.text) {
      const last = trimmed.at(-1)!;
      const text = last.text.replace(/\s+$/, "");
      if (text) {
        last.text = text;
        break;
      }
      trimmed.pop();
    }
    return this.mergeTextRuns(trimmed);
  }

  private parseMarkdownTextRuns(runs: readonly PdfTextRun[]): PdfTextRun[] {
    return this.markdownTextRuns(runs, false);
  }

  private previewMarkdownTextRuns(runs: readonly PdfTextRun[]): PdfTextRun[] {
    return this.markdownTextRuns(runs, true);
  }

  private markdownTextRuns(runs: readonly PdfTextRun[], retainMarkers: boolean): PdfTextRun[] {
    const source = runs.map((run) => run.text).join("");
    if (!source.includes("*") && !source.includes("_") && !source.includes("#") && !source.includes("~")) {
      return this.mergeTextRuns(runs);
    }
    const characters: Array<{ text: string; style: PdfTextRun }> = [];
    for (const run of runs) {
      for (const text of run.text) characters.push({ text, style: run });
    }
    const parsed: PdfTextRun[] = [];
    const append = (
      text: string,
      sourceIndex: number,
      bold: boolean,
      italic: boolean,
      strikethrough: boolean,
      headingLevel?: number
    ): void => {
      const style = characters[sourceIndex]?.style;
      if (!style) return;
      parsed.push({
        ...style,
        text,
        bold: style.bold || bold,
        italic: style.italic || italic,
        strikethrough: style.strikethrough || strikethrough,
        fontSize: headingLevel ? this.headingFontSize(style.fontSize, headingLevel) : style.fontSize
      });
    };
    const appendMarker = (start: number, end: number): void => {
      if (!retainMarkers) return;
      for (let index = start; index < end; index += 1) append(source[index]!, index, false, false, false);
    };
    const parseRange = (
      start: number,
      end: number,
      bold: boolean,
      italic: boolean,
      strikethrough: boolean,
      headingLevel?: number
    ): void => {
      for (let index = start; index < end;) {
        const heading = (index === 0 || source[index - 1] === "\n")
          ? /^(#{1,6})[ \t]+/.exec(source.slice(index, end))
          : null;
        if (heading) {
          const markerEnd = index + heading[0].length;
          const lineEnd = source.indexOf("\n", markerEnd);
          appendMarker(index, markerEnd);
          parseRange(
            markerEnd, lineEnd === -1 || lineEnd > end ? end : lineEnd,
            true, italic, strikethrough, heading[1]!.length
          );
          index = lineEnd === -1 || lineEnd > end ? end : lineEnd;
          continue;
        }
        const marker = ["***", "___", "**", "__", "~~", "*", "_"].find((candidate) => source.startsWith(candidate, index));
        const closing = marker ? source.indexOf(marker, index + marker.length) : -1;
        if (marker && closing > index + marker.length && closing < end) {
          appendMarker(index, index + marker.length);
          parseRange(
            index + marker.length,
            closing,
            bold || marker.includes("**") || marker.includes("__"),
            italic || marker.length === 1 || marker.length === 3,
            strikethrough || marker === "~~",
            headingLevel
          );
          appendMarker(closing, closing + marker.length);
          index = closing + marker.length;
          continue;
        }
        append(source[index]!, index, bold, italic, strikethrough, headingLevel);
        index += 1;
      }
    };
    parseRange(0, source.length, false, false, false);
    return this.mergeTextRuns(parsed);
  }

  private headingFontSize(fontSize: number, level: number): number {
    const scale = [1.7, 1.45, 1.25, 1.1, 1, 1][Math.min(level, 6) - 1] ?? 1;
    return Math.round(fontSize * scale * 10) / 10;
  }

  private mergeTextRuns(runs: readonly PdfTextRun[]): PdfTextRun[] {
    const merged: PdfTextRun[] = [];
    for (const run of runs) {
      const previous = merged.at(-1);
        if (previous && previous.color === run.color && previous.fontSize === run.fontSize && previous.fontFamily === run.fontFamily &&
          previous.bold === run.bold && previous.italic === run.italic &&
          previous.strikethrough === run.strikethrough) previous.text += run.text;
      else if (run.text) merged.push({ ...run });
    }
    return merged;
  }

  private sameTextRuns(left: readonly PdfTextRun[], right: readonly PdfTextRun[]): boolean {
    return left.length === right.length && left.every((run, index) => {
      const other = right[index];
      return other !== undefined && run.text === other.text && run.color === other.color &&
        run.fontSize === other.fontSize && run.fontFamily === other.fontFamily &&
        run.bold === other.bold && run.italic === other.italic &&
        run.strikethrough === other.strikethrough;
    });
  }

  private renderTextEditor(editor: ActiveTextEditor): void {
    const surface = this.surfaces.get(editor.page);
    if (!surface) return;
    editor.input.replaceChildren();
    const previewRuns = this.previewMarkdownTextRuns(editor.runs);
    let sourceRunIndex = 0;
    let sourceOffset = 0;
    for (const run of previewRuns) {
      let remaining = run.text;
      while (remaining) {
        const source = editor.runs[sourceRunIndex];
        if (!source) break;
        const sourceRemaining = source.text.length - sourceOffset;
        if (sourceRemaining <= 0) {
          sourceRunIndex += 1;
          sourceOffset = 0;
          continue;
        }
        const text = remaining.slice(0, sourceRemaining);
        this.appendTextEditorRun(editor.input, surface, text, run, source);
        remaining = remaining.slice(text.length);
        sourceOffset += text.length;
        if (sourceOffset === source.text.length) {
          sourceRunIndex += 1;
          sourceOffset = 0;
        }
      }
    }
  }

  private appendTextEditorRun(
    input: HTMLDivElement,
    surface: PageSurface,
    text: string,
    preview: PdfTextRun,
    source: PdfTextRun
  ): void {
    if (!text) return;
    const span = input.ownerDocument.createElement("span");
    span.dataset.nativePdfHandwritingTextRun = "true";
    span.dataset.color = source.color;
    span.dataset.fontSize = String(source.fontSize);
    span.dataset.fontFamily = source.fontFamily;
    span.dataset.bold = String(source.bold);
    span.dataset.italic = String(source.italic);
    span.dataset.strikethrough = String(source.strikethrough);
    span.style.color = preview.color;
    span.style.fontSize = `${preview.fontSize * this.displayScale(surface)}px`;
    span.style.fontFamily = preview.fontFamily;
    span.style.fontWeight = preview.bold ? "700" : "400";
    span.style.fontStyle = preview.italic ? "italic" : "normal";
    span.style.textDecorationLine = preview.strikethrough ? "line-through" : "none";
    span.textContent = text;
    input.append(span);
  }

  private readTextEditorRuns(editor: ActiveTextEditor): PdfTextRun[] {
    const runs: PdfTextRun[] = [];
    const append = (node: Node, inherited: PdfTextRun): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent) runs.push({ ...inherited, text: node.textContent });
        return;
      }
      if (!(node instanceof HTMLElement)) return;
      if (node.tagName === "BR") {
        runs.push({ ...inherited, text: "\n" });
        return;
      }
      const style = node.dataset.nativePdfHandwritingTextRun === "true"
        ? {
            text: "",
            color: node.dataset.color ?? inherited.color,
            fontSize: Number(node.dataset.fontSize) || inherited.fontSize,
            fontFamily: node.dataset.fontFamily ?? inherited.fontFamily,
            bold: node.dataset.bold === "true",
            italic: node.dataset.italic === "true",
            strikethrough: node.dataset.strikethrough === "true"
          }
        : inherited;
      for (const child of node.childNodes) append(child, style);
    };
    const fallback = this.textRun("", editor.style);
    for (const child of editor.input.childNodes) append(child, fallback);
    return this.mergeTextRuns(runs);
  }

  private captureTextEditorSelection(editor: ActiveTextEditor): void {
    const selection = editor.input.ownerDocument.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!this.isTextEditorNode(editor.input, range.startContainer) || !this.isTextEditorNode(editor.input, range.endContainer)) return;
    editor.selectionStart = this.textEditorOffset(editor.input, range.startContainer, range.startOffset);
    editor.selectionEnd = this.textEditorOffset(editor.input, range.endContainer, range.endOffset);
  }

  private setTextEditorSelection(editor: ActiveTextEditor, start: number, end: number): void {
    const selection = editor.input.ownerDocument.getSelection();
    if (!selection) return;
    const range = editor.input.ownerDocument.createRange();
    const startPosition = this.textEditorPosition(editor.input, start);
    const endPosition = this.textEditorPosition(editor.input, end);
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset);
    selection.removeAllRanges();
    selection.addRange(range);
    editor.selectionStart = start;
    editor.selectionEnd = end;
  }

  private isTextEditorNode(input: HTMLDivElement, node: Node): boolean {
    return node === input || input.contains(node);
  }

  private textEditorOffset(input: HTMLDivElement, node: Node, offset: number): number {
    const range = input.ownerDocument.createRange();
    range.selectNodeContents(input);
    range.setEnd(node, offset);
    return range.toString().length;
  }

  private textEditorPosition(input: HTMLDivElement, offset: number): { node: Node; offset: number } {
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

  private insertTextIntoEditor(editor: ActiveTextEditor, text: string): void {
    this.captureTextEditorSelection(editor);
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const before = this.sliceTextRuns(editor.runs, 0, start);
    const after = this.sliceTextRuns(editor.runs, end, Number.POSITIVE_INFINITY);
    editor.runs = this.mergeTextRuns([...before, { ...this.textRun("", editor.style), text }, ...after]);
    editor.selectionStart = start + text.length;
    editor.selectionEnd = start + text.length;
    this.renderTextEditor(editor);
    this.setTextEditorSelection(editor, editor.selectionStart, editor.selectionEnd);
  }

  private sliceTextRuns(runs: readonly PdfTextRun[], start: number, end: number): PdfTextRun[] {
    const sliced: PdfTextRun[] = [];
    let position = 0;
    for (const run of runs) {
      const from = Math.max(0, start - position);
      const to = Math.min(run.text.length, end - position);
      if (from < to) sliced.push({ ...run, text: run.text.slice(from, to) });
      position += run.text.length;
    }
    return sliced;
  }

  private textRunAt(runs: readonly PdfTextRun[], offset: number): PdfTextRun | undefined {
    let position = 0;
    for (const run of runs) {
      if (offset <= position + run.text.length) return run;
      position += run.text.length;
    }
    return runs.at(-1);
  }

  private pointerStart(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void {
    const preferences = this.options.settings.toolPreferences;
    const rightMouseEraser = event.pointerType === "mouse" && event.button === 2 && preferences.eraser.eraseWithRightMouseButton;
    if (route === "edit" && preferences.activeTool === "lasso") {
      if (this.activeTextEditor && event.target !== this.activeTextEditor.input) {
        this.commitActiveTextInput();
        this.clearSelection();
        return;
      }
      const text = this.textAnnotationAt(surface, this.toPdfPoint(surface, samples[0]!, true));
      if (text) {
        const selected = this.selectionPage === surface.page.pageNumber && this.selectedTexts.some((item) => item.id === text.id);
        if (selected) {
          this.tryStartSelectionMove(surface, samples[0]!, text);
          this.renderPage(surface.page.pageNumber);
        } else {
          this.selected = [];
          this.selectedTexts = [text];
          this.selectionPage = surface.page.pageNumber;
          this.selectionShape = { type: "rectangle", bounds: this.textBounds(text) };
          this.ensureSelectionToolbar({ resetPlacement: true });
          this.renderPage(surface.page.pageNumber);
        }
        return;
      }
    }
    // Selected ink: drag inside selection moves it even when pen/pencil is active.
    if (!rightMouseEraser && this.tryStartSelectionMove(surface, samples[0]!)) {
      this.renderPage(surface.page.pageNumber);
      return;
    }
    if (route === "draw") {
      if (preferences.activeTool === "laser") {
        const laser = preferences.laser;
        surface.laserDraft = true;
        surface.builder = new StrokeBuilder({
          id: this.id(), page: surface.page.pageNumber, tool: "pen", color: laser.color,
          width: laser.width, opacity: laser.opacity,
          inputType: event.pointerType === "pen" ? "pen" : "mouse", stabilization: "medium"
        });
        for (const sample of samples) surface.builder.add(this.toPdfPoint(surface, sample, false));
        this.ensureLaserFadeLoop();
      } else {
        const tool = this.activeDrawingTool();
        const drawing = preferences[tool];
        surface.laserDraft = false;
        surface.builder = new StrokeBuilder({
          id: this.id(), page: surface.page.pageNumber, tool, color: drawing.color,
          width: drawing.width, opacity: drawing.opacity,
          inputType: event.pointerType === "pen" ? "pen" : "mouse", stabilization: drawing.stabilization
        });
        const points = samples.map((sample) => this.toPdfPoint(surface, sample, drawing.simulateMousePressure));
        for (const point of points) surface.builder.add(point);
        this.scheduleStraighten(surface, points.at(-1));
        const first = surface.builder.preview(this.simplifyStrokesEnabled())[0];
        if (first) {
          this.lastPointerPdf = { x: first.x, y: first.y };
          this.logDraw(surface, "start", tool, [first]);
        }
        this.logPositionAlign(surface, samples[0]!, "start");
      }
    } else {
      if (preferences.activeTool === "lasso" && this.selected.length > 0) {
        const point = this.toPdfPoint(surface, samples[0]!, true);
        if (!this.selectionShape || this.selectionPage !== surface.page.pageNumber || !shapeContainsPoint(this.selectionShape, point)) {
          this.clearSelection();
        }
      }
      surface.editTool = rightMouseEraser || preferences.activeTool === "eraser" ? "eraser" : "lasso";
      surface.eraserSize = surface.editTool === "eraser" ? preferences.eraser.size : undefined;
      surface.eraserWholeStrokes = surface.editTool === "eraser" ? preferences.eraser.eraseWholeStrokes : undefined;
      surface.editPath = samples.map((sample) => this.toPdfPoint(surface, sample, true));
      if (surface.editPath[0]) this.lastPointerPdf = { x: surface.editPath[0].x, y: surface.editPath[0].y };
    }
    this.renderPage(surface.page.pageNumber);
  }

  private pointerMove(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void {
    if (this.moveDrag?.page === surface.page.pageNumber) {
      const current = this.toPdfPoint(surface, samples.at(-1)!, true);
      const dx = current.x - this.moveDrag.start.x;
      const dy = current.y - this.moveDrag.start.y;
      this.movePreview = translateStrokes(this.moveDrag.before, dx, dy);
      this.moveTextPreview = this.translateTextAnnotations(this.moveDrag.beforeTexts, dx, dy);
      this.moveShapePreview = translateShape(this.moveDrag.beforeShape, dx, dy);
      this.updateDebug(surface, event);
      this.renderPage(surface.page.pageNumber);
      return;
    }
    if (route === "draw" && surface.builder) {
      const tool = this.activeDrawingTool();
      const simulate = surface.laserDraft ? false : this.options.settings.toolPreferences[tool].simulateMousePressure;
      const points = samples.map((sample) => this.toPdfPoint(surface, sample, simulate));
      this.addDrawPoints(surface, points);
      if (!surface.laserDraft) this.scheduleStraighten(surface, points.at(-1));
      else this.ensureLaserFadeLoop();
      const last = samples.at(-1);
      if (last) this.logPositionAlign(surface, last, "move");
    } else if (route === "edit") {
      surface.editPath.push(...samples.map((sample) => this.toPdfPoint(surface, sample, true)));
    }
    this.updateDebug(surface, event);
    this.renderPage(surface.page.pageNumber);
  }

  private pointerEnd(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void {
    this.cancelStraighten(surface);
    if (surface.textEditActive) {
      surface.textEditActive = false;
      return;
    }
    if (this.moveDrag?.page === surface.page.pageNumber) {
      const move = this.moveDrag;
      const current = this.toPdfPoint(surface, samples.at(-1)!, true);
      const dx = current.x - move.start.x;
      const dy = current.y - move.start.y;
      if (dx !== 0 || dy !== 0) {
        const after = translateStrokes(move.before, dx, dy);
        const afterTexts = this.translateTextAnnotations(move.beforeTexts, dx, dy);
        this.history.execute({
          label: "Move selection",
          execute: () => {
            after.forEach((stroke) => this.ink.replace(stroke));
            afterTexts.forEach((text, index) => this.replaceTextAnnotation(move.beforeTexts[index]!, text));
          },
          undo: () => {
            move.before.forEach((stroke) => this.ink.replace(stroke));
            move.beforeTexts.forEach((text, index) => this.replaceTextAnnotation(afterTexts[index]!, text));
          }
        });
        this.selected = after;
        this.selectedTexts = afterTexts;
        this.selectionShape = translateShape(move.beforeShape, dx, dy);
      }
      this.moveDrag = null;
      this.movePreview = null;
      this.moveTextPreview = null;
      this.moveShapePreview = null;
      if (dx === 0 && dy === 0 && move.openTextOnClick) this.openTextInput(surface, event, move.openTextOnClick);
      this.updateDebug(surface, event);
      this.renderPage(surface.page.pageNumber);
      return;
    }
    if (route === "draw" && surface.builder) {
      const laserDraft = surface.laserDraft;
      const tool = this.activeDrawingTool();
      const simulate = laserDraft ? false : this.options.settings.toolPreferences[tool].simulateMousePressure;
      this.addDrawPoints(surface, samples.map((sample) => this.toPdfPoint(surface, sample, simulate)));
      const stroke = surface.builder.finishMatchingPreview(laserDraft ? true : this.simplifyStrokesEnabled());
      if (laserDraft) {
        const laser = this.options.settings.toolPreferences.laser;
        this.laserTrails.push({ id: stroke.id, page: stroke.page, points: stroke.points, color: laser.color, width: laser.width, opacity: laser.opacity, holdMs: laser.holdMs, fadeMs: laser.fadeMs });
        this.ensureLaserFadeLoop();
      } else {
        this.history.execute(new AddStrokeCommand(this.ink, stroke));
      }
      this.lastPointerPdf = stroke.points.at(-1) ? { x: stroke.points.at(-1)!.x, y: stroke.points.at(-1)!.y } : this.lastPointerPdf;
      this.logDraw(surface, "end", laserDraft ? "laser" : tool, stroke.points);
      const last = samples.at(-1);
      if (last) this.logPositionAlign(surface, last, "end");
      surface.builder = undefined;
      surface.laserDraft = false;
      surface.straightenAnchor = undefined;
    } else if (route === "edit") {
      surface.editPath.push(...samples.map((sample) => this.toPdfPoint(surface, sample, true)));
      const tool = surface.editTool ?? this.options.settings.toolPreferences.activeTool;
      const phase = tool === "eraser" ? "eraser" : "lasso";
      const path = [...surface.editPath];
      this.finishEdit(surface);
      this.logDraw(surface, phase, tool, path);
      surface.editPath = [];
    }
    this.updateDebug(surface, event);
    this.renderPage(surface.page.pageNumber);
  }

  private addDrawPoints(surface: PageSurface, points: PdfPoint[]): void {
    const builder = surface.builder;
    if (!builder || points.length === 0) return;
    const last = points.at(-1)!;
    if (builder.isStraightened() && surface.straightenAnchor && this.isStraightenJitter(last, surface.straightenAnchor)) return;
    if (builder.updateStraightenedEndpoint(last)) {
      surface.straightenAnchor = last;
      return;
    }
    for (const point of points) builder.add(point);
  }

  private scheduleStraighten(surface: PageSurface, point: PdfPoint | undefined): void {
    if (!this.options.settings.holdToStraighten || !surface.builder) return;
    if (surface.builder.isStraightened()) return;
    if (point && surface.straightenAnchor && this.isStraightenJitter(point, surface.straightenAnchor)) return;
    this.cancelStraighten(surface);
    surface.straightenAnchor = point;
    surface.straightenTimer = window.setTimeout(() => {
      surface.straightenTimer = null;
      if (!this.options.settings.holdToStraighten || !surface.builder?.straighten()) return;
      this.renderPage(surface.page.pageNumber);
    }, 1000);
  }

  private cancelStraighten(surface: PageSurface): void {
    if (surface.straightenTimer === null) return;
    window.clearTimeout(surface.straightenTimer);
    surface.straightenTimer = null;
  }

  private resetStraighten(surface: PageSurface): void {
    this.cancelStraighten(surface);
    surface.straightenAnchor = undefined;
  }

  private isStraightenJitter(point: PdfPoint, anchor: PdfPoint): boolean {
    return Math.hypot(point.x - anchor.x, point.y - anchor.y) <= 4;
  }

  private pointerCancel(surface: PageSurface, event: PointerEvent, reason?: "multi-touch"): void {
    this.moveDrag = null;
    this.movePreview = null;
    this.moveTextPreview = null;
    this.moveShapePreview = null;
    this.resetStraighten(surface);
    surface.builder = undefined;
    surface.laserDraft = false;
    surface.editPath = [];
    surface.editTool = undefined;
    surface.textEditActive = false;
    surface.eraserSize = undefined;
    surface.eraserWholeStrokes = undefined;
    this.updateDebug(surface, event);
    // A two-finger gesture immediately enters zoom compositing; rendering the cancelled
    // one-finger preview here races that layout update and produces a visible flash.
    if (reason === "multi-touch") return;
    this.renderPage(surface.page.pageNumber);
  }

  private finishEdit(surface: PageSurface): void {
    const preferences = this.options.settings.toolPreferences;
    const editTool = surface.editTool;
    const eraserSize = surface.eraserSize;
    const eraserWholeStrokes = surface.eraserWholeStrokes;
    surface.editTool = undefined;
    surface.eraserSize = undefined;
    surface.eraserWholeStrokes = undefined;
    if (editTool === "eraser" && eraserSize !== undefined) {
      const erase = eraserWholeStrokes ? eraseWholeStrokes : eraseStrokes;
      const result = erase(this.ink.page(surface.page.pageNumber), surface.editPath, eraserSize, {
        createFragmentId: () => this.id()
      });
      if (result.erased.length) {
        this.clearSelection();
        this.history.execute(new ReplacePageStrokesCommand(this.ink, surface.page.pageNumber, this.ink.page(surface.page.pageNumber), result.kept));
      }
      return;
    }
    if (editTool !== "lasso" || surface.editPath.length < 2) return;
    const lassoType = preferences.lasso.type;
    const editPath = lassoType === "freeform" && surface.editPath.length > 24
      ? simplifyPoints(surface.editPath, 0.75)
      : surface.editPath;
    const xs = editPath.map((point) => point.x);
    const ys = editPath.map((point) => point.y);
    const bounds = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    const shape: SelectionShape = lassoType === "freeform"
      ? { type: "freeform", points: editPath }
      : { type: lassoType, bounds };
    if (selectionShapeArea(shape) < 16) {
      this.clearSelection();
      return;
    }
    const layout = this.pageLayout(surface);
    const mapper = this.mapper(surface);
    const matched = selectStrokes(this.ink.page(surface.page.pageNumber), shape);
    this.selected = filterSelectableStrokes(
      matched,
      layout.pdfWidth,
      layout.pdfHeight,
      layout.scale,
      layout.contentWidth,
      layout.contentHeight,
      (point) => mapper.toViewport(point)
    );
    if (matched.length && !this.selected.length) {
      this.logger.lassoSelectionFiltered(surface.page.pageNumber, matched.length, {
        pdfWidth: layout.pdfWidth,
        pdfHeight: layout.pdfHeight,
        contentWidth: layout.contentWidth,
        contentHeight: layout.contentHeight,
        livePageWidth: surface.page.width,
        livePageHeight: surface.page.height
      });
    }
    this.selectedTexts = (this.textAnnotations.get(surface.page.pageNumber) ?? []).filter((annotation) => this.textMatchesSelection(annotation, shape));
    if (!this.selected.length && !this.selectedTexts.length) {
      this.clearSelection();
      return;
    }
    this.selectionShape = shape;
    this.selectionPage = surface.page.pageNumber;
    this.invalidateInkLayer(surface);
    this.logger.lassoSelection(surface.page.pageNumber, this.selected.length + this.selectedTexts.length, editPath.length, shape.type);
    this.ensureSelectionToolbar({ resetPlacement: true });
  }

  private tryStartSelectionMove(surface: PageSurface, sample: PointerSample, openTextOnClick?: PdfTextAnnotation): boolean {
    if (!this.selectionShape || this.selectionPage !== surface.page.pageNumber || (!this.selected.length && !this.selectedTexts.length)) return false;
    const point = this.toPdfPoint(surface, sample, true);
    if (!shapeContainsPoint(this.selectionShape, point)) return false;
    const move = {
      page: surface.page.pageNumber,
      start: point,
      before: this.selected.map((stroke) => structuredClone(stroke)),
      beforeTexts: this.selectedTexts.map((text) => structuredClone(text)),
      beforeShape: structuredClone(this.selectionShape),
      ...(openTextOnClick ? { openTextOnClick } : {})
    };
    this.moveDrag = move;
    this.movePreview = move.before;
    this.moveTextPreview = move.beforeTexts;
    this.moveShapePreview = move.beforeShape;
    return true;
  }

  private translateTextAnnotations(texts: readonly PdfTextAnnotation[], dx: number, dy: number): PdfTextAnnotation[] {
    const updatedAt = new Date().toISOString();
    return texts.map((text) => ({ ...text, x: text.x + dx, y: text.y + dy, updatedAt }));
  }

  private deleteSelection(): void {
    this.reconcileSelection();
    if (!this.selected.length && !this.selectedTexts.length) return;
    if (this.activeTextEditor?.annotationId && this.selectedTexts.some((text) => text.id === this.activeTextEditor?.annotationId)) {
      this.cancelActiveTextInput();
    }
    const strokes = [...this.selected];
    const texts = [...this.selectedTexts];
    this.history.execute({
      label: "Delete selection",
      execute: () => {
        strokes.forEach((stroke) => this.ink.remove(stroke.id));
        texts.forEach((text) => this.removeTextAnnotation(text));
      },
      undo: () => {
        strokes.forEach((stroke) => this.ink.add(stroke));
        texts.forEach((text) => this.addTextAnnotation(text));
      }
    });
    this.clearSelection();
  }

  private copySelection(): void {
    if (!this.selected.length) return;
    StrokeClipboard.store(this.selected, this.selectionPage ?? this.options.adapter.getViewState().pageNumber);
    this.pasteGeneration = 0;
  }

  private cutSelection(): void {
    this.copySelection();
    this.deleteSelection();
  }

  private pasteSelection(): void {
    const clipboard = StrokeClipboard.peek();
    if (!clipboard?.strokes.length) return;
    this.pasteGeneration += 1;
    const targetPage = this.selectionPage ?? this.options.adapter.getViewState().pageNumber;
    const dx = 10 * this.pasteGeneration;
    const dy = -10 * this.pasteGeneration;
    const now = new Date().toISOString();
    const pasted = translateStrokes(clipboard.strokes, dx, dy, now).map((stroke) => ({
      ...stroke,
      id: this.id(),
      page: targetPage,
      createdAt: now
    }));
    this.history.execute(new AddStrokesCommand(this.ink, pasted));
    this.selected = pasted;
    this.selectionPage = targetPage;
    this.selectionShape = boundingShapeFromStrokes(pasted);
    this.moveDrag = null;
    this.movePreview = null;
    this.moveTextPreview = null;
    this.moveShapePreview = null;
    this.ensureSelectionToolbar({ resetPlacement: true });
    this.refresh("paste-selection");
  }

  private duplicateSelection(): void {
    if (this.activeTextEditor?.annotationId) this.commitActiveTextInput();
    this.reconcileSelection();
    if (!this.selected.length && !this.selectedTexts.length) return;
    const duplicates = translateStrokes(this.selected, 10, -10).map((stroke) => ({ ...stroke, id: this.id() }));
    const now = new Date().toISOString();
    const textDuplicates = this.selectedTexts.map((text) => ({
      ...structuredClone(text), id: this.id(), x: text.x + 10, y: text.y - 10, createdAt: now, updatedAt: now
    }));
    const command: Command = {
      label: "Duplicate selection",
      execute: () => {
        duplicates.forEach((stroke) => this.ink.add(stroke));
        textDuplicates.forEach((text) => this.addTextAnnotation(text));
      },
      undo: () => {
        duplicates.forEach((stroke) => this.ink.remove(stroke.id));
        textDuplicates.forEach((text) => this.removeTextAnnotation(text));
      }
    };
    this.history.execute(command);
    this.selected = duplicates;
    this.selectedTexts = textDuplicates;
    this.selectionShape = duplicates.length
      ? boundingShapeFromStrokes(duplicates)
      : textDuplicates.length ? { type: "rectangle", bounds: this.textBounds(textDuplicates[0]!) } : null;
    this.ensureSelectionToolbar();
  }

  private recolorSelection(color: string): boolean {
    if (!this.selected.length) return false;
    const now = new Date().toISOString();
    const after = this.selected.map((stroke) => ({ ...stroke, color, updatedAt: now }));
    this.history.execute(new ReplaceStrokesCommand(this.ink, this.selected, after));
    this.selected = after;
    this.toolbar.refresh();
    return true;
  }

  private resizeSelection(width: number): boolean {
    if (!this.selected.length) return false;
    const now = new Date().toISOString();
    const after = this.selected.map((stroke) => ({ ...stroke, width, updatedAt: now }));
    this.history.execute(new ReplaceStrokesCommand(this.ink, this.selected, after));
    this.selected = after;
    this.toolbar.refresh();
    return true;
  }

  private selectAllOnCurrentPage(): void {
    const pageNumber = this.options.adapter.getViewState().pageNumber;
    const surface = this.surfaces.get(pageNumber);
    const pageStrokes = this.ink.page(pageNumber);
    if (!surface || !pageStrokes.length) {
      this.clearSelection();
      this.logger.refresh("select-all", { selected: 0, page: pageNumber, empty: true });
      return;
    }
    const layout = this.pageLayout(surface);
    const mapper = this.mapper(surface);
    const selected = filterSelectableStrokes(
      pageStrokes,
      layout.pdfWidth,
      layout.pdfHeight,
      layout.scale,
      layout.contentWidth,
      layout.contentHeight,
      (point) => mapper.toViewport(point)
    );
    if (!selected.length) {
      this.clearSelection();
      this.logger.refresh("select-all", { selected: 0, page: pageNumber, filtered: true });
      return;
    }
    this.selected = selected;
    this.selectionShape = boundingShapeFromStrokes(selected);
    this.selectionPage = pageNumber;
    this.ensureSelectionToolbar({ resetPlacement: true });
    this.refresh("select-all");
  }

  private clearSelection(): void {
    this.selected = [];
    this.selectedTexts = [];
    this.selectionShape = null;
    this.selectionPage = null;
    this.moveDrag = null;
    this.movePreview = null;
    this.moveTextPreview = null;
    this.moveShapePreview = null;
    this.selectionToolbar.hide();
    this.toolbar.refresh();
    this.refresh("clear-selection");
  }

  private reconcileSelection(): void {
    if ((!this.selected.length && !this.selectedTexts.length) || this.selectionPage === null) return;
    const pageStrokes = this.ink.page(this.selectionPage);
    const byId = new Map(pageStrokes.map((stroke) => [stroke.id, stroke]));
    const synced = this.selected
      .map((stroke) => byId.get(stroke.id))
      .filter((stroke): stroke is InkStroke => stroke !== undefined);
    const textsById = new Map((this.textAnnotations.get(this.selectionPage) ?? []).map((text) => [text.id, text]));
    const syncedTexts = this.selectedTexts
      .map((text) => textsById.get(text.id))
      .filter((text): text is PdfTextAnnotation => text !== undefined);
    if (!synced.length && !syncedTexts.length) {
      this.selected = [];
      this.selectedTexts = [];
      this.selectionShape = null;
      this.selectionPage = null;
      this.moveDrag = null;
      this.movePreview = null;
      this.moveTextPreview = null;
      this.moveShapePreview = null;
      this.selectionToolbar.hide();
      return;
    }
    if (synced.length !== this.selected.length || synced.some((stroke, index) => stroke !== this.selected[index])) {
      this.selected = synced;
      this.selectionShape = boundingShapeFromStrokes(synced) ?? this.selectionShape;
    }
    this.selectedTexts = syncedTexts;
  }

  private invalidateInkLayer(surface: PageSurface): void {
    surface.inkLayerValid = false;
  }

  private invalidateInkLayers(): void {
    for (const surface of this.surfaces.values()) surface.inkLayerValid = false;
  }

  private ensureInkLayer(
    surface: PageSurface,
    pixelWidth: number,
    pixelHeight: number,
    backingScale: number
  ): CanvasRenderingContext2D {
    if (!surface.inkLayer || !surface.inkLayerContext) {
      surface.inkLayer = surface.overlay.ownerDocument.createElement("canvas");
      surface.inkLayerContext = surface.inkLayer.getContext("2d");
      if (!surface.inkLayerContext) throw new Error("Canvas 2D rendering is unavailable");
      surface.inkLayerValid = false;
    }
    if (surface.inkLayer.width !== pixelWidth || surface.inkLayer.height !== pixelHeight) {
      surface.inkLayer.width = pixelWidth;
      surface.inkLayer.height = pixelHeight;
      surface.inkLayerValid = false;
    }
    surface.inkLayerContext.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    return surface.inkLayerContext;
  }

  /** Warm inkLayer from main canvas before zoom burst CSS-stretch. */
  private captureInkLayerFromCanvas(surface: PageSurface): void {
    if (surface.inkLayerValid && surface.inkLayer) return;
    if (!surface.canvas.width || !surface.canvas.height) return;
    const layout = this.pageLayout(surface);
    const rect = surface.overlay.getBoundingClientRect();
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    const { backingScale } = inkBackingSize(width, height, window.devicePixelRatio || 1);
    const layerContext = this.ensureInkLayer(surface, surface.canvas.width, surface.canvas.height, backingScale);
    layerContext.setTransform(1, 0, 0, 1, 0, 0);
    layerContext.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
    layerContext.drawImage(surface.canvas, 0, 0);
    layerContext.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    surface.inkLayerValid = true;
  }

  /** Copy committed bitmap before canvas/layer resize clears pixels. */
  private snapshotCommittedBitmap(surface: PageSurface): HTMLCanvasElement | null {
    const src = surface.inkLayerValid && surface.inkLayer
      ? surface.inkLayer
      : surface.canvas;
    if (!src.width || !src.height) return null;
    const snap = surface.overlay.ownerDocument.createElement("canvas");
    snap.width = src.width;
    snap.height = src.height;
    const ctx = snap.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0);
    return snap;
  }

  private blitInkLayerToCanvas(
    surface: PageSurface,
    pixelWidth: number,
    pixelHeight: number,
    backingScale: number
  ): void {
    if (!surface.inkLayer) return;
    surface.context.setTransform(1, 0, 0, 1, 0, 0);
    surface.context.clearRect(0, 0, pixelWidth, pixelHeight);
    surface.context.drawImage(surface.inkLayer, 0, 0);
    surface.context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
  }

  private queueInkLayerUpgrade(pageNumber: number): void {
    this.inkUpgradePages.add(pageNumber);
    if (this.inkUpgradeTimer !== null) {
      window.clearTimeout(this.inkUpgradeTimer);
      this.inkUpgradeTimer = null;
    }
    this.inkUpgradeTimer = window.setTimeout(() => {
      this.inkUpgradeTimer = null;
      this.drainInkLayerUpgrades();
    }, ViewerInkSession.INK_UPGRADE_MS);
  }

  private drainInkLayerUpgrades(): void {
    if (this.destroyed || this.zoomCompositing) return;
    const next = this.inkUpgradePages.values().next();
    if (next.done) return;
    const pageNumber = next.value;
    this.inkUpgradePages.delete(pageNumber);
    const surface = this.surfaces.get(pageNumber);
    if (!surface || surface.builder || surface.editPath.length > 0) {
      if (surface && (surface.builder || surface.editPath.length > 0)) {
        this.inkUpgradePages.add(pageNumber);
      }
      if (this.inkUpgradePages.size > 0) this.queueInkLayerUpgrade([...this.inkUpgradePages][0]!);
      return;
    }
    surface.inkLayerValid = false;
    this.renderPage(pageNumber, undefined, "ink-upgrade");
    if (this.inkUpgradePages.size > 0) {
      // One page per turn — keep UI responsive while upgrading remainder.
      this.inkUpgradeTimer = window.setTimeout(() => {
        this.inkUpgradeTimer = null;
        this.drainInkLayerUpgrades();
      }, 0);
    }
  }

  private cancelInkLayerUpgrades(): void {
    if (this.inkUpgradeTimer !== null) {
      window.clearTimeout(this.inkUpgradeTimer);
      this.inkUpgradeTimer = null;
    }
    this.inkUpgradePages.clear();
  }

  private paintCommittedStrokes(
    surface: PageSurface,
    context: CanvasRenderingContext2D,
    strokes: readonly InkStroke[],
    stats?: { strokesRedrawn: number },
    graphiteQuality: "full" | "draft" = "full"
  ): void {
    const previous = surface.context;
    surface.context = context;
    try {
      for (const stroke of strokes) {
        const drawn = this.movePreview?.find((item) => item.id === stroke.id) ?? stroke;
        this.drawStroke(surface, drawn, this.selected.some((item) => item.id === stroke.id), graphiteQuality);
      }
    } finally {
      surface.context = previous;
    }
    if (stats) stats.strokesRedrawn += strokes.length;
  }

  private renderPage(
    pageNumber: number,
    stats?: { canvasesResized: number; strokesRedrawn: number },
    reason = ""
  ): void {
    const surface = this.surfaces.get(pageNumber);
    if (!surface || this.zoomCompositing) return;
    const layout = this.pageLayout(surface);
    this.syncOverlayLayout(surface);
    const rect = surface.overlay.getBoundingClientRect();
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    if (width < 2 || height < 2) return;
    const { pixelWidth, pixelHeight, backingScale } = inkBackingSize(
      width,
      height,
      window.devicePixelRatio || 1
    );
    const needsResize = surface.canvas.width !== pixelWidth || surface.canvas.height !== pixelHeight;
    const canBlit = typeof surface.context.drawImage === "function";
    const zoomish = ViewerInkSession.isZoomPaintReason(reason);
    const erasingLive = surface.editTool === "eraser" && surface.eraserSize !== undefined && surface.editPath.length > 0;
    const movingSelection = Boolean(this.movePreview?.length);
    const livePreview = Boolean(surface.builder?.preview().length)
      || (surface.editTool === "lasso" && surface.editPath.length > 0)
      || Boolean(this.selectionShape && this.selectionPage === pageNumber);

    // pages-dom storms + idle zoomed pages: layout sync only — skip giant canvas blit.
    if (
      !needsResize
      && surface.inkLayerValid
      && !erasingLive
      && !movingSelection
      && !livePreview
      && (reason.includes("pages-sync") || reason.includes("pages-reattach"))
    ) {
      return;
    }

    let scaledBlit: HTMLCanvasElement | null = null;
    if (needsResize && canBlit) {
      scaledBlit = this.snapshotCommittedBitmap(surface);
    }

    if (needsResize) {
      surface.canvas.width = pixelWidth;
      surface.canvas.height = pixelHeight;
      surface.inkLayerValid = false;
      if (stats) stats.canvasesResized += 1;
    }
    surface.context.setTransform(backingScale, 0, 0, backingScale, 0, 0);

    // Immediate scaled ink so zoom settle never flashes empty while HQ rebuilds.
    if (scaledBlit) {
      surface.context.setTransform(1, 0, 0, 1, 0, 0);
      surface.context.clearRect(0, 0, pixelWidth, pixelHeight);
      surface.context.drawImage(
        scaledBlit,
        0,
        0,
        scaledBlit.width,
        scaledBlit.height,
        0,
        0,
        pixelWidth,
        pixelHeight
      );
      surface.context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    }

    const storedStrokes = this.ink.page(pageNumber);
    const visibleStrokes = erasingLive
      ? (surface.eraserWholeStrokes ? eraseWholeStrokes : eraseStrokes)(storedStrokes, surface.editPath, surface.eraserSize!).kept
      : storedStrokes;

    const useLayerCache = canBlit && !erasingLive && !movingSelection;
    if (useLayerCache) {
      const layerContext = this.ensureInkLayer(surface, pixelWidth, pixelHeight, backingScale);
      if (!surface.inkLayerValid) {
        if (zoomish && scaledBlit) {
          // Zoom settle: scale old ink pixels — do NOT rebuild graphite strokes here.
          layerContext.setTransform(1, 0, 0, 1, 0, 0);
          layerContext.clearRect(0, 0, pixelWidth, pixelHeight);
          layerContext.drawImage(
            scaledBlit,
            0,
            0,
            scaledBlit.width,
            scaledBlit.height,
            0,
            0,
            pixelWidth,
            pixelHeight
          );
          layerContext.setTransform(backingScale, 0, 0, backingScale, 0, 0);
          surface.inkLayerValid = true;
          this.queueInkLayerUpgrade(pageNumber);
        } else {
          const quality: "full" | "draft" = zoomish ? "draft" : "full";
          layerContext.clearRect(0, 0, width, height);
          this.paintCommittedStrokes(surface, layerContext, visibleStrokes, stats, quality);
          surface.inkLayerValid = true;
          if (quality === "draft") this.queueInkLayerUpgrade(pageNumber);
        }
      }
      this.blitInkLayerToCanvas(surface, pixelWidth, pixelHeight, backingScale);
    } else {
      surface.inkLayerValid = false;
      if (zoomish && scaledBlit) {
        // scaledBlit already painted on canvas; defer stroke rebuild.
        this.queueInkLayerUpgrade(pageNumber);
      } else {
        surface.context.clearRect(0, 0, width, height);
        const quality: "full" | "draft" = zoomish ? "draft" : "full";
        this.paintCommittedStrokes(surface, surface.context, visibleStrokes, stats, quality);
        if (quality === "draft") this.queueInkLayerUpgrade(pageNumber);
      }
    }

    if (surface.editTool === "lasso" && surface.editPath.length > 0) {
      this.drawLassoPreview(surface);
    } else if (this.selectionShape && this.selectionPage === pageNumber) {
      this.drawSelectionShape(surface, this.moveShapePreview ?? this.selectionShape, { closeFreeform: true });
    }
    if (surface.builder?.preview().length) {
      if (surface.laserDraft) {
        const laser = this.options.settings.toolPreferences.laser;
        this.paintLaserPoints(surface, surface.builder.preview(true), laser.color, laser.width, laser.opacity, laser.holdMs, laser.fadeMs);
      } else {
        const tool = this.activeDrawingTool();
        const drawing = this.options.settings.toolPreferences[tool];
        this.drawPoints(surface, surface.builder.preview(this.simplifyStrokesEnabled()), drawing.color, drawing.width, drawing.opacity, tool, false, undefined, "draft");
      }
    }
    this.paintLaserTrails(surface, pageNumber);
    this.drawTextAnnotations(surface);
  }

  private paintLaserPoints(surface: PageSurface, points: readonly PdfPoint[], color: string, width: number, opacity: number, holdMs: number, fadeMs: number): void {
    const mapper = this.mapper(surface);
    drawLaserStroke(surface.context, mapLaserPoints(points, (point) => mapper.toViewport(point)), {
      color, width: Math.max(1, width * this.displayScale(surface)), opacity,
      nowMs: performance.now(), holdMs, fadeMs
    });
  }

  private paintLaserTrails(surface: PageSurface, pageNumber: number): void {
    for (const trail of this.laserTrails) {
      if (trail.page === pageNumber) this.paintLaserPoints(surface, trail.points, trail.color, trail.width, trail.opacity, trail.holdMs, trail.fadeMs);
    }
  }

  private ensureLaserFadeLoop(): void {
    if (this.destroyed || this.laserFadeFrame !== null) return;
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) return;
    const tick = (now: number): void => {
      this.laserFadeFrame = null;
      if (this.destroyed) return;
      const pages = new Set(this.laserTrails.map((trail) => trail.page));
      for (const surface of this.surfaces.values()) if (surface.laserDraft) pages.add(surface.page.pageNumber);
      for (let index = this.laserTrails.length - 1; index >= 0; index -= 1) {
        const trail = this.laserTrails[index]!;
        if (!laserTrailStillVisible(trail.points, now, trail.holdMs, trail.fadeMs)) this.laserTrails.splice(index, 1);
      }
      for (const page of pages) this.renderPage(page, undefined, "laser-fade");
      if (this.laserTrails.length > 0 || [...this.surfaces.values()].some((surface) => surface.laserDraft)) {
        this.laserFadeFrame = view.requestAnimationFrame(tick);
      }
    };
    this.laserFadeFrame = view.requestAnimationFrame(tick);
  }

  private drawTextAnnotations(surface: PageSurface): void {
    const annotations = this.textAnnotations.get(surface.page.pageNumber) ?? [];
    if (!annotations.length) return;
    const mapper = this.mapper(surface);
    const context = surface.context;
    const scale = this.displayScale(surface);
    context.save();
    context.textBaseline = "top";
    for (const storedAnnotation of annotations) {
      const annotation = this.moveTextPreview?.find((item) => item.id === storedAnnotation.id) ?? storedAnnotation;
      if (this.activeTextEditor?.page === surface.page.pageNumber && this.activeTextEditor.annotationId === annotation.id) continue;
      const point = mapper.toViewport(annotation);
      const runs = this.textRuns(annotation, this.options.settings.toolPreferences.text);
      const fontSize = Math.max(8, annotation.fontSize * scale);
      if (this.selectedTexts.some((text) => text.id === annotation.id)) {
        const width = Math.max(...annotation.text.split("\n").map((line) => line.length * fontSize * 0.6), fontSize);
        context.strokeStyle = "#2563eb";
        context.lineWidth = 1;
        context.setLineDash([4, 3]);
        context.strokeRect(point.x - 3, point.y - 3, width + 6, annotation.text.split("\n").length * fontSize * 1.25 + 6);
      }
      let x = point.x;
      let y = point.y;
      let lineFontSize = fontSize;
      for (const run of runs) {
        const runSize = Math.max(8, run.fontSize * scale);
        context.fillStyle = run.color;
        context.font = `${run.italic ? "italic " : ""}${run.bold ? "700 " : ""}${runSize}px ${run.fontFamily}`;
        for (const part of run.text.split(/(\n)/)) {
          if (part === "\n") {
            x = point.x;
            y += lineFontSize * 1.25;
            lineFontSize = runSize;
          } else if (part) {
            lineFontSize = Math.max(lineFontSize, runSize);
            const width = context.measureText(part).width;
            context.fillStyle = run.color;
            context.fillText(part, x, y);
            if (run.strikethrough) {
              context.fillRect(x, y + runSize * 0.58, width, Math.max(1, runSize * 0.06));
            }
            x += width;
          }
        }
      }
    }
    context.restore();
  }

  private textAnnotationAt(surface: PageSurface, point: PdfPoint): PdfTextAnnotation | undefined {
    return (this.textAnnotations.get(surface.page.pageNumber) ?? []).find((annotation) => {
      const bounds = this.textBounds(annotation);
      return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
    });
  }

  private textMatchesSelection(annotation: PdfTextAnnotation, shape: SelectionShape): boolean {
    const bounds = this.textBounds(annotation);
    return [
      { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
      { x: bounds.minX, y: bounds.maxY }, { x: bounds.maxX, y: bounds.maxY },
      { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
    ].some((point) => shapeContainsPoint(shape, point));
  }

  private textBounds(annotation: PdfTextAnnotation): { minX: number; minY: number; maxX: number; maxY: number } {
    const lines = annotation.text.split("\n");
    const width = Math.max(...lines.map((line) => line.length * annotation.fontSize * 0.6), annotation.fontSize);
    const height = Math.max(annotation.fontSize * 1.25, lines.length * annotation.fontSize * 1.25);
    return { minX: annotation.x, minY: annotation.y - height, maxX: annotation.x + width, maxY: annotation.y };
  }

  private drawLassoPreview(surface: PageSurface): void {
    const points = surface.editPath;
    if (!points.length) return;
    const lassoType = this.options.settings.toolPreferences.lasso.type;
    const shape: SelectionShape = lassoType === "freeform"
      ? { type: "freeform", points }
      : (() => {
        const xs = points.map((point) => point.x);
        const ys = points.map((point) => point.y);
        return {
          type: lassoType,
          bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
        };
      })();
    this.drawSelectionShape(surface, shape, { closeFreeform: false });
  }

  private drawSelectionShape(surface: PageSurface, shape: SelectionShape, options: { closeFreeform: boolean }): void {
    const mapper = this.mapper(surface);
    const context = surface.context;
    context.save();
    context.strokeStyle = "#2563eb";
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    context.globalAlpha = 0.95;

    if (shape.type === "freeform") {
      const points = shape.points;
      if (!points.length) {
        context.restore();
        return;
      }
      const first = mapper.toViewport(points[0]!);
      context.beginPath();
      if (points.length === 1) {
        context.arc(first.x, first.y, 3, 0, Math.PI * 2);
        context.stroke();
      } else {
        context.moveTo(first.x, first.y);
        for (const point of points.slice(1)) {
          const view = mapper.toViewport(point);
          context.lineTo(view.x, view.y);
        }
        if (options.closeFreeform && points.length >= 3) {
          context.closePath();
        }
        context.stroke();
      }
      context.restore();
      return;
    }

    const bounds = shape.bounds;
    const topLeft = mapper.toViewport({ x: bounds.minX, y: bounds.maxY });
    const bottomRight = mapper.toViewport({ x: bounds.maxX, y: bounds.minY });
    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    context.beginPath();
    context.rect(topLeft.x, topLeft.y, width, height);
    context.stroke();
    context.restore();
  }

  private drawStroke(
    surface: PageSurface,
    stroke: InkStroke,
    selected: boolean,
    graphiteQuality: "full" | "draft" = "full"
  ): void {
    this.drawPoints(
      surface,
      stroke.points,
      stroke.color,
      stroke.width,
      stroke.opacity,
      stroke.tool,
      selected,
      stroke.id,
      graphiteQuality
    );
  }

  private drawPoints(
    surface: PageSurface,
    points: readonly PdfPoint[],
    color: string,
    width: number,
    opacity: number,
    tool: DrawingTool,
    selected = false,
    strokeId?: string,
    graphiteQuality: "full" | "draft" = "full"
  ): void {
    if (!points.length) return;
    const mapper = this.mapper(surface);
    const context = surface.context;
    const scale = this.displayScale(surface);
    context.save();
    if (selected) this.drawSelectedStrokeOutline(context, mapper, points, width, scale);
    if (tool === "pencil") {
      const prefs = this.options.settings.toolPreferences.pencil;
      const viewPoints = points.map((point) => {
        const view = mapper.toViewport(point);
        return {
          x: view.x,
          y: view.y,
          pressure: point.pressure,
          tiltX: point.tiltX,
          tiltY: point.tiltY
        };
      });
      drawGraphiteStroke(context, viewPoints, {
        color,
        width: Math.max(0.5, width * scale),
        opacity,
        textureStrength: prefs.textureStrength,
        pressureSensitivity: prefs.pressureSensitivity,
        tiltSensitivity: prefs.tiltSensitivity,
        thinning: prefs.thinning,
        seed: strokeId ? seedFromId(strokeId) : seedFromId(`${viewPoints[0]!.x}:${viewPoints[0]!.y}`),
        quality: graphiteQuality
      });
    } else {
      const prefs = this.options.settings.toolPreferences[tool];
      const viewPoints = points.map((point) => {
        const view = mapper.toViewport(point);
        return { x: view.x, y: view.y, pressure: point.pressure };
      });
      drawPenStroke(context, viewPoints, {
        color,
        width: Math.max(0.5, width * scale),
        opacity,
        pressureSensitivity: prefs.pressureSensitivity,
        thinning: prefs.thinning
      });
    }

    context.restore();
  }

  private drawSelectedStrokeOutline(
    context: CanvasRenderingContext2D,
    mapper: PdfCoordinateMapper,
    points: readonly PdfPoint[],
    width: number,
    scale: number
  ): void {
    context.globalAlpha = 0.65;
    context.strokeStyle = "#2563eb";
    context.lineWidth = Math.max(1, width * scale + 2);
    context.setLineDash([4, 3]);
    context.lineCap = "round";
    context.lineJoin = "round";
    const first = mapper.toViewport(points[0]!);
    context.beginPath();
    context.moveTo(first.x, first.y);
    for (const point of points.slice(1)) {
      const view = mapper.toViewport(point);
      context.lineTo(view.x, view.y);
    }
    context.stroke();
  }

  private toPdfPoint(surface: PageSurface, sample: PointerSample, simulateMousePressure: boolean): PdfPoint {
    const overlayRect = surface.overlay.getBoundingClientRect();
    const viewport = { x: sample.clientX - overlayRect.left, y: sample.clientY - overlayRect.top };
    const point = this.mapper(surface).toPdf(viewport);
    const pressure = sample.pressure > 0 ? sample.pressure : simulateMousePressure ? 0.5 : 1;
    return { x: point.x, y: point.y, pressure, tiltX: sample.tiltX, tiltY: sample.tiltY, time: sample.timeStamp };
  }

  private projectInkScreenPoint(surface: PageSurface, clientX: number, clientY: number): { x: number; y: number } {
    const overlayRect = surface.overlay.getBoundingClientRect();
    const viewport = { x: clientX - overlayRect.left, y: clientY - overlayRect.top };
    const projected = this.mapper(surface).toViewport(this.mapper(surface).toPdf(viewport));
    return { x: overlayRect.left + projected.x, y: overlayRect.top + projected.y };
  }

  private logPositionAlign(
    surface: PageSurface,
    sample: PointerSample,
    phase: "move" | "start" | "end"
  ): void {
    const pageRect = surface.page.element.getBoundingClientRect();
    const overlayRect = surface.overlay.getBoundingClientRect();
    const layout = this.pageLayout(surface);
    const contentRect = pdfRenderCanvas(surface.page.element)?.getBoundingClientRect();
    const viewport = { x: sample.clientX - overlayRect.left, y: sample.clientY - overlayRect.top };
    const mapper = this.mapper(surface);
    const pdf = mapper.toPdf(viewport);
    const inkScreen = this.projectInkScreenPoint(surface, sample.clientX, sample.clientY);
    this.logger.positionAlign({
      phase,
      page: surface.page.pageNumber,
      clientX: round(sample.clientX),
      clientY: round(sample.clientY),
      host: {
        left: round(pageRect.left),
        top: round(pageRect.top),
        width: round(pageRect.width),
        height: round(pageRect.height)
      },
      content: contentRect ? {
        left: round(contentRect.left),
        top: round(contentRect.top),
        width: round(contentRect.width),
        height: round(contentRect.height)
      } : null,
      overlay: {
        left: round(overlayRect.left),
        top: round(overlayRect.top),
        width: round(overlayRect.width),
        height: round(overlayRect.height)
      },
      layout: {
        offsetX: round(layout.offsetX),
        offsetY: round(layout.offsetY),
        scale: round(layout.scale),
        scaleX: round(layout.scaleX),
        scaleY: round(layout.scaleY),
        pdfWidth: round(layout.pdfWidth),
        pdfHeight: round(layout.pdfHeight)
      },
      viewport: { x: round(viewport.x), y: round(viewport.y) },
      pdf: { x: round(pdf.x), y: round(pdf.y) },
      inkScreen: { x: round(inkScreen.x), y: round(inkScreen.y) },
      delta: {
        x: round(sample.clientX - inkScreen.x),
        y: round(sample.clientY - inkScreen.y)
      }
    });
  }

  private ensurePagePositioning(pageElement: HTMLElement): void {
    if (pageElement.ownerDocument.defaultView?.getComputedStyle(pageElement).position === "static") {
      pageElement.classList.add("native-pdf-handwriting-relative");
    }
  }

  private syncOverlayLayout(surface: PageSurface): void {
    const layout = this.pageLayout(surface);
    if (layout.contentWidth < 8 || layout.contentHeight < 8) return;
    const overlay = surface.overlay;
    if (overlay.parentElement !== surface.page.element) {
      this.ensurePagePositioning(surface.page.element);
      surface.page.element.append(overlay);
    }
    setElementCssProps(overlay, {
      left: `${layout.offsetX}px`,
      top: `${layout.offsetY}px`,
      width: `${layout.contentWidth}px`,
      height: `${layout.contentHeight}px`
    });
  }

  private mapper(surface: PageSurface): PdfCoordinateMapper {
    const layout = this.pageLayout(surface);
    const metrics = this.metricsFor(surface);
    return new PdfCoordinateMapper({
      width: metrics.width,
      height: metrics.height,
      scale: layout.scale,
      rotation: this.rotation(surface.page.rotation),
      offsetX: 0,
      offsetY: 0
    });
  }

  private displayScale(surface: PageSurface): number {
    return this.pageLayout(surface).scale;
  }

  private pageLayout(surface: PageSurface): PageCoordinateLayout {
    const metrics = this.metricsFor(surface);
    return resolvePageCoordinateLayout({
      ...surface.page,
      width: metrics.width,
      height: metrics.height
    });
  }

  private metricsFor(surface: PageSurface): { width: number; height: number } {
    const pinned = this.pageMetrics.get(surface.page.pageNumber);
    if (pinned) return pinned;
    this.rememberPageMetrics(surface.page);
    return this.pageMetrics.get(surface.page.pageNumber) ?? {
      width: surface.page.width,
      height: surface.page.height
    };
  }

  private rememberPageMetrics(page: PdfPageInfo): void {
    if (!(page.width > 1 && page.height > 1)) return;
    const existing = this.pageMetrics.get(page.pageNumber);
    // Prefer first trusted sidecar/live size; only replace placeholder or clearly wrong CSS-pixel sizes.
    if (!existing || existing.width <= 1 || existing.height <= 1) {
      this.pageMetrics.set(page.pageNumber, { width: page.width, height: page.height });
      return;
    }
    const looksLikeCssPixels = page.width > 1800 || page.height > 2400;
    const existingLooksPdf = existing.width <= 1800 && existing.height <= 2400;
    if (looksLikeCssPixels && existingLooksPdf) return;
    if (!existingLooksPdf && page.width <= 1800 && page.height <= 2400) {
      this.pageMetrics.set(page.pageNumber, { width: page.width, height: page.height });
    }
  }

  private rotation(value: number): PageRotation {
    return normalizeRotation(value);
  }

  private snapshot(): SidecarSchemaV1 {
    const now = new Date().toISOString();
    const stored = new Map<number, InkStroke[]>();
    for (const stroke of this.ink.all()) stored.set(stroke.page, [...(stored.get(stroke.page) ?? []), stroke]);
    const pageNumbers = new Set([...stored.keys(), ...this.textAnnotations.keys()]);
    const known = new Map(this.options.adapter.pages().map((page) => [page.pageNumber, page]));
    return {
      schemaVersion: 1,
      document: this.identity,
      pages: [...pageNumbers].map((pageNumber) => {
        const strokes = stored.get(pageNumber) ?? [];
        const page = known.get(pageNumber);
        const metrics = this.pageMetrics.get(pageNumber) ?? {
          width: page?.width ?? 1,
          height: page?.height ?? 1
        };
        return {
          page: pageNumber,
          width: metrics.width,
          height: metrics.height,
          rotation: this.rotation(page?.rotation ?? 0),
          strokes,
          texts: this.textAnnotations.get(pageNumber) ?? []
        };
      }),
      createdAt: this.createdAt,
      updatedAt: now
    };
  }

  private stillOwnsPersist(): boolean {
    if (this.writesAbandoned || this.destroyed) return false;
    const liveEpoch = this.options.livePersistEpoch?.(this.identity.id);
    if (liveEpoch !== undefined && liveEpoch !== this.persistEpoch) {
      this.abandonWrites(`stale-epoch:${this.persistEpoch}<${liveEpoch}`);
      return false;
    }
    return true;
  }

  private async persist(snapshot: SidecarSchemaV1, reason = "autosave"): Promise<void> {
    const strokeCount = countSidecarStrokes(snapshot);
    if (!this.stillOwnsPersist()) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        dirty: false,
        updatedAt: snapshot.updatedAt,
        skipped: this.writesAbandoned ? "abandoned-writer" : "destroyed"
      });
      return;
    }
    try {
      // Re-check after each await so emergency sync from another session cannot be overwritten.
      if (!this.stillOwnsPersist()) return;
      await this.options.recovery.save(snapshot);
      if (!this.stillOwnsPersist()) {
        await this.options.recovery.clear(this.identity.id).catch(() => undefined);
        this.logger.sidecarPersist({
          reason,
          documentId: this.identity.id,
          strokeCount,
          dirty: false,
          updatedAt: snapshot.updatedAt,
          skipped: "abandoned-after-recovery"
        });
        return;
      }
      await this.options.sidecars.save(snapshot);
      if (!this.stillOwnsPersist()) {
        this.logger.sidecarPersist({
          reason,
          documentId: this.identity.id,
          strokeCount,
          dirty: false,
          updatedAt: snapshot.updatedAt,
          skipped: "abandoned-after-sidecar"
        });
        return;
      }
      await this.options.recovery.clear(this.identity.id);
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        dirty: false,
        updatedAt: snapshot.updatedAt
      });
    } catch (error) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        dirty: this.isDirty(),
        updatedAt: snapshot.updatedAt,
        error: this.errorMessage(error)
      });
      throw error;
    }
  }

  private exportPageMetrics(): Array<{ page: number; width: number; height: number }> {
    const fromPinned = [...this.pageMetrics.entries()].map(([page, metrics]) => ({
      page,
      width: metrics.width,
      height: metrics.height
    }));
    if (fromPinned.length) return fromPinned;
    return this.options.adapter.pages().map((page) => ({
      page: page.pageNumber,
      width: page.width,
      height: page.height
    }));
  }

  remountToolbar(): void {
    if (this.destroyed) return;
    this.options.adapter.mountToolbar(this.toolbar.element, this.currentToolbarPlacement());
  }

  setStylusAnnotationLabelHidden(hidden: boolean): void {
    for (const surface of this.surfaces.values()) {
      this.setCanvasAccessibilityLabel(surface.canvas, surface.page.pageNumber, hidden);
    }
  }

  setHoldToStraighten(enabled: boolean): void {
    this.options.settings.holdToStraighten = enabled;
    if (!enabled) {
      for (const surface of this.surfaces.values()) this.resetStraighten(surface);
    }
  }

  /** False after PDF++ (or Obsidian) tears down the PDF DOM under this session. */
  isAttached(): boolean {
    if (this.destroyed || this.detachNotified) return false;
    const { adapter } = this.options;
    if (!adapter.host.isConnected || !adapter.root.isConnected) return false;
    const pages = adapter.pages();
    if (!pages.length) return false;
    if (!this.surfaces.size) return true;
    return [...this.surfaces.values()].some((surface) => surface.overlay.isConnected);
  }

  private currentToolbarPlacement(): ToolbarPlacement {
    return this.options.toolbarPlacement?.() ?? this.options.settings.toolbarPlacement ?? "main";
  }

  private zoomAroundPinch(factor: number, clientX: number, clientY: number): void {
    if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 0.001) return;
    const adapter = this.options.adapter;
    // PDF.js may resize its canvas synchronously inside the zoom call, before its
    // scalechanging event reaches us. Freeze the prior ink bitmap first.
    this.scheduleZoomRepaint("pinch-scalechanging", adapter.getViewState().scale);
    const scrollRoot = adapter.scrollElement();
    const rect = scrollRoot.getBoundingClientRect();
    const origin: [number, number] = [clientX - rect.left, clientY - rect.top];
    if (adapter.zoomByScaleFactor?.(factor, origin)) return;

    const before = adapter.getViewState().scale;
    const maxScale = adapter.maxScale?.() ?? Number.POSITIVE_INFINITY;
    const after = Math.max(0.1, Math.min(maxScale, before * factor));
    if (!adapter.setScale?.(after)) return;
    const scaleRatio = after / before;
    scrollRoot.scrollLeft = (scrollRoot.scrollLeft + origin[0]) * scaleRatio - origin[0];
    scrollRoot.scrollTop = (scrollRoot.scrollTop + origin[1]) * scaleRatio - origin[1];
  }

  private async handleMore(action: MoreAction): Promise<void> {
    if (action === "export-flattened" || action === "export-editable") {
      const mode = action === "export-editable" ? "editable" : "flattened";
      await this.exportCopy(mode).catch((error) => this.options.notice(`Export failed: ${this.errorMessage(error)}`));
      return;
    }
    if (action === "toolbar-main" || action === "toolbar-left" || action === "toolbar-right") {
      const placement = action.replace("toolbar-", "") as ToolbarPlacement;
      // Prefer savePluginSettings (assigns via saveSettings + remounts open leaves). Local mutate is fallback only.
      if (this.options.savePluginSettings) await this.options.savePluginSettings({ toolbarPlacement: placement });
      this.options.settings.toolbarPlacement = placement;
      this.remountToolbar();
    }
  }

  private updateDebug(surface?: PageSurface, event?: PointerEvent): void {
    const view = this.options.adapter.getViewState();
    this.debugState = {
      ...(event ? {
        pointerType: event.pointerType,
        pressure: event.pressure,
        tiltX: event.tiltX,
        tiltY: event.tiltY
      } : {}),
      page: surface?.page.pageNumber ?? view.pageNumber,
      ...(this.lastPointerPdf ? { pdfX: this.lastPointerPdf.x, pdfY: this.lastPointerPdf.y } : {}),
      scale: surface ? this.displayScale(surface) : view.scale,
      rotation: surface?.page.rotation ?? view.rotation,
      tool: this.options.settings.toolPreferences.activeTool,
      dirty: this.isDirty(),
      autosave: this.options.settings.autosave,
      pending: this.autosave.isDirty(this.identity.id)
    };
  }

  private logDraw(surface: PageSurface, phase: DrawPositionLog["phase"], tool: string, points: readonly PdfPoint[]): void {
    if (!points.length) return;
    this.logger.draw({
      phase,
      page: surface.page.pageNumber,
      tool,
      displayScale: Number(this.displayScale(surface).toFixed(4)),
      points: points.map((point) => ({
        x: Number(point.x.toFixed(2)),
        y: Number(point.y.toFixed(2)),
        ...(point.pressure !== undefined ? { pressure: Number(point.pressure.toFixed(3)) } : {})
      }))
    });
  }

  private simplifyStrokesEnabled(): boolean {
    return this.options.simplifyStrokesEnabled?.() ?? this.options.settings.simplifyStrokes;
  }

  private id(): string {
    const cryptoObj = window.crypto;
    return cryptoObj?.randomUUID?.() ?? `stroke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
