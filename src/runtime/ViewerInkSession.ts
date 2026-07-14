import type { InkStroke, PdfPoint, PluginSettings, ToolbarPlacement, ToolPreferences } from "../model";
import type { ObsidianPdfAdapter } from "../integration/ObsidianPdfAdapter";
import type { PdfPageInfo } from "../integration/PdfPageLocator";
import { PointerRouter } from "../input/PointerRouter";
import { ViewerMousePan, type MousePanPhase } from "../input/ViewerMousePan";
import { shouldIgnoreSelectionShortcut, parseSelectionShortcut, parseHistoryShortcut, type SelectionShortcutAction } from "../input/SelectionShortcuts";
import type { PointerSample } from "../input/PointerCapabilities";
import { InkSession } from "../ink/InkSession";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { StrokeClipboard } from "../ink/StrokeClipboard";
import { simplifyPoints } from "../ink/StrokeStabilizer";
import { PdfCoordinateMapper, type PageRotation } from "../pdf/PdfCoordinateMapper";
import { normalizeRotation, overlayOffsetInParent, pdfRenderCanvas, resolvePageCoordinateLayout, type PageCoordinateLayout } from "../pdf/PageCoordinateLayout";
import { PdfExportService, annotatedFilename } from "../pdf/PdfExportService";
import { AddStrokeCommand, AddStrokesCommand, DeleteStrokesCommand, ReplacePageStrokesCommand, ReplaceStrokesCommand, translateStrokes } from "../history/AnnotationCommands";
import { CommandHistory, type Command } from "../history/CommandHistory";
import { eraseStrokes } from "../tools/EraserTool";
import { boundingShapeFromStrokes, filterSelectableStrokes, selectStrokes, selectionShapeArea, shapeBounds, shapeContainsPoint, translateShape, type SelectionShape } from "../tools/LassoTool";
import { drawGraphiteStroke, seedFromId } from "../tools/PencilTool";
import { drawPenStroke } from "../tools/PenTool";
import { AutosaveQueue } from "../storage/AutosaveQueue";
import { createDocumentIdentity } from "../storage/DocumentIdentity";
import { RecoveryRepository } from "../storage/RecoveryRepository";
import { SaveCoordinator, type CloseChoice } from "../storage/SaveCoordinator";
import { SidecarRepository } from "../storage/SidecarRepository";
import { pickNewerSidecar, serializeSidecar, countSidecarStrokes, type SidecarSchemaV1 } from "../storage/SidecarSchema";
import type { VaultSyncWriter } from "../storage/VaultSyncWriter";
import { AnnotationToolbar, type MoreAction, type ZoomAction } from "../ui/AnnotationToolbar";
import { inkBackingSize } from "./inkBackingSize";
import type { DebugState } from "../ui/DebugPanel";
import { SelectionToolbar, type ViewportPoint } from "../ui/SelectionToolbar";
import { SessionLogger, type DrawPositionLog, type ViewStateSource } from "../logging/SessionLogger";
import type { VaultLogSink } from "../logging/VaultLogSink";
import type { PdfViewState } from "../integration/ObsidianPdfAdapter";
import { describeScrollElement } from "../integration/PdfScrollRoot";

export interface SessionDiagnostics {
  document: string;
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
  mouseDragScrollEnabled?(): boolean;
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
  editPath: PdfPoint[];
  editTool: "eraser" | "lasso" | undefined;
  eraserSize: number | undefined;
}

export class ViewerInkSession {
  private readonly ink = new InkSession();
  private readonly identity;
  private readonly surfaces = new Map<number, PageSurface>();
  private readonly exporter = new PdfExportService();
  private readonly createdAt = new Date().toISOString();
  private readonly toolbar: AnnotationToolbar;
  private readonly selectionToolbar: SelectionToolbar;
  private readonly history: CommandHistory;
  private readonly autosave: AutosaveQueue<SidecarSchemaV1>;
  private readonly saveCoordinator: SaveCoordinator;
  private selected: InkStroke[] = [];
  private selectionShape: SelectionShape | null = null;
  private selectionPage: number | null = null;
  private moveDrag: { page: number; start: PdfPoint; before: InkStroke[]; beforeShape: SelectionShape } | null = null;
  private movePreview: InkStroke[] | null = null;
  private moveShapePreview: SelectionShape | null = null;
  private drawEnabled = false;
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
  private zoomBurstStartedAt = 0;
  private zoomTickCount = 0;
  private zoomBurstScaleStart: number | null = null;
  private zoomBurstScaleEnd: number | null = null;
  private zoomBurstReason = "view-scalechanging";
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
      supportedMoreActions: ["export", "toolbar-main", "toolbar-left", "toolbar-right"],
      callbacks: {
        onPreferencesChange: (preferences) => {
          void options.saveSettings(preferences);
          this.refresh("preferences");
        },
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
        onZoom: (action) => this.handleZoom(action),
        onMore: (action) => void this.handleMore(action),
        toolbarPlacement: () => this.options.toolbarPlacement?.() ?? this.options.settings.toolbarPlacement
      }
    });
    this.selectionToolbar = new SelectionToolbar({
      onDelete: () => this.deleteSelection(),
      onDuplicate: () => this.duplicateSelection(),
      onRecolor: (color) => this.recolorSelection(color),
      onClear: () => this.clearSelection()
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
      enabled: () => !this.drawEnabled && (this.options.mouseDragScrollEnabled?.() ?? this.options.settings.mouseDragScroll),
      touchPanEnabled: () => true,
      scrollRoot: () => adapter.scrollElement(),
      withinTarget: (target) => {
        if (!(target instanceof Element)) return false;
        if (target.closest(".native-pdf-ink-toolbar, .native-pdf-ink-dropdown, .native-pdf-ink-selection-toolbar")) return false;
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
      if (!(target instanceof Element)) return String(target);
      const tag = target.tagName.toLowerCase();
      const classes = [...target.classList].slice(0, 3).join(".");
      return classes ? `${tag}.${classes}` : tag;
    };
    doc.addEventListener("pointerdown", (event) => {
      const e = event as PointerEvent;
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
    doc.addEventListener("touchstart", (event) => {
      const e = event as TouchEvent;
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
    doc.addEventListener("wheel", (event) => {
      const e = event as WheelEvent;
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
    if (!this.zoomBurstStartedAt || now - this.zoomBurstStartedAt > ViewerInkSession.ZOOM_ACTIVE_MS) {
      this.zoomBurstStartedAt = now;
      this.zoomTickCount = 0;
      this.zoomBurstScaleStart = scale ?? null;
    }
    this.zoomTickCount += 1;
    this.zoomBurstReason = reason;
    // Only freeze ink bitmap during real zoom/rotation — pages-dom storms must keep repainting.
    if (ViewerInkSession.shouldCompositeDuring(reason) && !this.zoomCompositing) {
      this.beginZoomCompositing();
    }
    // Burst: keep overlay box glued to PDF canvas content box; skip stroke redraw.
    if (this.zoomCompositing) this.syncZoomOverlayLayouts();
    this.refreshSurfaceCursors();
    if (scale !== undefined) {
      if (this.zoomBurstScaleStart === null) this.zoomBurstScaleStart = scale;
      this.zoomBurstScaleEnd = scale;
    }
    this.logger.zoomTick({
      reason,
      tick: this.zoomTickCount,
      ...(scale !== undefined ? { scale: Number(scale.toFixed(4)) } : {})
    });
    if (this.zoomSettleTimer !== null) window.clearTimeout(this.zoomSettleTimer);
    this.zoomSettleTimer = window.setTimeout(() => {
      this.zoomSettleTimer = null;
      const burstTicks = this.zoomTickCount;
      const burstDurationMs = roundMs(performance.now() - this.zoomBurstStartedAt);
      const scaleStart = this.zoomBurstScaleStart;
      const scaleEnd = this.zoomBurstScaleEnd;
      this.zoomBurstStartedAt = 0;
      this.zoomTickCount = 0;
      this.zoomBurstScaleStart = null;
      this.zoomBurstScaleEnd = null;
      this.lastZoomSignalAt = 0;
      this.endZoomCompositing();
      this.repaintSurfaces(this.zoomBurstReason, {
        burstTicks,
        burstDurationMs,
        ...(scaleStart !== null ? { scaleStart } : {}),
        ...(scaleEnd !== null ? { scaleEnd } : {})
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
      surface.overlay.classList.add("native-pdf-ink-zoom-compositing");
      surface.canvas.style.width = "100%";
      surface.canvas.style.height = "100%";
    }
  }

  private endZoomCompositing(): void {
    this.zoomCompositing = false;
    for (const surface of this.surfaces.values()) {
      surface.overlay.classList.remove("native-pdf-ink-zoom-compositing");
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
      surface.overlay.classList.add("native-pdf-ink-zoom-compositing");
      surface.canvas.style.width = "100%";
      surface.canvas.style.height = "100%";
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
    }
    options.adapter.mountToolbar(session.toolbar.element, session.currentToolbarPlacement());
    session.logger.sessionAttach({
      scrollRoot: describeScrollElement(options.adapter.scrollElement()),
      panCapture: "document-capture",
      panBoundary: describeScrollElement(options.adapter.host),
      drawEnabled: session.drawEnabled,
      mouseDragScroll: options.settings.mouseDragScroll,
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
        this.surfaces.get(page.pageNumber)?.router?.syncToolState();
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
    if (!this.selected.length || this.selectionPage === null) return;
    if (options?.resetPlacement) this.selectionToolbar.resetPlacement();
    const anchor = this.autoToolbarAnchor();
    this.selectionToolbar.show(this.selected.length, anchor);
    this.selectionToolbar.reposition(anchor);
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

    if (this.isZoomGestureActive() && ViewerInkSession.shouldCompositeDuring(this.zoomBurstReason)) {
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
      this.options.notice("Annotations saved.");
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
      document: this.options.pdfPath,
      compatibility: this.options.adapter.compatibilityReport(),
      debug: this.debugState
    };
  }

  refreshDiagnostics(): void {
    this.updateDebug();
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (this.destroyed || shouldIgnoreSelectionShortcut(event.target)) return false;
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

  async exportCopy(): Promise<void> {
    await this.autosave.flush(this.identity.id);
    const bytes = await this.exporter.export({
      sourceBytes: await this.options.readSourcePdf(),
      getStrokes: () => this.ink.all(),
      pageMetrics: this.exportPageMetrics()
    });
    const name = annotatedFilename(this.options.pdfPath.split("/").pop() ?? "document.pdf");
    const path = await this.options.writeExport(name, bytes);
    this.options.notice(`Exported ${typeof path === "string" ? path : name}. Original PDF unchanged.`);
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
    this.cancelInkLayerUpgrades();
    this.endZoomCompositing();
    this.syncAnnotationCursorMode(false);
    this.resizeObserver?.disconnect();
    for (const surface of this.surfaces.values()) surface.router?.destroy();
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
      && (tool === "pen" || tool === "pencil" || tool === "eraser");
    this.options.adapter.root.classList.toggle("native-pdf-ink-hide-native-cursor", hideNativeCursor);
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
    const mouseDragScroll = this.options.mouseDragScrollEnabled?.() ?? this.options.settings.mouseDragScroll;
    return {
      drawEnabled: this.drawEnabled,
      mouseDragScroll,
      panEnabled: !this.drawEnabled && mouseDragScroll,
      scrollRoot: describeScrollElement(this.options.adapter.scrollElement()),
      ...(reason ? { reason } : {})
    };
  }

  private mountPage(page: PdfPageInfo): PageSurface {
    this.rememberPageMetrics(page);
    const overlay = this.options.adapter.mountOverlay(page.pageNumber);
    const canvas = overlay.ownerDocument.createElement("canvas");
    canvas.className = "native-pdf-ink-canvas";
    canvas.setAttribute("aria-label", `Annotations for PDF page ${page.pageNumber}`);
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
      editPath: [],
      editTool: undefined,
      eraserSize: undefined
    };
    surface.router = this.createPageRouter(surface);
    this.ensurePagePositioning(page.element);
    this.syncOverlayLayout(surface);
    return surface;
  }

  private createPageRouter(surface: PageSurface): PointerRouter {
    return new PointerRouter(surface.page.element, {
      activeTool: () => this.options.settings.toolPreferences.activeTool,
      drawingEnabled: () => this.drawEnabled,
      scrollRoot: () => null,
      cursorParent: () => surface.overlay,
      eraserCursorDiameter: () => this.options.settings.toolPreferences.eraser.size * this.displayScale(surface),
      drawCursorColor: () => {
        const tool = this.options.settings.toolPreferences.activeTool;
        const drawing = tool === "pencil"
          ? this.options.settings.toolPreferences.pencil
          : this.options.settings.toolPreferences.pen;
        return drawing.color;
      },
      projectCursor: (clientX, clientY) => this.projectInkScreenPoint(surface, clientX, clientY),
      onStart: (samples, route, event) => this.pointerStart(surface, samples, route, event),
      onMove: (samples, route, event) => this.pointerMove(surface, samples, route, event),
      onEnd: (samples, route, event) => this.pointerEnd(surface, samples, route, event),
      onCancel: (_route, event) => this.pointerCancel(surface, event),
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
      onMousePan: (phase, _event, details) => this.logger.mousePan(phase, { page: surface.page.pageNumber, ...details })
    });
  }

  private pointerStart(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void {
    const preferences = this.options.settings.toolPreferences;
    // Selected ink: drag inside selection moves it even when pen/pencil is active.
    if (this.tryStartSelectionMove(surface, samples[0]!)) {
      this.renderPage(surface.page.pageNumber);
      return;
    }
    if (route === "draw") {
      const tool = preferences.activeTool === "pencil" ? "pencil" : "pen";
      const drawing = preferences[tool];
      surface.builder = new StrokeBuilder({
        id: this.id(),
        page: surface.page.pageNumber,
        tool,
        color: drawing.color,
        width: drawing.width,
        opacity: drawing.opacity,
        inputType: event.pointerType === "pen" ? "pen" : "mouse",
        stabilization: drawing.stabilization
      });
      for (const sample of samples) surface.builder.add(this.toPdfPoint(surface, sample, drawing.simulateMousePressure));
      const first = surface.builder.preview(this.simplifyStrokesEnabled())[0];
      if (first) {
        this.lastPointerPdf = { x: first.x, y: first.y };
        this.logDraw(surface, "start", tool, [first]);
      }
      this.logPositionAlign(surface, samples[0]!, "start");
    } else {
      if (preferences.activeTool === "lasso" && this.selected.length > 0) {
        const point = this.toPdfPoint(surface, samples[0]!, true);
        if (!this.selectionShape || this.selectionPage !== surface.page.pageNumber || !shapeContainsPoint(this.selectionShape, point)) {
          this.clearSelection();
        }
      }
      surface.editTool = preferences.activeTool === "eraser" ? "eraser" : "lasso";
      surface.eraserSize = surface.editTool === "eraser" ? preferences.eraser.size : undefined;
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
      this.moveShapePreview = translateShape(this.moveDrag.beforeShape, dx, dy);
      this.updateDebug(surface, event);
      this.renderPage(surface.page.pageNumber);
      return;
    }
    if (route === "draw" && surface.builder) {
      const tool = this.options.settings.toolPreferences.activeTool === "pencil" ? "pencil" : "pen";
      const simulate = this.options.settings.toolPreferences[tool].simulateMousePressure;
      for (const sample of samples) surface.builder.add(this.toPdfPoint(surface, sample, simulate));
      const last = samples.at(-1);
      if (last) this.logPositionAlign(surface, last, "move");
    } else if (route === "edit") {
      surface.editPath.push(...samples.map((sample) => this.toPdfPoint(surface, sample, true)));
    }
    this.updateDebug(surface, event);
    this.renderPage(surface.page.pageNumber);
  }

  private pointerEnd(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void {
    if (this.moveDrag?.page === surface.page.pageNumber) {
      const current = this.toPdfPoint(surface, samples.at(-1)!, true);
      const dx = current.x - this.moveDrag.start.x;
      const dy = current.y - this.moveDrag.start.y;
      if (dx !== 0 || dy !== 0) {
        const after = translateStrokes(this.moveDrag.before, dx, dy);
        this.history.execute(new ReplaceStrokesCommand(this.ink, this.selected, after));
        this.selected = after;
        this.selectionShape = translateShape(this.moveDrag.beforeShape, dx, dy);
      }
      this.moveDrag = null;
      this.movePreview = null;
      this.moveShapePreview = null;
      this.updateDebug(surface, event);
      this.renderPage(surface.page.pageNumber);
      return;
    }
    if (route === "draw" && surface.builder) {
      const tool = this.options.settings.toolPreferences.activeTool === "pencil" ? "pencil" : "pen";
      const simulate = this.options.settings.toolPreferences[tool].simulateMousePressure;
      for (const sample of samples) surface.builder.add(this.toPdfPoint(surface, sample, simulate));
      const stroke = surface.builder.finish(this.simplifyStrokesEnabled());
      this.history.execute(new AddStrokeCommand(this.ink, stroke));
      this.lastPointerPdf = stroke.points.at(-1) ? { x: stroke.points.at(-1)!.x, y: stroke.points.at(-1)!.y } : this.lastPointerPdf;
      this.logDraw(surface, "end", tool, stroke.points);
      const last = samples.at(-1);
      if (last) this.logPositionAlign(surface, last, "end");
      surface.builder = undefined;
    } else if (route === "edit") {
      surface.editPath.push(...samples.map((sample) => this.toPdfPoint(surface, sample, true)));
      const tool = this.options.settings.toolPreferences.activeTool;
      const phase = tool === "eraser" ? "eraser" : "lasso";
      const path = [...surface.editPath];
      this.finishEdit(surface);
      this.logDraw(surface, phase, tool, path);
      surface.editPath = [];
    }
    this.updateDebug(surface, event);
    this.renderPage(surface.page.pageNumber);
  }

  private pointerCancel(surface: PageSurface, event: PointerEvent): void {
    this.moveDrag = null;
    this.movePreview = null;
    this.moveShapePreview = null;
    surface.builder = undefined;
    surface.editPath = [];
    surface.editTool = undefined;
    surface.eraserSize = undefined;
    this.updateDebug(surface, event);
    this.renderPage(surface.page.pageNumber);
  }

  private finishEdit(surface: PageSurface): void {
    const preferences = this.options.settings.toolPreferences;
    const editTool = surface.editTool;
    const eraserSize = surface.eraserSize;
    surface.editTool = undefined;
    surface.eraserSize = undefined;
    if (editTool === "eraser" && eraserSize !== undefined) {
      const result = eraseStrokes(this.ink.page(surface.page.pageNumber), surface.editPath, eraserSize, {
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
    if (!this.selected.length) {
      this.clearSelection();
      return;
    }
    this.selectionShape = shape;
    this.selectionPage = surface.page.pageNumber;
    this.invalidateInkLayer(surface);
    this.logger.lassoSelection(surface.page.pageNumber, this.selected.length, editPath.length, shape.type);
    this.ensureSelectionToolbar({ resetPlacement: true });
  }

  private tryStartSelectionMove(surface: PageSurface, sample: PointerSample): boolean {
    if (!this.selectionShape || this.selectionPage !== surface.page.pageNumber || !this.selected.length) return false;
    const point = this.toPdfPoint(surface, sample, true);
    if (!shapeContainsPoint(this.selectionShape, point)) return false;
    this.moveDrag = {
      page: surface.page.pageNumber,
      start: point,
      before: this.selected.map((stroke) => structuredClone(stroke)),
      beforeShape: structuredClone(this.selectionShape)
    };
    this.movePreview = this.moveDrag.before;
    this.moveShapePreview = this.moveDrag.beforeShape;
    return true;
  }

  private deleteSelection(): void {
    this.reconcileSelection();
    if (!this.selected.length) return;
    this.history.execute(new DeleteStrokesCommand(this.ink, this.selected));
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
    this.moveShapePreview = null;
    this.ensureSelectionToolbar({ resetPlacement: true });
    this.refresh("paste-selection");
  }

  private duplicateSelection(): void {
    if (!this.selected.length) return;
    const duplicates = translateStrokes(this.selected, 10, -10).map((stroke) => ({ ...stroke, id: this.id() }));
    const command: Command = {
      label: "Duplicate strokes",
      execute: () => duplicates.forEach((stroke) => this.ink.add(stroke)),
      undo: () => duplicates.forEach((stroke) => this.ink.remove(stroke.id))
    };
    this.history.execute(command);
    this.selected = duplicates;
    this.selectionShape = boundingShapeFromStrokes(duplicates);
    this.ensureSelectionToolbar();
  }

  private recolorSelection(color: string): void {
    if (!this.selected.length) return;
    const now = new Date().toISOString();
    const after = this.selected.map((stroke) => ({ ...stroke, color, updatedAt: now }));
    this.history.execute(new ReplaceStrokesCommand(this.ink, this.selected, after));
    this.selected = after;
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
    this.selectionShape = null;
    this.selectionPage = null;
    this.moveDrag = null;
    this.movePreview = null;
    this.moveShapePreview = null;
    this.selectionToolbar.hide();
    this.refresh("clear-selection");
  }

  private reconcileSelection(): void {
    if (!this.selected.length || this.selectionPage === null) return;
    const pageStrokes = this.ink.page(this.selectionPage);
    const byId = new Map(pageStrokes.map((stroke) => [stroke.id, stroke]));
    const synced = this.selected
      .map((stroke) => byId.get(stroke.id))
      .filter((stroke): stroke is InkStroke => stroke !== undefined);
    if (!synced.length) {
      this.selected = [];
      this.selectionShape = null;
      this.selectionPage = null;
      this.moveDrag = null;
      this.movePreview = null;
      this.moveShapePreview = null;
      this.selectionToolbar.hide();
      return;
    }
    if (synced.length !== this.selected.length || synced.some((stroke, index) => stroke !== this.selected[index])) {
      this.selected = synced;
      this.selectionShape = boundingShapeFromStrokes(synced) ?? this.selectionShape;
    }
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
    const next = this.inkUpgradePages.values().next().value as number | undefined;
    if (next === undefined) return;
    this.inkUpgradePages.delete(next);
    const surface = this.surfaces.get(next);
    if (!surface || surface.builder || surface.editPath.length > 0) {
      if (surface && (surface.builder || surface.editPath.length > 0)) {
        this.inkUpgradePages.add(next);
      }
      if (this.inkUpgradePages.size > 0) this.queueInkLayerUpgrade([...this.inkUpgradePages][0]!);
      return;
    }
    surface.inkLayerValid = false;
    this.renderPage(next, undefined, "ink-upgrade");
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
    surface.canvas.style.width = "100%";
    surface.canvas.style.height = "100%";
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
      ? eraseStrokes(storedStrokes, surface.editPath, surface.eraserSize!).kept
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
      const drawing = this.options.settings.toolPreferences[
        this.options.settings.toolPreferences.activeTool === "pencil" ? "pencil" : "pen"
      ];
      this.drawPoints(
        surface,
        surface.builder.preview(this.simplifyStrokesEnabled()),
        drawing.color,
        drawing.width,
        drawing.opacity,
        this.options.settings.toolPreferences.activeTool === "pencil",
        false,
        undefined,
        "draft"
      );
    }
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
    context.fillStyle = "rgba(37, 99, 235, 0.12)";
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
        context.fill();
      } else {
        context.moveTo(first.x, first.y);
        for (const point of points.slice(1)) {
          const view = mapper.toViewport(point);
          context.lineTo(view.x, view.y);
        }
        if (options.closeFreeform && points.length >= 3) {
          context.closePath();
          context.fill();
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
    context.fill();
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
      stroke.tool === "pencil",
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
    pencil: boolean,
    selected = false,
    strokeId?: string,
    graphiteQuality: "full" | "draft" = "full"
  ): void {
    if (!points.length) return;
    const mapper = this.mapper(surface);
    const context = surface.context;
    const scale = this.displayScale(surface);
    context.save();
    if (pencil) {
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
      const prefs = this.options.settings.toolPreferences.pen;
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

    if (selected) {
      context.globalAlpha = 0.9;
      context.strokeStyle = "#2563eb";
      context.lineWidth = Math.max(0.5, width * scale) + 4;
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
    context.restore();
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
    const projected = mapper.toViewport(pdf);
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
      pageElement.style.position = "relative";
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
    overlay.style.left = `${layout.offsetX}px`;
    overlay.style.top = `${layout.offsetY}px`;
    overlay.style.width = `${layout.contentWidth}px`;
    overlay.style.height = `${layout.contentHeight}px`;
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
    const known = new Map(this.options.adapter.pages().map((page) => [page.pageNumber, page]));
    return {
      schemaVersion: 1,
      document: this.identity,
      pages: [...stored.entries()].map(([pageNumber, strokes]) => {
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
          strokes
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

  private handleZoom(action: ZoomAction): void {
    const adapter = this.options.adapter;
    if (action === "in") {
      adapter.zoomBySteps?.(1);
      return;
    }
    if (action === "out") {
      adapter.zoomBySteps?.(-1);
      return;
    }
    const named: Partial<Record<ZoomAction, string>> = {
      "fit-width": "page-width",
      "fit-page": "page-fit",
      reset: "page-width"
    };
    const scales: Partial<Record<ZoomAction, number>> = {
      actual: 1,
      "200": 2,
      "400": 4,
      "800": 8,
      "1000": 10,
      "1500": 15,
      "2000": 20
    };
    const namedValue = named[action];
    if (namedValue) {
      adapter.setScaleValue?.(namedValue);
      return;
    }
    const scale = scales[action];
    if (scale != null) adapter.setScale?.(scale);
  }

  private async handleMore(action: MoreAction): Promise<void> {
    if (action === "export") {
      await this.exportCopy().catch((error) => this.options.notice(`Export failed: ${this.errorMessage(error)}`));
      return;
    }
    if (action === "toolbar-main" || action === "toolbar-left" || action === "toolbar-right") {
      const placement = action.replace("toolbar-", "") as ToolbarPlacement;
      // Prefer savePluginSettings (assigns via saveSettings + remounts open leaves). Local mutate is fallback only.
      if (this.options.savePluginSettings) await this.options.savePluginSettings({ toolbarPlacement: placement });
      else this.options.settings.toolbarPlacement = placement;
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
    return globalThis.crypto?.randomUUID?.() ?? `stroke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
