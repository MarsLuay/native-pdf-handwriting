import type { DrawingTool, InkStroke, PdfPoint, PdfTextAnnotation, PdfTextRun, PluginSettings, TextStyle, ToolbarPlacement, ToolPreferences } from "../model";
import { isDrawingTool, isInkDrawTool, resolveDrawingTool } from "../model";
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
import { normalizeRotation, pdfRenderCanvas, resolvePageCoordinateLayout, type PageCoordinateLayout } from "../pdf/PageCoordinateLayout";
import { createDetachedDiv, createDetachedEl } from "../vendor/createDetached";
import { isElementInDocument, setElementCssProps } from "../dom/typeGuards";
import { PdfExportService, annotatedFilename, editableAnnotatedFilename } from "../pdf/PdfExportService";
import { AddStrokeCommand, ReplaceAnnotationSelectionCommand, ReplacePageStrokesCommand, translateStrokes } from "../history/AnnotationCommands";
import { CommandHistory, type Command } from "../history/CommandHistory";
import { eraseStrokes, eraseWholeStrokes } from "../tools/EraserTool";
import { recognizeHeldShape, resizeShapePoints, shapeResizeAnchor, shapeResizeHandle, SHAPE_RECOGNITION_HOLD_MS, type ShapeRecognition } from "../tools/ShapeRecognizer";
import { boundingShapeFromSelection, filterSelectableStrokes, selectStrokes, selectionShapeArea, shapeBounds, shapeContainsPoint, translateShape, type SelectionShape } from "../tools/LassoTool";
import { drawHighlighterStroke } from "../tools/HighlighterTool";
import {
  drawLaserStroke,
  laserTrailStillVisible,
  mapLaserPoints
} from "../tools/LaserTool";
import { drawGraphiteStroke, seedFromId } from "../tools/PencilTool";
import { drawPenStroke } from "../tools/PenTool";
import { AutosaveQueue } from "../storage/AutosaveQueue";
import { createDocumentIdentity } from "../storage/DocumentIdentity";
import { RecoveryRepository } from "../storage/RecoveryRepository";
import { SaveCoordinator, type CloseChoice } from "../storage/SaveCoordinator";
import { SidecarRepository } from "../storage/SidecarRepository";
import { pickNewerSidecar, serializeSidecar, countSidecarStrokes, countSidecarTexts, type SidecarSchemaV1 } from "../storage/SidecarSchema";
import type { VaultSyncWriter } from "../storage/VaultSyncWriter";
import { AnnotationToolbar, type MoreAction } from "../ui/AnnotationToolbar";
import { inkBackingSize } from "./inkBackingSize";
import type { DebugState } from "../ui/DebugPanel";
import { SelectionToolbar, type ViewportPoint } from "../ui/SelectionToolbar";
import { SessionLogger, type DrawPositionLog, type ViewStateSource } from "../logging/SessionLogger";
import type { VaultLogSink } from "../logging/VaultLogSink";
import type { PdfViewState } from "../integration/ObsidianPdfAdapter";
import { describeScrollElement } from "../integration/PdfScrollRoot";
import { TextAnnotationSession } from "../text/TextAnnotationSession";
import { AddTextAnnotationCommand, DeleteTextAnnotationsCommand, ReplaceTextAnnotationCommand } from "../text/TextAnnotationCommands";
import type { TextStyleChange } from "../ui/TextDropdown";
import { insertStyledText, readTextRuns, renderTextRuns, rescaleTextRuns, restoreSelection, selectionOffsets, type TextSelectionOffsets } from "../text/RichTextDom";
import { normalizeTextRuns, patchTextRunRange, plainTextFromRuns, plainTextToRuns, styleAtTextOffset } from "../text/RichTextRuns";
import {
  emitHnDevProbeDiagnostic,
  isHnDevProbeActive,
  type HnDevProbeDiagnostic,
  type HnDevProbeMetric
} from "./DevProbeDiagnostics";

const INPUT_OWNER_REGISTRY_KEY = "__nativePdfHandwritingInputOwners";
const detachedInputOwners = new WeakMap<HTMLElement, ViewerInkSession>();

function inputOwners(pageElement: HTMLElement): WeakMap<HTMLElement, ViewerInkSession> {
  // Page elements belong to a specific Obsidian window. Keep ownership there
  // so a pop-out PDF gets the same duplicate-router protection as the main UI.
  const root = pageElement.ownerDocument.defaultView as (Window & {
    [INPUT_OWNER_REGISTRY_KEY]?: WeakMap<HTMLElement, ViewerInkSession>;
  }) | null;
  if (!root) return detachedInputOwners;
  if (!root[INPUT_OWNER_REGISTRY_KEY]) root[INPUT_OWNER_REGISTRY_KEY] = new WeakMap<HTMLElement, ViewerInkSession>();
  return root[INPUT_OWNER_REGISTRY_KEY];
}

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
  mouseDragScrollEnabled?(): boolean;
  simplifyStrokesEnabled?(): boolean;
  toolbarPlacement?: () => ToolbarPlacement;
  vaultLog?: VaultLogSink;
  /** Enables diagnostics that would otherwise add avoidable input-path work. */
  debugEnabled?: () => boolean;
  /** PDF++/viewer reload detached our DOM — plugin should drop session and rescan. */
  onDetached?: () => void;
  /** Sync filesystem writer for unload/detach — flush must not race async vault I/O. */
  writeSync?: VaultSyncWriter | null;
  /** Monotonic epoch per document so a replaced session cannot overwrite a newer one. */
  claimPersistEpoch?: (documentId: string) => number;
  livePersistEpoch?: (documentId: string) => number;
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

interface PageSurface {
  page: PdfPageInfo;
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Ephemeral active-stroke layer. The committed ink canvas stays untouched while drawing. */
  draftCanvas: HTMLCanvasElement;
  textLayer: HTMLElement;
  context: CanvasRenderingContext2D;
  draftContext: CanvasRenderingContext2D;
  /** Committed-stroke cache — blit for live draw + zoom settle before HQ rebuild. */
  inkLayer: HTMLCanvasElement | null;
  inkLayerContext: CanvasRenderingContext2D | null;
  inkLayerValid: boolean;
  router: PointerRouter | null;
  livePaintFrame: number | null;
  pendingLivePaint: { kind: "draw" | "edit"; syncText: boolean; sampleCount: number; event?: PointerEvent } | null;
  /** Prefix of editPath already represented by the destructive live eraser preview. */
  liveEraserPaintedPoints: number;
  builder: StrokeBuilder | undefined;
  /** True while the live StrokeBuilder is a non-persisted laser draft. */
  laserDraft: boolean;
  /** Samples dropped from the current ephemeral laser draft. */
  laserDiscardedPoints: number;
  shapeHoldTimer: number | null;
  shapePreview: PdfPoint[] | null;
  shapeResize: ShapeResize | null;
  editPath: PdfPoint[];
  editTool: "eraser" | "lasso" | undefined;
  eraserSize: number | undefined;
  eraserWholeStrokes: boolean | undefined;
  textIntent: { start: PdfPoint; hit: PdfTextAnnotation | null; pointerType: string } | null;
}

interface ActiveTextEditor {
  surface: PageSurface;
  existing: PdfTextAnnotation | null;
  draft: PdfTextAnnotation;
  style: TextStyle;
  /** Canonical text formatting; DOM is synchronized after input but not re-rendered. */
  runs: PdfTextRun[];
  /** Last root-relative selection, retained while a toolbar takes focus. */
  selection: TextSelectionOffsets | null;
  /** Formatting used for the next insertion after a collapsed style change. */
  insertionStyle: TextStyle;
  pendingInsertionStyle: boolean;
  /** Formatting requested during IME composition; applied after compositionend. */
  deferredStyleChange: TextStyleChange | null;
  element: HTMLElement;
  resizeObserver: ResizeObserver | null;
  abort: AbortController;
  /** IME candidate text is not committed annotation content yet. */
  composing: boolean;
}

interface TextMoveDrag {
  page: number;
  start: PdfPoint;
  before: PdfTextAnnotation;
  preview: PdfTextAnnotation;
}

type TextBoxHandle = "n" | "e" | "s" | "w" | "nw" | "ne" | "sw" | "se";

/** A selection-frame drag; the committed text DOM does not reflow until release. */
interface TextBoxTransformDrag {
  surface: PageSurface;
  pointerId: number;
  start: Pick<PdfPoint, "x" | "y">;
  before: PdfTextAnnotation;
  preview: PdfTextAnnotation;
  mode: "move" | "resize";
  handle: TextBoxHandle;
  /** Static box translated live for Move; resize keeps its text stationary. */
  box: HTMLElement;
  outline: HTMLElement;
  abort: AbortController;
}

interface ShapeResize {
  recognition: ShapeRecognition;
  anchor: PdfPoint;
  handle: PdfPoint;
}

export class ViewerInkSession {
  private readonly ink = new InkSession();
  private readonly texts = new TextAnnotationSession();
  private readonly identity;
  private readonly surfaces = new Map<number, PageSurface>();
  private readonly ownedInputPages = new Set<HTMLElement>();
  private readonly exporter = new PdfExportService();
  private readonly createdAt = new Date().toISOString();
  private readonly toolbar: AnnotationToolbar;
  private readonly selectionToolbar: SelectionToolbar;
  private readonly history: CommandHistory;
  /** Pages dirtied by the next history.execute — avoids full multi-page refresh. */
  private readonly historyDirtyPages = new Set<number>();
  /** Pages already painted by the history callback in this turn. */
  private readonly historyPaintedPages = new Set<number>();
  private readonly autosave: AutosaveQueue<SidecarSchemaV1>;
  private readonly saveCoordinator: SaveCoordinator;
  private selected: InkStroke[] = [];
  private selectedTexts: PdfTextAnnotation[] = [];
  private selectionShape: SelectionShape | null = null;
  private selectionPage: number | null = null;
  private moveDrag: { page: number; start: PdfPoint; before: InkStroke[]; beforeTexts: PdfTextAnnotation[]; beforeShape: SelectionShape } | null = null;
  private movePreview: InkStroke[] | null = null;
  private moveTextPreview: PdfTextAnnotation[] | null = null;
  private moveShapePreview: SelectionShape | null = null;
  private activeTextEditor: ActiveTextEditor | null = null;
  private textMoveDrag: TextMoveDrag | null = null;
  private textBoxTransformDrag: TextBoxTransformDrag | null = null;
  private textToolActive = false;
  private temporaryStylusEraserPointers = 0;
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
  /** Delayed release avoids exposing an ink redraw before PDF.js finishes its own render. */
  private zoomCompositeReleaseFrame: number | null = null;
  private zoomCompositeReleaseTimer: number | null = null;
  private zoomCompositeSettledAt = 0;
  private zoomNativeContentMutations = 0;
  private lastZoomNativeContentAt = 0;
  /** One durable coordinate breadcrumb per page for each text-bearing zoom burst. */
  private readonly zoomTextLayoutLoggedPages = new Set<number>();
  private laserTrails: LaserTrail[] = [];
  private laserFadeFrame: number | null = null;
  private lastLaserPaintAt = 0;
  /** Laser fade loop caps ~30fps — full page repaint every frame is too heavy. */
  private static readonly LASER_FADE_MIN_MS = 32;
  /** Bound CPU, allocations, and canvas commands for high-rate stylus input. */
  private static readonly MAX_LASER_DRAFT_POINTS = 1024;
  private lastZoomSignalAt = 0;
  private zoomCompositing = false;
  private static readonly ZOOM_SETTLE_MS = 120;
  private static readonly ZOOM_ACTIVE_MS = 500;
  /** PDF.js usually swaps canvas/text layers hundreds of ms after scalechanging. */
  private static readonly ZOOM_NATIVE_RENDER_GRACE_MS = 500;
  /** Do not release during the tail of a native page-content replacement burst. */
  private static readonly ZOOM_NATIVE_RENDER_QUIET_MS = 120;
  private inkUpgradeTimer: number | null = null;
  private readonly inkUpgradePages = new Set<number>();
  /** Wait after zoom settle before HQ graphite rebuild — avoids hitching mid-pinch. */
  private static readonly INK_UPGRADE_MS = 280;
  /** Detect back-to-back page paints during handoff (flash proxy). */
  private static readonly FLASH_DOUBLE_PAINT_MS = 50;
  private readonly lastPagePaintAt = new Map<number, { at: number; reason: string }>();
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
    this.logger = new SessionLogger(options.pdfPath, options.vaultLog, options.debugEnabled);
    this.textToolActive = options.settings.toolPreferences.activeTool === "text";
    this.logger.textTool("tool-initial", {
      active: this.textToolActive,
      drawEnabled: this.drawEnabled,
      fontSize: options.settings.toolPreferences.text.fontSize,
      fontFamily: options.settings.toolPreferences.text.fontFamily
    });
    this.toolbar = new AnnotationToolbar({
      ownerDocument: options.adapter.host.ownerDocument,
      preferences: options.settings.toolPreferences,
      autosave: options.settings.autosave,
      drawEnabled: this.drawEnabled,
      supportedMoreActions: ["export", "export-editable", "toolbar-main", "toolbar-left", "toolbar-right"],
      callbacks: {
        onPreferencesChange: (preferences, reason = "general") => {
          const wasTextToolActive = this.textToolActive;
          this.textToolActive = preferences.activeTool === "text";
          if (wasTextToolActive !== this.textToolActive) {
            this.logger.textTool(this.textToolActive ? "tool-activate" : "tool-deactivate", {
              activeTool: preferences.activeTool,
              drawEnabled: this.drawEnabled,
              textBoxesInteractable: this.textBoxesInteractable()
            });
            // A deactivated Text tool must not leave its contenteditable over
            // the page: it blocks normal static-text rendering until another
            // click happens to commit or discard it.
            if (!this.textToolActive) this.commitActiveTextEditor("tool-deactivate");
          }
          if (!this.textBoxesInteractable()) this.cancelTextBoxTransform("tool-change", false);
          const logTextPreferenceSave = wasTextToolActive || this.textToolActive;
          if (logTextPreferenceSave) {
            this.logger.textTool("preferences-save-start", {
              activeTool: preferences.activeTool,
              fontSize: preferences.text.fontSize,
              fontFamily: preferences.text.fontFamily
            });
          }
          void options.saveSettings(preferences).then(() => {
            if (logTextPreferenceSave) this.logger.textTool("preferences-save-complete", { activeTool: preferences.activeTool });
          }).catch((error) => {
            if (logTextPreferenceSave) {
              this.logger.textTool("preferences-save-error", {
                activeTool: preferences.activeTool,
                error: this.errorMessage(error)
              });
            }
          });
          // Text-style changes synchronously update the focused editor, or
          // refresh just the selected text annotations. A full session refresh
          // here redraws every page a second time and makes font-size changes
          // visibly laggy.
          // Tool/style preference changes must not invalidate committed ink —
          // color/width/opacity only affect future strokes; rebuilding after a
          // zoom blit looks like strokes "snapping" to a new color.
          if (reason === "text-style") return;
          if (reason === "tool") {
            this.refreshToolChrome("tool-chrome");
            return;
          }
          this.refreshToolChrome("preferences");
        },
        onEraserSizePreview: () => {
          this.refreshSurfaceCursors();
        },
        onTextStyleChange: (change) => this.applyTextStyleToActiveEditor(change),
        onTextFormatPointerDown: () => this.captureActiveTextSelection("toolbar-pointerdown"),
        activeTextStyle: () => this.activeTextStyle(),
        onDrawModeChange: (enabled) => {
          this.drawEnabled = enabled;
          if (!enabled) this.clearSelection();
          this.logMousePanConfig("draw-mode");
          // Chrome/cursors only — full refresh invalidates ink and flashes after zoom blit.
          this.refreshToolChrome("draw-mode");
        },
        onUndo: () => this.applyTextHistory("undo"),
        onRedo: () => this.applyTextHistory("redo"),
        onSave: () => this.manualSave(),
        onMore: (action) => void this.handleMore(action),
        toolbarPlacement: () => this.options.toolbarPlacement?.() ?? this.options.settings.toolbarPlacement
      }
    });
    this.selectionToolbar = new SelectionToolbar({
      onDelete: () => this.deleteSelection(),
      onDuplicate: () => this.duplicateSelection(),
      onRecolor: (color) => this.recolorSelection(color),
      onClear: () => this.clearSelection()
    }, options.adapter.host.ownerDocument);
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
            textCount: this.texts.all().length,
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
      this.paintAfterHistory();
    });
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        // Zoom already drives scheduleZoomRepaint via scalechanging — skip twin resize storms.
        if (this.zoomCompositing || this.isZoomGestureActive()) return;
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
        if (target.closest(".native-pdf-handwriting-toolbar, .native-pdf-handwriting-dropdown, .native-pdf-handwriting-selection-toolbar")) return false;
        // The native PDF sidebar and its resize handle share the leaf host but
        // must keep their own pointer handling. Only pan from the PDF viewport.
        return adapter.root.contains(target);
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

  private scheduleRefresh(reason: string, repaintOnly = false): void {
    if (this.destroyed) return;
    if (repaintOnly) {
      this.scheduleZoomRepaint(reason, this.options.adapter.getViewState().scale);
      return;
    }
    // Mount resize ticks arm ZOOM_ACTIVE_MS; create must still full-refresh and
    // is not a mid-gesture flash risk — skip the interrupt noise.
    if (this.isZoomGestureActive() && reason !== "create") {
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

  /**
   * Development-only cross-plugin telemetry. The dedicated probe must opt in
   * on this window; HN keeps no telemetry history and never writes it to the
   * vault. Calls are lifecycle-level rather than input-path instrumentation.
   */
  private reportDevProbe(
    type: HnDevProbeDiagnostic["type"],
    metrics: Record<string, HnDevProbeMetric>
  ): void {
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!isHnDevProbeActive(view)) return;
    emitHnDevProbeDiagnostic(view, {
      version: 1,
      source: "handwriting-natively",
      type,
      documentId: this.identity.id,
      at: performance.now(),
      metrics
    });
  }

  private scheduleZoomRepaint(reason: string, scale?: number): void {
    if (this.destroyed) return;
    const now = performance.now();
    this.lastZoomSignalAt = now;
    if (!this.zoomBurstStartedAt || now - this.zoomBurstStartedAt > ViewerInkSession.ZOOM_ACTIVE_MS) {
      this.zoomBurstStartedAt = now;
      this.zoomTickCount = 0;
      this.zoomBurstScaleStart = scale ?? null;
      this.zoomTextLayoutLoggedPages.clear();
      this.reportDevProbe("zoom-burst-start", {
        reason,
        scale: scale ?? null,
        surfaces: this.surfaces.size
      });
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
      this.zoomCompositeSettledAt = performance.now();
      this.logger.zoomComposite("settle-paint", { pages: this.surfaces.size, burstTicks });
      this.repaintSurfaces(this.zoomBurstReason, {
        burstTicks,
        burstDurationMs,
        ...(scaleStart !== null ? { scaleStart } : {}),
        ...(scaleEnd !== null ? { scaleEnd } : {})
      });
      this.reportDevProbe("zoom-settled", {
        reason: this.zoomBurstReason,
        ticks: burstTicks,
        durationMs: burstDurationMs,
        scaleStart,
        scaleEnd,
        surfaces: this.surfaces.size
      });
      this.releaseZoomCompositeAfterNativeRender();
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
    this.cancelZoomCompositeRelease();
    this.cancelInkLayerUpgrades();
    this.zoomCompositeSettledAt = 0;
    this.zoomNativeContentMutations = 0;
    this.lastZoomNativeContentAt = 0;
    this.zoomCompositing = true;
    for (const surface of this.surfaces.values()) {
      this.captureInkLayerFromCanvas(surface);
      surface.overlay.classList.add("native-pdf-handwriting-zoom-compositing");
    }
    this.logger.zoomComposite("begin", { pages: this.surfaces.size });
  }

  private endZoomCompositing(): void {
    this.zoomCompositing = false;
    // Do not drain HQ upgrades here — CSS handoff still holds the overlay.
    // releaseZoomCompositeLayers() drains after the compositing class is removed.
  }

  /** True while burst paint is frozen OR CSS handoff has not released yet. */
  private isZoomHandoffActive(): boolean {
    if (this.zoomCompositing) return true;
    if (this.zoomCompositeReleaseTimer !== null || this.zoomCompositeReleaseFrame !== null) return true;
    for (const surface of this.surfaces.values()) {
      if (surface.overlay.classList.contains("native-pdf-handwriting-zoom-compositing")) return true;
    }
    return false;
  }

  private hasZoomCompositingClass(): boolean {
    for (const surface of this.surfaces.values()) {
      if (surface.overlay.classList.contains("native-pdf-handwriting-zoom-compositing")) return true;
    }
    return false;
  }

  /**
   * PDF.js asynchronously replaces its canvas/text layers after scalechanging.
   * Keep our already-positioned layer over that native transition, then allow
   * two browser paints only after the native replacement has gone quiet.
   */
  private releaseZoomCompositeAfterNativeRender(): void {
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) {
      this.releaseZoomCompositeLayers();
      return;
    }
    this.cancelZoomCompositeRelease();
    const now = performance.now();
    const settledAt = this.zoomCompositeSettledAt || now;
    const nativeRenderReadyAt = settledAt + ViewerInkSession.ZOOM_NATIVE_RENDER_GRACE_MS;
    const nativeContentQuietAt = this.lastZoomNativeContentAt > 0
      ? this.lastZoomNativeContentAt + ViewerInkSession.ZOOM_NATIVE_RENDER_QUIET_MS
      : nativeRenderReadyAt;
    const releaseAt = Math.max(nativeRenderReadyAt, nativeContentQuietAt);
    const delayMs = Math.max(0, releaseAt - now);
    this.logger.zoomComposite("release-scheduled", {
      pages: this.surfaces.size,
      delayMs: roundMs(delayMs),
      nativeContentMutations: this.zoomNativeContentMutations,
      sinceSettleMs: roundMs(now - settledAt)
    });
    this.zoomCompositeReleaseTimer = window.setTimeout(() => {
      this.zoomCompositeReleaseTimer = null;
      this.zoomCompositeReleaseFrame = view.requestAnimationFrame(() => {
        this.zoomCompositeReleaseFrame = view.requestAnimationFrame(() => {
          this.zoomCompositeReleaseFrame = null;
          if (this.destroyed || this.zoomCompositing) return;
          this.releaseZoomCompositeLayers();
        });
      });
    }, delayMs);
  }

  /** Adapter breadcrumb for the native PDF.js canvas/text layer replacement. */
  onPdfPageContentMutation(recordCount: number): void {
    if (this.destroyed) return;
    const pages = this.options.adapter.pages();
    const detachedOverlayPages = [...this.surfaces.entries()]
      .filter(([pageNumber, surface]) => !surface.overlay.isConnected && pages.some((page) => page.pageNumber === pageNumber && page.element.isConnected))
      .map(([pageNumber]) => pageNumber);
    if (detachedOverlayPages.length > 0) {
      this.logger.zoomFlashProxy("overlay-disconnected", {
        pages: detachedOverlayPages,
        zoomCompositing: this.zoomCompositing,
        handoff: this.isZoomHandoffActive()
      });
    }
    const reattached = detachedOverlayPages.length > 0 && this.tryReattachDisconnectedSurfaces(pages);
    const reattachedOverlayPages = reattached
      ? detachedOverlayPages.filter((pageNumber) => this.surfaces.get(pageNumber)?.overlay.isConnected)
      : [];
    const releasePending = this.zoomCompositing
      || this.zoomCompositeReleaseTimer !== null
      || this.zoomCompositeReleaseFrame !== null;
    this.reportDevProbe("host-page-content-mutation", {
      records: recordCount,
      releasePending,
      zoomCompositing: this.zoomCompositing,
      handoff: this.isZoomHandoffActive(),
      pageCount: pages.length,
      detachedOverlays: detachedOverlayPages.length,
      reattachedOverlays: reattachedOverlayPages.length
    });

    // A native redraw can remove our overlay even after the compositor's
    // handoff. Recover that rare case without treating every canvas/text-layer
    // update as a page remount (which was the source of zoom flashing).
    if (!releasePending && !reattached) return;
    const now = performance.now();
    if (releasePending) {
      this.zoomNativeContentMutations += recordCount;
      this.lastZoomNativeContentAt = now;
    }
    this.logger.zoomComposite("native-content", {
      records: recordCount,
      nativeContentMutations: this.zoomNativeContentMutations,
      releasePending,
      pageCount: pages.length,
      detachedOverlayPages,
      reattachedOverlayPages,
      sinceSettleMs: this.zoomCompositeSettledAt > 0 ? roundMs(now - this.zoomCompositeSettledAt) : null
    });

    if (reattached) {
      // During CSS handoff, layout-only — full stroke redraw flashes over the held bitmap.
      if (this.isZoomHandoffActive()) {
        this.syncZoomOverlayLayouts();
        this.logger.zoomFlashProxy("reattach-layout-only", {
          reattachedOverlayPages,
          skippedRepaint: true
        });
      } else {
        this.repaintSurfaces("native-content-reattach");
      }
    }
    if (releasePending && !this.zoomCompositing) this.releaseZoomCompositeAfterNativeRender();
  }

  private releaseZoomCompositeLayers(): void {
    const now = performance.now();
    if (this.lastZoomNativeContentAt > 0) {
      const msSinceNative = now - this.lastZoomNativeContentAt;
      if (msSinceNative < ViewerInkSession.ZOOM_NATIVE_RENDER_QUIET_MS) {
        this.logger.zoomFlashProxy("release-while-native-mutating", {
          msSinceNative: roundMs(msSinceNative),
          nativeContentMutations: this.zoomNativeContentMutations
        });
      }
    }
    const pendingUpgrades = this.inkUpgradePages.size;
    for (const surface of this.surfaces.values()) {
      surface.overlay.classList.remove("native-pdf-handwriting-zoom-compositing");
    }
    this.logger.zoomComposite("release", {
      pages: this.surfaces.size,
      nativeContentMutations: this.zoomNativeContentMutations,
      heldAfterSettleMs: this.zoomCompositeSettledAt > 0 ? roundMs(now - this.zoomCompositeSettledAt) : null,
      pendingUpgrades
    });
    this.reportDevProbe("zoom-composite-release", {
      pages: this.surfaces.size,
      nativeContentMutations: this.zoomNativeContentMutations,
      heldAfterSettleMs: this.zoomCompositeSettledAt > 0 ? roundMs(now - this.zoomCompositeSettledAt) : null,
      pendingUpgrades
    });
    this.zoomCompositeSettledAt = 0;
    // HQ graphite rebuild only after the compositing class is gone (avoids clear/rebuild flash).
    if (pendingUpgrades > 0) {
      if (this.inkUpgradeTimer !== null) {
        window.clearTimeout(this.inkUpgradeTimer);
        this.inkUpgradeTimer = null;
      }
      this.inkUpgradeTimer = window.setTimeout(() => {
        this.inkUpgradeTimer = null;
        this.drainInkLayerUpgrades();
      }, 0);
    }
  }

  private cancelZoomCompositeRelease(): void {
    if (this.zoomCompositeReleaseFrame !== null) {
      this.options.adapter.host.ownerDocument.defaultView?.cancelAnimationFrame(this.zoomCompositeReleaseFrame);
      this.zoomCompositeReleaseFrame = null;
    }
    if (this.zoomCompositeReleaseTimer !== null) {
      window.clearTimeout(this.zoomCompositeReleaseTimer);
      this.zoomCompositeReleaseTimer = null;
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
      this.syncTextLayoutDuringZoom(surface);
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
    const durationMs = roundMs(performance.now() - started);
    if (durationMs >= 16 && this.isZoomHandoffActive()) {
      this.logger.zoomFlashProxy("paint-duration-spike", {
        reason,
        durationMs,
        pagesRepainted: stats.pagesRepainted,
        strokesRedrawn: stats.strokesRedrawn,
        canvasesResized: stats.canvasesResized
      });
    }
    this.logger.zoomRepaint({
      reason,
      durationMs,
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
    if (ViewerInkSession.isZoomPaintReason(reason)) {
      this.reportDevProbe("zoom-repaint", {
        reason,
        durationMs,
        pagesRepainted: stats.pagesRepainted,
        canvasesResized: stats.canvasesResized,
        strokesRedrawn: stats.strokesRedrawn,
        skippedDisconnected: stats.skippedDisconnected,
        scale: Number(view.scale.toFixed(4))
      });
    }
  }

  static async create(options: ViewerInkSessionOptions): Promise<ViewerInkSession> {
    const session = new ViewerInkSession(options);
    options.adapter.setBoostedZoom?.(options.settings.boostedPdfZoom);
    session.persistEpoch = options.claimPersistEpoch?.(session.identity.id) ?? 1;
    const sidecar = await options.sidecars.load(session.identity.id);
    const recovery = await options.recovery.load(session.identity.id);
    const stored = pickNewerSidecar(sidecar, recovery);
    const sidecarStrokes = countSidecarStrokes(sidecar);
    const recoveryStrokes = countSidecarStrokes(recovery);
    const loadedStrokes = countSidecarStrokes(stored);
    const sidecarTexts = countSidecarTexts(sidecar);
    const recoveryTexts = countSidecarTexts(recovery);
    const loadedTexts = countSidecarTexts(stored);
    session.logger.sidecarLoad({
      documentId: session.identity.id,
      sidecarStrokes,
      sidecarTexts,
      recoveryStrokes,
      recoveryTexts,
      loadedStrokes,
      loadedTexts,
      sidecarUpdatedAt: sidecar?.updatedAt ?? null,
      recoveryUpdatedAt: recovery?.updatedAt ?? null
    });
    for (const page of stored?.pages ?? []) {
      if (page.width > 1 && page.height > 1) {
        session.pageMetrics.set(page.page, { width: page.width, height: page.height });
      }
      for (const stroke of page.strokes) session.ink.add(stroke);
      for (const text of page.texts ?? []) session.texts.add(text);
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
      loadedTexts,
      sidecarStrokes,
      sidecarTexts,
      recoveryStrokes,
      recoveryTexts,
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
    if (this.isZoomGestureActive() && reason !== "create") {
      this.logger.zoomRepaintInterrupt(reason, { kind: "full-refresh-during-zoom" });
    }
    if (this.isZoomHandoffActive()) {
      this.logger.zoomFlashProxy("full-refresh-during-handoff", { reason });
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
          this.releaseInputOwner(surface.page.element);
          this.releaseSurfaceBuffers(surface);
          surface.overlay.remove();
          this.surfaces.delete(pageNumber);
          continue;
        }
        if (current.element !== surface.page.element) {
          surface.router?.destroy();
          this.releaseInputOwner(surface.page.element);
          this.releaseSurfaceBuffers(surface);
          surface.overlay.remove();
          this.surfaces.delete(pageNumber);
          continue;
        }
        if (!this.reattachSurface(surface, current)) {
          surface.router?.destroy();
          this.releaseInputOwner(surface.page.element);
          this.releaseSurfaceBuffers(surface);
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
          if (surface) this.releaseSurfaceBuffers(surface);
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

  /** Tool/draw-mode swaps update hit-testing/cursors/text chrome without rebuilding ink pixels. */
  private refreshToolChrome(reason = "tool-chrome"): void {
    this.logger.refresh(reason, {
      selected: this.selected.length,
      surfaces: this.surfaces.size,
      activeTool: this.activeTool(),
      textBoxesInteractable: this.textBoxesInteractable(),
      chromeOnly: true
    });
    for (const surface of this.surfaces.values()) {
      surface.router?.syncToolState();
      this.renderTextAnnotations(surface);
    }
    this.syncAnnotationCursorMode();
    this.refreshSurfaceCursors();
    this.ensureSelectionToolbar();
  }

  /** Prefer page-local ink/text paint after undoable edits; full refresh only for undo/redo. */
  private executeHistory(command: Command, pages?: number | readonly number[] | null): void {
    if (pages != null) {
      for (const page of typeof pages === "number" ? [pages] : pages) {
        if (Number.isFinite(page)) this.historyDirtyPages.add(page);
      }
    }
    this.history.execute(command);
  }

  private paintAfterHistory(): void {
    if (this.historyDirtyPages.size === 0) {
      this.refresh("history");
      return;
    }
    const pages = [...this.historyDirtyPages];
    this.historyDirtyPages.clear();
    this.logger.refresh("history-local", {
      selected: this.selected.length,
      surfaces: this.surfaces.size,
      pages: pages.length
    });
    for (const page of pages) {
      const surface = this.surfaces.get(page);
      if (!surface) continue;
      this.invalidateInkLayer(surface);
      this.renderPage(page);
      this.historyPaintedPages.add(page);
    }
    this.ensureSelectionToolbar();
  }

  private needsPagePaint(page: number): boolean {
    if (this.historyPaintedPages.has(page)) {
      this.historyPaintedPages.delete(page);
      return false;
    }
    return true;
  }

  private ensureSelectionToolbar(options?: { resetPlacement?: boolean }): void {
    const count = this.selected.length + this.selectedTexts.length;
    if (!count || this.selectionPage === null) return;
    if (options?.resetPlacement) this.selectionToolbar.resetPlacement();
    const anchor = this.autoToolbarAnchor();
    this.selectionToolbar.show(count, anchor);
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
    const started = performance.now();
    this.logger.textTool("manual-save-start", { textCount: this.texts.all().length, dirty: this.isDirty() });
    this.toolbar.setSaveStatus("saving");
    try {
      await this.saveCoordinator.manualSave();
      this.toolbar.setSaveStatus("saved", new Date());
      this.options.notice("Annotations saved.");
      this.logger.textTool("manual-save-complete", { textCount: this.texts.all().length, dirty: this.isDirty() });
      this.reportDevProbe("manual-save", { ok: true, durationMs: roundMs(performance.now() - started), dirty: this.isDirty() });
    } catch (error) {
      this.toolbar.setSaveStatus("failed");
      this.options.notice(`Save failed: ${this.errorMessage(error)}`);
      this.logger.textTool("manual-save-error", { textCount: this.texts.all().length, error: this.errorMessage(error) });
      this.reportDevProbe("manual-save", { ok: false, durationMs: roundMs(performance.now() - started) });
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
      textCount: this.texts.all().length,
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
    const textCount = this.texts.all().length;
    if (this.writesAbandoned) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        textCount,
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
        textCount,
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
        textCount: countSidecarTexts(snapshot),
        dirty: false,
        updatedAt: snapshot.updatedAt
      });
    } catch (error) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        textCount,
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
    // A native contenteditable owns every editor shortcut while it is open. The
    // window-level listener may receive a retargeted event from Obsidian, so
    // checking event.target alone is not sufficient here. Cmd/Ctrl+A is the
    // exception: claim it before Obsidian's document shortcuts can move the
    // selection outside this editor.
    if (this.destroyed) return false;
    if (this.handleActiveTextEditorSelectAll(event)) return true;
    if (this.activeTextEditor || shouldIgnoreSelectionShortcut(event.target)) return false;
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

  private handleActiveTextEditorSelectAll(event: KeyboardEvent): boolean {
    const editor = this.activeTextEditor;
    if (!editor || editor.composing || event.isComposing || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "a") return false;
    const targetIsEditor = event.target instanceof Node && editor.element.contains(event.target);
    if (!targetIsEditor && editor.element.ownerDocument.activeElement !== editor.element) return false;

    event.preventDefault();
    event.stopPropagation();
    const range = editor.element.ownerDocument.createRange();
    range.selectNodeContents(editor.element);
    const selection = editor.element.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    this.captureActiveTextSelection("select-all-shortcut");
    this.logText(editor.surface, "select-all-shortcut", {
      annotationId: editor.draft.id,
      characterCount: plainTextFromRuns(editor.runs).length,
      ...this.editorSelectionMetrics(editor.element)
    });
    return true;
  }

  canSelectionShortcut(action: SelectionShortcutAction): boolean {
    if (this.destroyed) return false;
    if (action === "selectAll") return this.drawEnabled;
    if (action === "paste") {
      const clipboard = StrokeClipboard.peek();
      return this.drawEnabled && Boolean(clipboard?.strokes.length || clipboard?.texts.length);
    }
    this.reconcileSelection();
    return this.selected.length > 0 || this.selectedTexts.length > 0;
  }

  applySelectionShortcut(action: SelectionShortcutAction): void {
    this.logger.textTool("selection-shortcut", {
      action,
      page: this.selectionPage,
      textCount: this.selectedTexts.length,
      strokeCount: this.selected.length
    });
    if (action === "selectAll") this.selectAllOnCurrentPage();
    else if (action === "copy") this.copySelection();
    else if (action === "cut") this.cutSelection();
    else if (action === "paste") this.pasteSelection();
    else if (action === "delete") this.deleteSelection();
  }

  private applyTextHistory(action: "undo" | "redo"): void {
    const before = this.texts.all().length;
    const applied = action === "undo" ? this.history.undo() : this.history.redo();
    this.logger.textTool(`history-${action}`, {
      applied,
      textCountBefore: before,
      textCountAfter: this.texts.all().length
    });
  }

  async exportCopy(mode: "flattened" | "editable" = "flattened"): Promise<void> {
    const texts = this.texts.all();
    this.logger.textTool("export-start", {
      mode,
      textCount: texts.length,
      textPageCount: new Set(texts.map((text) => text.page)).size,
      richTextCount: texts.filter((text) => text.runs.length > 1).length,
      unicodeTextCount: texts.filter((text) => /[^\x20-\x7e\n]/.test(text.text)).length
    });
    try {
      await this.autosave.flush(this.identity.id);
      const bytes = await this.exporter.export({
        sourceBytes: await this.options.readSourcePdf(),
        getStrokes: () => this.ink.all(),
        getTexts: () => this.texts.all(),
        mode,
        pageMetrics: this.exportPageMetrics()
      });
      const sourceName = this.options.pdfPath.split("/").pop() ?? "document.pdf";
      const name = mode === "editable" ? editableAnnotatedFilename(sourceName) : annotatedFilename(sourceName);
      const path = await this.options.writeExport(name, bytes);
      this.options.notice(`Exported ${typeof path === "string" ? path : name}. Original PDF unchanged.`);
      this.logger.textTool("export-complete", { mode, textCount: this.texts.all().length, byteCount: bytes.length });
    } catch (error) {
      this.logger.textTool("export-error", { mode, textCount: this.texts.all().length, error: this.errorMessage(error) });
      throw error;
    }
  }

  async destroy(options: { silent?: boolean; alreadyPersisted?: boolean } = {}): Promise<boolean> {
    if (this.destroyed) return true;
    this.commitActiveTextEditor("destroy");
    this.cancelTextBoxTransform("destroy");
    if (this.detachCheckTimer !== null) {
      window.clearTimeout(this.detachCheckTimer);
      this.detachCheckTimer = null;
    }
    const strokeCount = this.ink.all().length;
    const textCount = this.texts.all().length;
    const dirty = this.isDirty();
    const alreadyPersisted = Boolean(options.alreadyPersisted || this.alreadyEmergencyPersisted);
    this.logger.sessionDestroy({
      reason: options.silent ? "silent" : "close",
      silent: Boolean(options.silent),
      strokeCount,
      textCount,
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
    if (this.laserFadeFrame !== null) {
      window.cancelAnimationFrame(this.laserFadeFrame);
      this.laserFadeFrame = null;
    }
    this.laserTrails = [];
    if (this.resizeFrame !== null) {
      window.cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = null;
    }
    if (this.zoomSettleTimer !== null) {
      window.clearTimeout(this.zoomSettleTimer);
      this.zoomSettleTimer = null;
    }
    this.cancelInkLayerUpgrades();
    this.cancelZoomCompositeRelease();
    this.endZoomCompositing();
    this.releaseZoomCompositeLayers();
    this.syncAnnotationCursorMode(false);
    this.resizeObserver?.disconnect();
    for (const surface of this.surfaces.values()) {
      surface.router?.destroy();
      this.releaseInputOwner(surface.page.element);
      this.releaseSurfaceBuffers(surface);
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
    const tool = this.activeTool();
    const hideNativeCursor = enabled
      && (isInkDrawTool(tool) || tool === "eraser");
    this.options.adapter.root.classList.toggle("native-pdf-handwriting-hide-native-cursor", hideNativeCursor);
  }

  /** Physical eraser tips temporarily route as Eraser without changing saved tool choice. */
  private activeTool(): ToolPreferences["activeTool"] {
    return this.temporaryStylusEraserPointers > 0 ? "eraser" : this.options.settings.toolPreferences.activeTool;
  }

  /** Text boxes steal hits only in Text/lasso — pen/eraser/laser must pass through. */
  private textBoxesInteractable(): boolean {
    if (!this.drawEnabled) return false;
    const tool = this.activeTool();
    return tool === "text" || tool === "lasso";
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
    this.claimInputOwner(page.element, page.pageNumber);
    this.rememberPageMetrics(page);
    const overlay = this.options.adapter.mountOverlay(page.pageNumber);
    const canvas = createDetachedEl(overlay.ownerDocument, 'canvas');
    canvas.className = "native-pdf-handwriting-canvas";
    if (this.options.settings.hideStylusAnnotationLabel) canvas.setAttribute("aria-hidden", "true");
    else canvas.setAttribute("aria-label", `Annotations for PDF page ${page.pageNumber}`);
    overlay.append(canvas);
    const draftCanvas = createDetachedEl(overlay.ownerDocument, 'canvas');
    draftCanvas.className = "native-pdf-handwriting-draft-canvas";
    draftCanvas.setAttribute("aria-hidden", "true");
    overlay.append(draftCanvas);
    const textLayer = createDetachedDiv(overlay.ownerDocument);
    textLayer.className = "native-pdf-handwriting-text-layer";
    overlay.append(textLayer);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D rendering is unavailable");
    const draftContext = draftCanvas.getContext("2d");
    if (!draftContext) throw new Error("Canvas 2D rendering is unavailable");
    const surface: PageSurface = {
      page,
      overlay,
      canvas,
      draftCanvas,
      textLayer,
      context,
      draftContext,
      inkLayer: null,
      inkLayerContext: null,
      inkLayerValid: false,
      router: null,
      livePaintFrame: null,
      pendingLivePaint: null,
      liveEraserPaintedPoints: 0,
      builder: undefined,
      laserDraft: false,
      laserDiscardedPoints: 0,
      shapeHoldTimer: null,
      shapePreview: null,
      shapeResize: null,
      editPath: [],
      editTool: undefined,
      eraserSize: undefined,
      eraserWholeStrokes: undefined,
      textIntent: null
    };
    surface.router = this.createPageRouter(surface);
    this.ensurePagePositioning(page.element);
    this.syncOverlayLayout(surface);
    return surface;
  }

  /** Keep exactly one session's page router active for a live PDF page node. */
  private claimInputOwner(pageElement: HTMLElement, page: number): void {
    const owners = inputOwners(pageElement);
    const previous = owners.get(pageElement);
    if (previous && previous !== this) {
      this.logger.inputOwner("supersede", { page });
      void previous.destroy({ silent: true, alreadyPersisted: true });
    }
    owners.set(pageElement, this);
    this.ownedInputPages.add(pageElement);
    this.logger.inputOwner("claim", { page, replaced: Boolean(previous && previous !== this) });
  }

  private releaseInputOwner(pageElement: HTMLElement): void {
    this.ownedInputPages.delete(pageElement);
    const owners = inputOwners(pageElement);
    if (owners.get(pageElement) !== this) return;
    owners.delete(pageElement);
    this.logger.inputOwner("release", { page: pageElement.dataset.pageNumber ?? null });
  }

  private createPageRouter(surface: PageSurface): PointerRouter {
    return new PointerRouter(surface.page.element, {
      activeTool: () => this.activeTool(),
      drawingEnabled: () => this.drawEnabled,
      rightMouseEraserEnabled: () => this.options.settings.toolPreferences.eraser.eraseWithRightMouseButton,
      onStylusEraserStart: () => {
        this.temporaryStylusEraserPointers += 1;
        this.refreshSurfaceCursors();
      },
      onStylusEraserEnd: () => {
        this.temporaryStylusEraserPointers = Math.max(0, this.temporaryStylusEraserPointers - 1);
        this.refreshSurfaceCursors();
      },
      scrollRoot: () => null,
      cursorParent: () => surface.overlay,
      eraserCursorDiameter: () => this.options.settings.toolPreferences.eraser.size * this.displayScale(surface),
      drawCursorColor: () => {
        const prefs = this.options.settings.toolPreferences;
        const activeTool = this.activeTool();
        if (activeTool === "laser") return prefs.laser.color;
        return prefs[resolveDrawingTool(activeTool)].color;
      },
      projectCursor: (clientX, clientY) => this.projectInkScreenPoint(surface, clientX, clientY),
      onStart: (samples, route, event) => this.pointerStart(surface, samples, route, event),
      onMove: (samples, route, event) => this.pointerMove(surface, samples, route, event),
      onEnd: (samples, route, event) => this.pointerEnd(surface, samples, route, event),
      onCancel: (route, event) => this.pointerCancel(surface, route, event),
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

  /** Coalesce visual work to display rate without dropping any input samples. */
  private scheduleLivePaint(
    surface: PageSurface,
    kind: "draw" | "edit",
    sampleCount: number,
    event?: PointerEvent,
    syncText = false
  ): void {
    if (this.destroyed) return;
    const pending = surface.pendingLivePaint;
    const pendingEvent = event ?? pending?.event;
    const nextPaint = {
      kind: pending?.kind === "edit" ? "edit" : kind,
      syncText: Boolean(pending?.syncText || syncText),
      sampleCount: (pending?.sampleCount ?? 0) + sampleCount
    };
    surface.pendingLivePaint = pendingEvent ? { ...nextPaint, event: pendingEvent } : nextPaint;
    if (surface.livePaintFrame !== null) return;
    const view = surface.overlay.ownerDocument.defaultView;
    if (!view) {
      this.paintScheduledLiveWork(surface);
      return;
    }
    surface.livePaintFrame = view.requestAnimationFrame(() => {
      surface.livePaintFrame = null;
      this.paintScheduledLiveWork(surface);
    });
  }

  private paintScheduledLiveWork(surface: PageSurface): void {
    const pending = surface.pendingLivePaint;
    surface.pendingLivePaint = null;
    if (!pending || this.destroyed) return;
    const startedAt = performance.now();
    if (pending.kind === "draw") this.renderLiveDrawPreview(surface);
    else if (surface.editTool === "eraser") this.renderLiveEraserPreview(surface);
    else this.renderPage(surface.page.pageNumber, undefined, "live-edit", pending.syncText);
    this.logger.inputPaint(surface.page.pageNumber, performance.now() - startedAt, pending.kind, pending.sampleCount);
    if (pending.event && this.logger.isEnabled()) this.updateDebug(surface, pending.event);
  }

  /** A terminal input event owns the final synchronous paint, never a stale frame callback. */
  private cancelLivePaint(surface: PageSurface): void {
    if (surface.livePaintFrame !== null) {
      surface.overlay.ownerDocument.defaultView?.cancelAnimationFrame(surface.livePaintFrame);
      surface.livePaintFrame = null;
    }
    surface.pendingLivePaint = null;
  }

  private clearLiveDrawPreview(surface: PageSurface): void {
    const { draftCanvas, draftContext } = surface;
    if (!draftCanvas.width || !draftCanvas.height) return;
    draftContext.setTransform(1, 0, 0, 1, 0, 0);
    draftContext.clearRect(0, 0, draftCanvas.width, draftCanvas.height);
  }

  /** Drop detached page bitmaps and their scheduled work promptly. */
  private releaseSurfaceBuffers(surface: PageSurface): void {
    this.cancelLivePaint(surface);
    surface.canvas.width = 0;
    surface.canvas.height = 0;
    surface.draftCanvas.width = 0;
    surface.draftCanvas.height = 0;
    if (surface.inkLayer) {
      surface.inkLayer.width = 0;
      surface.inkLayer.height = 0;
    }
    surface.inkLayer = null;
    surface.inkLayerContext = null;
    surface.inkLayerValid = false;
    surface.liveEraserPaintedPoints = 0;
  }

  /**
   * Paint the active stroke into a disposable layer. This keeps the committed
   * canvas cache, text boxes, and full-stroke renderer out of the pointer path.
   */
  private renderLiveDrawPreview(surface: PageSurface): void {
    const builder = surface.builder;
    if (!builder || surface.laserDraft) return;
    const layout = this.pageLayout(surface);
    const rect = surface.overlay.getBoundingClientRect();
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    const { pixelWidth, pixelHeight, backingScale } = inkBackingSize(
      width,
      height,
      window.devicePixelRatio || 1
    );

    // A viewport change is uncommon while drawing. Let the canonical renderer
    // rebuild committed ink once, then keep the active stroke isolated in its
    // draft layer rather than painting it twice.
    if (surface.canvas.width !== pixelWidth || surface.canvas.height !== pixelHeight) {
      this.renderPage(surface.page.pageNumber, undefined, "live-draw-rebase", false, false);
    }
    if (surface.draftCanvas.width !== pixelWidth || surface.draftCanvas.height !== pixelHeight) {
      surface.draftCanvas.width = pixelWidth;
      surface.draftCanvas.height = pixelHeight;
    }

    const context = surface.draftContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, pixelWidth, pixelHeight);
    context.setTransform(backingScale, 0, 0, backingScale, 0, 0);

    const points = surface.shapePreview ?? builder.preview(this.simplifyStrokesEnabled());
    if (!points.length) return;
    const mapper = this.mapper(surface);
    const viewPoints = points.map((point) => mapper.toViewport(point));
    const style = builder.style;
    const latest = points.at(-1)!;
    const preferences = this.options.settings.toolPreferences[style.tool];
    const scale = this.displayScale(surface);
    const pressure = preferences.pressureSensitivity ? Math.max(0.2, latest.pressure) : 1;
    const widthScale = style.tool === "highlighter" ? 1 : 0.65 + pressure * 0.35;

    context.save();
    context.globalAlpha = style.tool === "pencil" ? style.opacity * 0.72 : style.opacity;
    context.strokeStyle = style.color;
    context.fillStyle = style.color;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(style.tool === "highlighter" ? 2 : 0.5, style.width * scale * widthScale);
    const first = viewPoints[0]!;
    if (viewPoints.length === 1) {
      context.beginPath();
      context.arc(first.x, first.y, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.beginPath();
      context.moveTo(first.x, first.y);
      for (const point of viewPoints.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
    context.restore();
  }

  /**
   * Erasing the display bitmap is O(new input samples), while exact stroke
   * fragmentation is O(stroke segments × full eraser path). The exact model
   * update still happens once at pointer-up; cancel/repaint restores this
   * disposable bitmap immediately.
   */
  private renderLiveEraserPreview(surface: PageSurface): void {
    const eraserSize = surface.eraserSize;
    if (eraserSize === undefined || surface.editPath.length === 0) return;
    const layout = this.pageLayout(surface);
    const rect = surface.overlay.getBoundingClientRect();
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    const { pixelWidth, pixelHeight, backingScale } = inkBackingSize(width, height, window.devicePixelRatio || 1);
    if (surface.canvas.width !== pixelWidth || surface.canvas.height !== pixelHeight) {
      this.renderPage(surface.page.pageNumber, undefined, "live-eraser-rebase", false, false);
      surface.liveEraserPaintedPoints = 0;
    }

    if (surface.liveEraserPaintedPoints >= surface.editPath.length) return;
    // Continue from the prior endpoint so each new packet erases the capsule
    // between frames instead of leaving a visible gap at the frame boundary.
    const pending = surface.editPath.slice(Math.max(0, surface.liveEraserPaintedPoints - 1));
    const mapper = this.mapper(surface);
    const points = pending.map((point) => mapper.toViewport(point));
    const context = surface.context;
    context.save();
    context.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "destination-out";
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(1, eraserSize * this.displayScale(surface));
    const first = points[0]!;
    context.beginPath();
    if (points.length === 1) {
      context.arc(first.x, first.y, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(first.x, first.y);
      for (const point of points.slice(1)) context.lineTo(point.x, point.y);
      context.stroke();
    }
    context.restore();
    surface.liveEraserPaintedPoints = surface.editPath.length;
  }

  private pointerStart(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void {
    const preferences = this.options.settings.toolPreferences;
    const activeTool = this.activeTool();
    // Keep the existing one-click close behavior for a live editor before
    // considering persisted annotation selection.
    if (route === "text" && this.activeTextEditor) {
      this.beginTextIntent(surface, samples[0]!, event);
      return;
    }
    // Content clicks always edit text. Moving a selected text box is reserved
    // for its NPDE-style frame edge, so a click on the selected words cannot
    // be mistaken for a zero-distance selection drag.
    if (route === "text" && event.target instanceof Element && event.target.closest(".native-pdf-handwriting-text-box")) {
      this.beginTextIntent(surface, samples[0]!, event);
      return;
    }
    // Selected annotations take priority over the current tool. Otherwise, the
    // text tool turns a drag in an existing selection into a new-text intent.
    if (this.tryStartSelectionMove(surface, samples[0]!)) {
      this.scheduleLivePaint(surface, "edit", samples.length, event, true);
      return;
    }
    if (route === "text") {
      if (this.selected.length || this.selectedTexts.length) {
        const point = this.toPdfPoint(surface, samples[0]!, true);
        this.logger.textTool("selection-clear-click-away", {
          page: surface.page.pageNumber,
          selectedPage: this.selectionPage,
          textCount: this.selectedTexts.length,
          strokeCount: this.selected.length,
          x: round(point.x),
          y: round(point.y)
        });
        this.clearSelection();
        return;
      }
      this.beginTextIntent(surface, samples[0]!, event);
      return;
    }
    if (route === "draw") {
      const laser = activeTool === "laser";
      if (laser) {
        const laserPrefs = preferences.laser;
        surface.laserDraft = true;
        surface.laserDiscardedPoints = 0;
        surface.builder = new StrokeBuilder({
          id: this.id(),
          page: surface.page.pageNumber,
          tool: "pen",
          color: laserPrefs.color,
          width: laserPrefs.width,
          opacity: laserPrefs.opacity,
          inputType: event.pointerType === "pen" ? "pen" : "mouse",
          stabilization: "medium"
        });
        for (const point of this.toPdfPoints(surface, samples, false)) surface.builder.add(point);
        this.trimLaserDraft(surface, performance.now());
        const first = surface.builder.preview(true)[0];
        if (first) {
          this.lastPointerPdf = { x: first.x, y: first.y };
          this.logDraw(surface, "start", "laser", [first]);
        }
        this.logPositionAlign(surface, samples[0]!, "start");
        this.ensureLaserFadeLoop();
      } else {
        surface.laserDraft = false;
        const tool = resolveDrawingTool(activeTool);
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
        for (const point of this.toPdfPoints(surface, samples, drawing.simulateMousePressure)) surface.builder.add(point);
        const first = surface.builder.preview(this.simplifyStrokesEnabled())[0];
        if (first) {
          this.lastPointerPdf = { x: first.x, y: first.y };
          this.logDraw(surface, "start", tool, [first]);
        }
        this.logPositionAlign(surface, samples[0]!, "start");
        if (isDrawingTool(activeTool)) this.scheduleHeldShape(surface);
      }
    } else {
      if (activeTool === "lasso" && (this.selected.length > 0 || this.selectedTexts.length > 0)) {
        const point = this.toPdfPoint(surface, samples[0]!, true);
        if (!this.selectionShape || this.selectionPage !== surface.page.pageNumber || !shapeContainsPoint(this.selectionShape, point)) {
          const clearedPage = this.selectionPage;
          // Caller always renderPage(surface) below — only paint a different page here.
          this.clearSelection({ refresh: false });
          if (clearedPage != null && clearedPage !== surface.page.pageNumber) {
            this.paintAfterClearSelection(clearedPage);
          }
        }
      }
      surface.editTool = activeTool === "eraser" || this.isRightMouseEraser(event) ? "eraser" : "lasso";
      surface.eraserSize = surface.editTool === "eraser" ? preferences.eraser.size : undefined;
      surface.eraserWholeStrokes = surface.editTool === "eraser" ? preferences.eraser.eraseWholeStrokes : undefined;
      surface.editPath = this.toPdfPoints(surface, samples, true);
      surface.liveEraserPaintedPoints = 0;
      if (surface.editPath[0]) this.lastPointerPdf = { x: surface.editPath[0].x, y: surface.editPath[0].y };
    }
    if (route === "draw" && !surface.laserDraft) this.scheduleLivePaint(surface, "draw", samples.length, event);
    else if (route === "edit") this.scheduleLivePaint(surface, "edit", samples.length, event);
  }

  private pointerMove(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void {
    if (this.moveDrag?.page === surface.page.pageNumber) {
      const current = this.toPdfPoint(surface, samples.at(-1)!, true);
      const dx = current.x - this.moveDrag.start.x;
      const dy = current.y - this.moveDrag.start.y;
      this.movePreview = translateStrokes(this.moveDrag.before, dx, dy);
      this.moveTextPreview = this.translateTextAnnotations(this.moveDrag.beforeTexts, dx, dy);
      this.moveShapePreview = translateShape(this.moveDrag.beforeShape, dx, dy);
      this.scheduleLivePaint(surface, "edit", samples.length, event, true);
      return;
    }
    if (route === "text") {
      this.updateTextIntent(surface, samples.at(-1)!, event);
      return;
    }
    if (route === "draw" && surface.builder) {
      const simulate = surface.laserDraft
        ? false
        : this.options.settings.toolPreferences[
          resolveDrawingTool(this.activeTool())
        ].simulateMousePressure;
      const points = this.toPdfPoints(surface, samples, simulate);
      for (const point of points) surface.builder.add(point);
      const lastPoint = points.at(-1);
      if (lastPoint) this.resizeLockedShape(surface, lastPoint);
      const last = samples.at(-1);
      if (last) this.logPositionAlign(surface, last, "move");
      if (surface.laserDraft) {
        this.trimLaserDraft(surface, performance.now());
        this.ensureLaserFadeLoop();
      }
      if (isDrawingTool(this.activeTool()) && !surface.shapeResize) this.scheduleHeldShape(surface);
    } else if (route === "edit") {
      surface.editPath.push(...this.toPdfPoints(surface, samples, true));
    }
    // The laser fade loop owns live laser painting. Rendering each pointer event
    // duplicates full-canvas work and falls behind high-rate stylus input.
    if (!surface.laserDraft) this.scheduleLivePaint(surface, route === "draw" ? "draw" : "edit", samples.length, event);
  }

  private pointerEnd(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit" | "text", event: PointerEvent): void {
    this.cancelLivePaint(surface);
    if (this.moveDrag?.page === surface.page.pageNumber) {
      const current = this.toPdfPoint(surface, samples.at(-1)!, true);
      const dx = current.x - this.moveDrag.start.x;
      const dy = current.y - this.moveDrag.start.y;
      const drag = this.moveDrag;
      if (dx !== 0 || dy !== 0) {
        const afterStrokes = translateStrokes(drag.before, dx, dy);
        const afterTexts = this.translateTextAnnotations(drag.beforeTexts, dx, dy);
        this.executeHistory(new ReplaceAnnotationSelectionCommand(
          this.ink,
          drag.before,
          afterStrokes,
          this.texts,
          drag.beforeTexts,
          afterTexts
        ), surface.page.pageNumber);
        this.selected = afterStrokes;
        this.selectedTexts = afterTexts;
        this.selectionShape = translateShape(drag.beforeShape, dx, dy);
        this.logText(surface, "selection-move-commit", {
          strokeCount: afterStrokes.length,
          textCount: afterTexts.length,
          dx: round(dx),
          dy: round(dy)
        });
      }
      this.moveDrag = null;
      this.movePreview = null;
      this.moveTextPreview = null;
      this.moveShapePreview = null;
      this.updateDebug(surface, event);
      if (this.needsPagePaint(surface.page.pageNumber)) this.renderPage(surface.page.pageNumber);
      return;
    }
    if (route === "text") {
      this.finishTextIntent(surface, samples.at(-1)!, event);
      return;
    }
    if (route === "draw" && surface.builder) {
      this.cancelHeldShape(surface);
      const laserDraft = surface.laserDraft;
      const simulate = laserDraft
        ? false
        : this.options.settings.toolPreferences[
          resolveDrawingTool(this.activeTool())
        ].simulateMousePressure;
      const points = this.toPdfPoints(surface, samples, simulate);
      for (const point of points) surface.builder.add(point);
      const lastPoint = points.at(-1);
      if (lastPoint) this.resizeLockedShape(surface, lastPoint);
      if (laserDraft) this.trimLaserDraft(surface, performance.now());
      // Match live preview geometry — finish()+simplify reshapes the path → visible snap.
      const stroke = surface.builder.finishMatchingPreview(
        laserDraft ? true : this.simplifyStrokesEnabled()
      );
      if (surface.shapePreview?.length) {
        stroke.points = surface.shapePreview;
      }
      const shapeResize = surface.shapeResize;
      surface.builder = undefined;
      surface.laserDraft = false;
      surface.shapePreview = null;
      surface.shapeResize = null;
      if (shapeResize) {
        this.logger.shapeTool("commit", {
          page: surface.page.pageNumber,
          shape: shapeResize.recognition.kind,
          pointCount: stroke.points.length
        });
      }
      if (laserDraft) {
        const laser = this.options.settings.toolPreferences.laser;
        this.laserTrails.push({
          id: stroke.id,
          page: stroke.page,
          points: stroke.points,
          color: laser.color,
          width: laser.width,
          opacity: laser.opacity,
          holdMs: laser.holdMs,
          fadeMs: laser.fadeMs
        });
        this.logger.laserDraft(
          surface.page.pageNumber,
          stroke.points.length,
          surface.laserDiscardedPoints,
          laser.holdMs + laser.fadeMs
        );
        this.lastPointerPdf = stroke.points.at(-1)
          ? { x: stroke.points.at(-1)!.x, y: stroke.points.at(-1)!.y }
          : this.lastPointerPdf;
        this.logDraw(surface, "end", "laser", stroke.points);
        this.ensureLaserFadeLoop();
      } else {
        const tool = resolveDrawingTool(this.activeTool());
        this.executeHistory(new AddStrokeCommand(this.ink, stroke), stroke.page);
        this.lastPointerPdf = stroke.points.at(-1)
          ? { x: stroke.points.at(-1)!.x, y: stroke.points.at(-1)!.y }
          : this.lastPointerPdf;
        this.logDraw(surface, "end", tool, stroke.points);
      }
      const last = samples.at(-1);
      if (last) this.logPositionAlign(surface, last, "end");
    } else if (route === "edit") {
      surface.editPath.push(...this.toPdfPoints(surface, samples, true));
      const tool = this.options.settings.toolPreferences.activeTool;
      const phase = tool === "eraser" ? "eraser" : "lasso";
      const path = [...surface.editPath];
      this.finishEdit(surface);
      this.logDraw(surface, phase, tool, path);
      surface.editPath = [];
      surface.liveEraserPaintedPoints = 0;
    }
    this.updateDebug(surface, event);
    if (this.needsPagePaint(surface.page.pageNumber)) this.renderPage(surface.page.pageNumber);
  }

  private pointerCancel(surface: PageSurface, route: "draw" | "edit" | "text", event: PointerEvent): void {
    this.cancelLivePaint(surface);
    if (route === "text") {
      this.logText(surface, "pointer-cancel", {
        annotationId: this.textMoveDrag?.before.id ?? surface.textIntent?.hit?.id ?? null,
        hadIntent: Boolean(surface.textIntent),
        hadMove: Boolean(this.textMoveDrag)
      });
    }
    this.moveDrag = null;
    this.movePreview = null;
    this.moveTextPreview = null;
    this.moveShapePreview = null;
    surface.builder = undefined;
    this.cancelHeldShape(surface);
    if (surface.shapeResize) {
      this.logger.shapeTool("cancel", { page: surface.page.pageNumber, shape: surface.shapeResize.recognition.kind });
    }
    surface.shapePreview = null;
    surface.shapeResize = null;
    surface.laserDraft = false;
    surface.laserDiscardedPoints = 0;
    surface.editPath = [];
    surface.liveEraserPaintedPoints = 0;
    surface.editTool = undefined;
    surface.eraserSize = undefined;
    surface.eraserWholeStrokes = undefined;
    surface.textIntent = null;
    this.textMoveDrag = null;
    this.updateDebug(surface, event);
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
        this.executeHistory(
          new ReplacePageStrokesCommand(this.ink, surface.page.pageNumber, this.ink.page(surface.page.pageNumber), result.kept),
          surface.page.pageNumber
        );
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
    this.selectedTexts = this.texts.page(surface.page.pageNumber).filter((text) =>
      shapeContainsPoint(shape, { x: text.x + text.width / 2, y: text.y - text.height / 2 })
    );
    if (!this.selected.length && !this.selectedTexts.length) {
      this.logText(surface, "lasso-selection-empty", {
        shape: shape.type,
        pathPoints: editPath.length,
        strokeMatchCount: matched.length
      });
      this.clearSelection();
      return;
    }
    this.selectionShape = shape;
    this.selectionPage = surface.page.pageNumber;
    this.invalidateInkLayer(surface);
    this.logger.lassoSelection(surface.page.pageNumber, this.selected.length + this.selectedTexts.length, editPath.length, shape.type);
    this.logText(surface, "lasso-selection", {
      shape: shape.type,
      pathPoints: editPath.length,
      textSelectedCount: this.selectedTexts.length,
      strokeSelectedCount: this.selected.length
    });
    this.ensureSelectionToolbar({ resetPlacement: true });
  }

  private isRightMouseEraser(event: PointerEvent): boolean {
    return event.pointerType === "mouse" && event.button === 2
      && this.options.settings.toolPreferences.eraser.eraseWithRightMouseButton;
  }

  private scheduleHeldShape(surface: PageSurface): void {
    this.cancelHeldShape(surface);
    if (!this.options.settings.toolPreferences.shape.holdToRecognize || !surface.builder || surface.shapeResize) return;
    surface.shapeHoldTimer = window.setTimeout(() => {
      surface.shapeHoldTimer = null;
      if (!this.options.settings.toolPreferences.shape.holdToRecognize || !surface.builder || !isDrawingTool(this.activeTool()) || surface.shapeResize) return;
      const input = surface.builder.preview(this.simplifyStrokesEnabled());
      const recognized = recognizeHeldShape(input);
      if (!recognized) return;
      const pointer = input.at(-1);
      if (!pointer) return;
      const handle = shapeResizeHandle(recognized.points, pointer);
      surface.shapePreview = recognized.points;
      surface.shapeResize = {
        recognition: recognized,
        anchor: structuredClone(shapeResizeAnchor(recognized.points, handle)),
        handle: structuredClone(handle)
      };
      this.logger.refresh("shape-recognized", { page: surface.page.pageNumber, shape: recognized.kind });
      this.logger.shapeTool("recognized", {
        page: surface.page.pageNumber,
        shape: recognized.kind,
        holdMs: SHAPE_RECOGNITION_HOLD_MS,
        pointCount: recognized.points.length,
        anchorX: round(surface.shapeResize.anchor.x),
        anchorY: round(surface.shapeResize.anchor.y),
        handleX: round(handle.x),
        handleY: round(handle.y)
      });
      this.renderPage(surface.page.pageNumber);
    }, SHAPE_RECOGNITION_HOLD_MS);
  }

  private resizeLockedShape(surface: PageSurface, target: PdfPoint): void {
    const resize = surface.shapeResize;
    if (!resize) return;
    surface.shapePreview = resizeShapePoints(resize.recognition.points, resize.anchor, resize.handle, target);
    this.logger.shapeTool("resize", {
      page: surface.page.pageNumber,
      shape: resize.recognition.kind,
      targetX: round(target.x),
      targetY: round(target.y),
      pointCount: surface.shapePreview.length
    });
  }

  private cancelHeldShape(surface: PageSurface): void {
    if (surface.shapeHoldTimer !== null) {
      window.clearTimeout(surface.shapeHoldTimer);
      surface.shapeHoldTimer = null;
    }
  }

  private beginTextIntent(surface: PageSurface, sample: PointerSample, event: PointerEvent): void {
    const point = this.toPdfPoint(surface, sample, true);
    const activeEditor = this.activeTextEditor;
    if (activeEditor) {
      this.logText(activeEditor.surface, "outside-click-close", {
        annotationId: activeEditor.draft.id,
        existing: Boolean(activeEditor.existing),
        targetPage: surface.page.pageNumber,
        targetX: round(point.x),
        targetY: round(point.y)
      });
      this.commitActiveTextEditor("outside-click");
      surface.textIntent = null;
      return;
    }
    const hit = this.textAt(surface.page.pageNumber, point);
    surface.textIntent = { start: point, hit, pointerType: event.pointerType };
    this.logText(surface, "intent", {
      pointerType: event.pointerType || "(empty)", pointerId: event.pointerId,
      x: round(point.x), y: round(point.y), committedPrevious: false
    });
    this.logText(surface, "hit-test", {
      hit: Boolean(hit), annotationId: hit?.id ?? null,
      x: round(point.x), y: round(point.y),
      ...(hit ? this.textGeometry(hit) : {})
    });
  }

  private updateTextIntent(surface: PageSurface, sample: PointerSample, event: PointerEvent): void {
    const point = this.toPdfPoint(surface, sample, true);
    if (this.textMoveDrag?.page === surface.page.pageNumber) {
      const dx = point.x - this.textMoveDrag.start.x;
      const dy = point.y - this.textMoveDrag.start.y;
      this.textMoveDrag.preview = {
        ...this.textMoveDrag.before,
        x: this.textMoveDrag.before.x + dx,
        y: this.textMoveDrag.before.y + dy,
        updatedAt: new Date().toISOString()
      };
      this.logText(surface, "move", {
        annotationId: this.textMoveDrag.preview.id,
        dx: round(dx), dy: round(dy),
        x: round(this.textMoveDrag.preview.x), y: round(this.textMoveDrag.preview.y)
      });
      this.renderTextAnnotations(surface);
      return;
    }
    const intent = surface.textIntent;
    if (!intent?.hit || intent.pointerType !== "pen") return;
    const threshold = Math.max(3 / Math.max(this.displayScale(surface), 0.1), 2);
    if (Math.hypot(point.x - intent.start.x, point.y - intent.start.y) < threshold) return;
    this.textMoveDrag = {
      page: surface.page.pageNumber,
      start: intent.start,
      before: structuredClone(intent.hit),
      preview: structuredClone(intent.hit)
    };
    this.logText(surface, "move-start", {
      annotationId: intent.hit.id, threshold: round(threshold),
      startX: round(intent.start.x), startY: round(intent.start.y),
      currentX: round(point.x), currentY: round(point.y)
    });
    surface.textIntent = null;
    this.updateTextIntent(surface, sample, event);
  }

  private finishTextIntent(surface: PageSurface, sample: PointerSample, _event: PointerEvent): void {
    if (this.textMoveDrag?.page === surface.page.pageNumber) {
      const drag = this.textMoveDrag;
      this.textMoveDrag = null;
      if (drag.before.x !== drag.preview.x || drag.before.y !== drag.preview.y) {
        this.executeHistory(new ReplaceTextAnnotationCommand(this.texts, drag.before, drag.preview), surface.page.pageNumber);
        this.selectedTexts = [drag.preview];
        this.selected = [];
        this.selectionShape = boundingShapeFromSelection([], this.selectedTexts);
        this.selectionPage = surface.page.pageNumber;
        this.logText(surface, "move-commit", {
          annotationId: drag.preview.id,
          fromX: round(drag.before.x), fromY: round(drag.before.y),
          toX: round(drag.preview.x), toY: round(drag.preview.y)
        });
      } else {
        this.logText(surface, "move-cancel", { annotationId: drag.before.id, reason: "no-position-change" });
      }
      this.renderTextAnnotations(surface);
      return;
    }
    const intent = surface.textIntent;
    surface.textIntent = null;
    if (!intent) return;
    if (intent.hit) {
      this.logText(surface, "edit-request", { annotationId: intent.hit.id, ...this.textGeometry(intent.hit) });
      this.openTextEditor(surface, intent.hit);
    } else {
      this.logText(surface, "create-request", { x: round(intent.start.x), y: round(intent.start.y) });
      this.openTextEditor(surface, null, intent.start);
    }
    this.renderTextAnnotations(surface);
  }

  private textAt(page: number, point: Pick<PdfPoint, "x" | "y">): PdfTextAnnotation | null {
    return [...this.texts.page(page)].reverse().find((text) =>
      point.x >= text.x && point.x <= text.x + text.width
      && point.y <= text.y && point.y >= text.y - text.height
    ) ?? null;
  }

  private logText(surface: PageSurface, phase: string, details: Record<string, unknown> = {}): void {
    this.logger.textTool(phase, {
      page: surface.page.pageNumber,
      displayScale: Number(this.displayScale(surface).toFixed(4)),
      ...details
    });
  }

  private textGeometry(text: Pick<PdfTextAnnotation, "x" | "y" | "width" | "height" | "fontSize" | "fontFamily" | "bold" | "italic" | "strikethrough">): Record<string, unknown> {
    return {
      x: round(text.x), y: round(text.y), width: round(text.width), height: round(text.height),
      fontSize: text.fontSize, fontFamily: text.fontFamily,
      bold: text.bold, italic: text.italic, strikethrough: text.strikethrough
    };
  }

  private editorSelectionMetrics(element: HTMLElement): {
    selectedCharacters: number;
    collapsed: boolean;
    anchorOffset: number | null;
    focusOffset: number | null;
  } {
    const selection = element.ownerDocument.getSelection();
    if (!selection?.rangeCount || !element.contains(selection.anchorNode)) {
      return { selectedCharacters: 0, collapsed: true, anchorOffset: null, focusOffset: null };
    }
    return {
      selectedCharacters: selection.toString().length,
      collapsed: selection.isCollapsed,
      anchorOffset: selection.anchorOffset,
      focusOffset: selection.focusOffset
    };
  }

  private openTextEditor(surface: PageSurface, existing: PdfTextAnnotation | null, at?: Pick<PdfPoint, "x" | "y">): void {
    this.commitActiveTextEditor();
    const clearedSelection = this.selected.length > 0 || this.selectedTexts.length > 0;
    // Editing has its own dotted DOM boundary. Suspend the canvas selection
    // first so a text box can never render two competing outlines.
    // Page-local paint (not refresh:false) — otherwise canvas outline/z-index linger.
    this.clearSelection();
    const preferences = this.options.settings.toolPreferences.text;
    const style: TextStyle = existing
      ? this.textStyle(existing)
      : { ...preferences };
    const metrics = this.metricsFor(surface);
    const annotation = existing ?? {
      id: this.id(),
      page: surface.page.pageNumber,
      text: "",
      x: at?.x ?? metrics.width * 0.1,
      y: at?.y ?? metrics.height * 0.9,
      width: Math.min(260, Math.max(150, metrics.width * 0.4)),
      height: style.fontSize * 1.6,
      ...style,
      runs: [],
      sourceRuns: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const storedRuns = normalizeTextRuns(annotation.runs);
    const runs = storedRuns.length && plainTextFromRuns(storedRuns) === annotation.text
      ? storedRuns
      : plainTextToRuns(annotation.text, style);
    const insertionStyle = { ...(styleAtTextOffset(runs, runs.reduce((length, run) => length + run.text.length, 0)) ?? style) };
    const element = createDetachedDiv(surface.overlay.ownerDocument);
    const abort = new AbortController();
    element.className = "native-pdf-handwriting-text-input";
    element.contentEditable = "true";
    // contenteditable is programmatically focusable, but an explicit tab stop
    // gives Obsidian's embedded PDF host a stable, native focus target.
    element.tabIndex = 0;
    element.spellcheck = true;
    element.setAttribute("role", "textbox");
    element.setAttribute("aria-multiline", "true");
    element.setAttribute("aria-label", "Text annotation");
    const listenerOptions = { signal: abort.signal };
    element.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      this.logText(surface, "editor-pointer", {
        annotationId: annotation.id, pointerType: event.pointerType || "(empty)", pointerId: event.pointerId,
        ...this.editorSelectionMetrics(element)
      });
    }, listenerOptions);
    element.addEventListener("keydown", (event) => {
      // Direct editors in pop-outs/embeds may not be the workspace's active
      // session. Claim Select All here as a fallback to the window shortcut
      // router so the next native keystroke replaces this editor's full text.
      if (this.handleActiveTextEditorSelectAll(event)) return;
      if (event.isComposing || (this.activeTextEditor?.element === element && this.activeTextEditor.composing)) {
        this.logText(surface, "keydown-composition", { annotationId: annotation.id, key: event.key });
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.logText(surface, "escape", { annotationId: annotation.id, ...this.editorSelectionMetrics(element) });
      this.commitActiveTextEditor("escape");
    }, listenerOptions);
    element.addEventListener("beforeinput", (event) => {
      this.logText(surface, "beforeinput", {
        annotationId: annotation.id,
        inputType: event.inputType || "(empty)",
        dataLength: event.data?.length ?? 0,
        isComposing: event.isComposing,
        ...this.editorSelectionMetrics(element)
      });
      const editor = this.activeTextEditor;
      if (editor?.element !== element || editor.composing || event.isComposing || !editor.pendingInsertionStyle) return;
      if ((event.inputType === "insertText" && event.data) || event.inputType === "insertParagraph") {
        event.preventDefault();
        this.insertTextWithActiveStyle(editor, event.inputType === "insertParagraph" ? "\n" : event.data!);
      }
    }, listenerOptions);
    element.addEventListener("input", () => {
      const editor = this.activeTextEditor;
      if (editor?.element === element && !editor.composing) this.syncActiveTextRuns(editor);
      const value = editor?.element === element ? plainTextFromRuns(editor.runs) : "";
      this.logText(surface, "input", {
        annotationId: annotation.id,
        characterCount: value.length,
        lineCount: value ? value.split("\n").length : 0,
        runCount: editor?.runs.length ?? 0
      });
    }, listenerOptions);
    element.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      this.logText(surface, "paste", {
        annotationId: annotation.id,
        characterCount: text.length,
        lineCount: text ? text.replace(/\r\n?/g, "\n").split("\n").length : 0,
        ...this.editorSelectionMetrics(element)
      });
      const editor = this.activeTextEditor;
      if (editor?.element !== element) return;
      this.insertTextWithActiveStyle(editor, text.replace(/\r\n?/g, "\n"));
    }, listenerOptions);
    for (const type of ["copy", "cut"] as const) {
      element.addEventListener(type, () => this.logText(surface, type, {
        annotationId: annotation.id,
        ...this.editorSelectionMetrics(element)
      }), listenerOptions);
    }
    for (const type of ["compositionstart", "compositionupdate", "compositionend"] as const) {
      element.addEventListener(type, (event) => {
        if (this.activeTextEditor?.element === element) {
          if (type === "compositionstart") this.activeTextEditor.composing = true;
          if (type === "compositionend") {
            this.activeTextEditor.composing = false;
            const deferred = this.activeTextEditor.deferredStyleChange;
            void Promise.resolve().then(() => {
              const active = this.activeTextEditor;
              if (active?.element !== element || active.composing) return;
              this.syncActiveTextRuns(active);
              if (!deferred) return;
              active.deferredStyleChange = null;
              this.applyTextStyleToActiveEditor(deferred);
            }).catch((error) => {
              this.logger.textTool("composition-style-error", {
                annotationId: annotation.id,
                error: this.errorMessage(error)
              });
            });
          }
        }
        this.logText(surface, type, {
          annotationId: annotation.id,
          dataLength: event.data?.length ?? 0,
          ...this.editorSelectionMetrics(element)
        });
      }, listenerOptions);
    }
    element.addEventListener("focus", () => this.logText(surface, "focus", { annotationId: annotation.id }), listenerOptions);
    element.addEventListener("blur", () => this.logText(surface, "blur", { annotationId: annotation.id }), listenerOptions);
    element.addEventListener("keyup", () => this.logText(surface, "selection", {
      annotationId: annotation.id,
      ...this.editorSelectionMetrics(element)
    }), listenerOptions);
    this.activeTextEditor = {
      surface, existing, draft: annotation, style: { ...style }, runs, selection: null,
      insertionStyle, pendingInsertionStyle: false, deferredStyleChange: null,
      element, resizeObserver: null, abort, composing: false
    };
    element.ownerDocument.addEventListener("selectionchange", () => {
      if (this.activeTextEditor?.element !== element) return;
      // captureActiveTextSelection logs selection-snapshot — do not also emit selectionchange.
      this.captureActiveTextSelection("selectionchange");
    }, { signal: abort.signal });
    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(() => {
        const rect = element.getBoundingClientRect();
        this.logText(surface, "resize", {
          annotationId: annotation.id,
          widthPx: round(rect.width), heightPx: round(rect.height),
          width: round(rect.width / Math.max(this.displayScale(surface), 0.1)),
          height: round(rect.height / Math.max(this.displayScale(surface), 0.1))
        });
      });
      resizeObserver.observe(element);
      this.activeTextEditor.resizeObserver = resizeObserver;
    }
    this.applyTextElementStyle(surface, element, annotation, style);
    renderTextRuns(element, runs, this.displayScale(surface));
    // Keep the live, focusable editor out of the non-interactive static-text
    // layer. Obsidian/PDF viewers may restyle or replace their text layers;
    // the overlay is the stable annotation owner and mirrors the working PR.
    surface.overlay.append(element);
    // Leave other committed annotations visible, but do not paint the edited
    // annotation underneath its live contenteditable copy.
    if (existing) {
      for (const box of surface.textLayer.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-box")) {
        if (box.dataset.annotationId === existing.id) box.remove();
      }
    }
    this.logText(surface, existing ? "editor-open-existing" : "editor-open-new", {
      annotationId: annotation.id,
      characterCount: plainTextFromRuns(runs).length,
      runCount: runs.length,
      mount: "overlay",
      clearedSelection,
      ...this.textGeometry(annotation)
    });
    const focusNativeCaret = (phase: "initial" | "fallback"): void => {
      if (this.activeTextEditor?.element !== element) return;
      element.focus({ preventScroll: true });
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = element.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      this.captureActiveTextSelection("focus-ready");
      this.logText(surface, "focus-ready", {
        annotationId: annotation.id,
        phase,
        activeElementIsEditor: element.ownerDocument.activeElement === element,
        isConnected: element.isConnected,
        ...this.editorSelectionMetrics(element)
      });
      const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
      this.logText(surface, "editor-visual-style", {
        annotationId: annotation.id,
        backgroundColor: computed?.backgroundColor ?? null,
        borderColor: computed?.borderColor ?? null,
        borderStyle: computed?.borderStyle ?? null,
        borderWidth: computed?.borderWidth ?? null,
        boxShadow: computed?.boxShadow ?? null,
        caretColor: computed?.caretColor ?? null,
        color: computed?.color ?? null,
        cursor: computed?.cursor ?? null
      });
    };
    focusNativeCaret("initial");
    window.requestAnimationFrame(() => {
      // Do not steal focus from another control. This only covers an embedded
      // viewer that has returned focus to the document body during mounting.
      if (element.ownerDocument.activeElement !== element && element.ownerDocument.activeElement === element.ownerDocument.body) {
        focusNativeCaret("fallback");
      }
    });
  }

  private commitActiveTextEditor(reason = "switch"): void {
    const editor = this.activeTextEditor;
    if (!editor) return;
    if (editor.composing) {
      this.logText(editor.surface, "commit-deferred-composition", { annotationId: editor.draft.id, reason });
      return;
    }
    this.activeTextEditor = null;
    // DOM is the live editing surface; runs are canonical persistence. Read it
    // once at commit so contenteditable keeps its native caret/IME behavior.
    editor.runs = readTextRuns(editor.element, editor.insertionStyle);
    const runs = normalizeTextRuns(editor.runs);
    const text = plainTextFromRuns(runs);
    const rect = editor.element.getBoundingClientRect();
    editor.resizeObserver?.disconnect();
    editor.abort.abort();
    editor.element.remove();
    if (!text.trim()) {
      if (editor.existing) {
        this.executeHistory(new DeleteTextAnnotationsCommand(this.texts, [editor.existing]), editor.surface.page.pageNumber);
        this.logText(editor.surface, "delete-empty", { annotationId: editor.existing.id, reason });
      } else this.logText(editor.surface, "discard-empty", { annotationId: editor.draft.id, reason });
      if (this.needsPagePaint(editor.surface.page.pageNumber)) this.renderTextAnnotations(editor.surface);
      return;
    }
    const scale = Math.max(this.displayScale(editor.surface), 0.1);
    const before = editor.existing;
    const now = new Date().toISOString();
    const base = before ?? editor.draft;
    const displayStyle = styleAtTextOffset(runs, 0) ?? editor.insertionStyle;
    const largestFontSize = Math.max(displayStyle.fontSize, ...runs.map((run) => run.fontSize));
    const annotation: PdfTextAnnotation = {
      ...base,
      ...displayStyle,
      text,
      width: Math.max(24, rect.width / scale || base.width),
      height: Math.max(largestFontSize * 1.4, rect.height / scale || base.height),
      runs,
      sourceRuns: runs.map((run) => ({ ...run })),
      updatedAt: now
    };
    if (before) this.executeHistory(new ReplaceTextAnnotationCommand(this.texts, before, annotation), annotation.page);
    else this.executeHistory(new AddTextAnnotationCommand(this.texts, annotation), annotation.page);
    this.logText(editor.surface, before ? "commit-update" : "commit-create", {
      annotationId: annotation.id, reason,
      characterCount: text.length, lineCount: text.split("\n").length, runCount: runs.length,
      widthPx: round(rect.width), heightPx: round(rect.height),
      ...this.textGeometry(annotation)
    });
    if (this.needsPagePaint(annotation.page)) this.renderTextAnnotations(editor.surface);
  }

  private textStyle(text: PdfTextAnnotation): TextStyle {
    return {
      color: text.color, fontSize: text.fontSize, fontFamily: text.fontFamily,
      bold: text.bold, italic: text.italic, strikethrough: text.strikethrough
    };
  }

  private applyTextStyleToActiveEditor(change: TextStyleChange): void {
    const editor = this.activeTextEditor;
    this.logger.textTool("style-preference", {
      property: change.property,
      value: change.value,
      source: change.source,
      editorActive: Boolean(editor),
      defaultColor: this.options.settings.toolPreferences.text.color,
      defaultFontSize: this.options.settings.toolPreferences.text.fontSize,
      defaultFontFamily: this.options.settings.toolPreferences.text.fontFamily
    });
    if (!editor) {
      this.applyTextStyleToSelection(change);
      return;
    }
    if (editor.composing) {
      editor.deferredStyleChange = change;
      this.logText(editor.surface, "style-deferred-composition", {
        annotationId: editor.draft.id, property: change.property
      });
      return;
    }
    this.syncActiveTextRuns(editor);
    const offsets = editor.selection ?? selectionOffsets(editor.element) ?? {
      start: plainTextFromRuns(editor.runs).length,
      end: plainTextFromRuns(editor.runs).length
    };
    if (offsets.start === offsets.end) {
      const current = styleAtTextOffset(editor.runs, offsets.start) ?? editor.insertionStyle;
      editor.insertionStyle = this.patchTextStyle(current, change);
      editor.style = { ...editor.insertionStyle };
      editor.pendingInsertionStyle = true;
      this.applyTextElementStyle(editor.surface, editor.element, editor.existing ?? editor.draft, editor.insertionStyle);
      this.logText(editor.surface, "style-insertion", {
        annotationId: editor.draft.id, property: change.property,
        offset: offsets.start,
        color: editor.insertionStyle.color, fontSize: editor.insertionStyle.fontSize,
        fontFamily: editor.insertionStyle.fontFamily, bold: editor.insertionStyle.bold,
        italic: editor.insertionStyle.italic, strikethrough: editor.insertionStyle.strikethrough
      });
      return;
    }
    editor.runs = patchTextRunRange(editor.runs, offsets.start, offsets.end, this.textStylePatch(change));
    renderTextRuns(editor.element, editor.runs, this.displayScale(editor.surface));
    restoreSelection(editor.element, offsets);
    editor.selection = offsets;
    editor.style = { ...(styleAtTextOffset(editor.runs, offsets.start) ?? editor.insertionStyle) };
    this.applyTextElementStyle(editor.surface, editor.element, editor.existing ?? editor.draft, editor.style);
    this.logText(editor.surface, "style-apply", {
      annotationId: editor.draft.id,
      property: change.property,
      source: change.source,
      selectionStart: offsets.start, selectionEnd: offsets.end, runCount: editor.runs.length,
      color: editor.style.color, fontSize: editor.style.fontSize, fontFamily: editor.style.fontFamily,
      bold: editor.style.bold, italic: editor.style.italic, strikethrough: editor.style.strikethrough
    });
  }

  /** Serialize live DOM without replacing it; replacement would lose the caret. */
  private syncActiveTextRuns(editor: ActiveTextEditor): void {
    if (!editor.composing) editor.runs = readTextRuns(editor.element, editor.insertionStyle);
    const offsets = selectionOffsets(editor.element);
    if (offsets) editor.selection = offsets;
  }

  /** Capture selection before toolbar controls move focus away from contenteditable. */
  private captureActiveTextSelection(phase: string): void {
    const editor = this.activeTextEditor;
    if (!editor) return;
    const offsets = selectionOffsets(editor.element);
    if (!offsets) return;
    editor.selection = offsets;
    if (!editor.composing) editor.runs = readTextRuns(editor.element, editor.insertionStyle);
    this.logText(editor.surface, "selection-snapshot", {
      annotationId: editor.draft.id, phase,
      start: offsets.start, end: offsets.end, collapsed: offsets.start === offsets.end
    });
  }

  private activeTextStyle(): TextStyle | undefined {
    const editor = this.activeTextEditor;
    if (!editor) return undefined;
    const offsets = editor.selection ?? selectionOffsets(editor.element);
    const style = offsets
      ? styleAtTextOffset(editor.runs, offsets.start)
      : editor.insertionStyle;
    return { ...(style ?? editor.insertionStyle) };
  }

  private insertTextWithActiveStyle(editor: ActiveTextEditor, text: string): void {
    if (!text) return;
    const style = editor.pendingInsertionStyle
      ? editor.insertionStyle
      : styleAtTextOffset(editor.runs, editor.selection?.start ?? 0) ?? editor.insertionStyle;
    if (!selectionOffsets(editor.element)) {
      const range = editor.element.ownerDocument.createRange();
      range.selectNodeContents(editor.element);
      range.collapse(false);
      const selection = editor.element.ownerDocument.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    const inserted = insertStyledText(editor.element, text, style, this.displayScale(editor.surface));
    if (!inserted) return;
    editor.pendingInsertionStyle = false;
    this.syncActiveTextRuns(editor);
    editor.selection = { start: inserted.end, end: inserted.end };
  }

  private patchTextStyle(style: TextStyle, change: TextStyleChange): TextStyle {
    return { ...style, ...this.textStylePatch(change) };
  }

  private textStylePatch(change: TextStyleChange): Partial<TextStyle> {
    switch (change.property) {
      case "fontFamily": return { fontFamily: change.value as string };
      case "color": return { color: change.value as string };
      case "fontSize": return { fontSize: change.value as number };
      case "bold": return { bold: change.value as boolean };
      case "italic": return { italic: change.value as boolean };
      case "strikethrough": return { strikethrough: change.value as boolean };
    }
  }

  private applyTextStyleToSelection(change: TextStyleChange): void {
    this.reconcileSelection();
    if (!this.selectedTexts.length) return;
    const before = [...this.selectedTexts];
    const now = new Date().toISOString();
    const after = before.map((text) => ({
      ...text,
      ...this.patchTextStyle(this.textStyle(text), change),
      runs: text.runs.map((run) => ({ ...run, ...this.patchTextStyle(run, change) })),
      sourceRuns: text.sourceRuns.map((run) => ({ ...run, ...this.patchTextStyle(run, change) })),
      updatedAt: now
    }));
    this.executeHistory({
      label: "Style text annotations",
      execute: () => after.forEach((text) => this.texts.replace(text)),
      undo: () => before.forEach((text) => this.texts.replace(text))
    }, this.selectionPage);
    this.selectedTexts = after;
    this.logger.textTool("selection-style", {
      page: this.selectionPage,
      property: change.property,
      textCount: after.length
    });
    this.refresh("text-style-selection");
  }

  private applyTextElementStyle(
    surface: PageSurface,
    element: HTMLElement,
    annotation: Pick<PdfTextAnnotation, "x" | "y" | "width" | "height">,
    style: TextStyle
  ): void {
    const origin = this.mapper(surface).toViewport({ x: annotation.x, y: annotation.y });
    const scale = this.displayScale(surface);
    Object.assign(element.style, {
      left: `${origin.x}px`, top: `${origin.y}px`, width: `${Math.max(24, annotation.width * scale)}px`,
      minHeight: `${Math.max(style.fontSize * scale * 1.4, annotation.height * scale)}px`,
      color: style.color, fontFamily: style.fontFamily, fontSize: `${style.fontSize * scale}px`,
      fontWeight: style.bold ? "700" : "400", fontStyle: style.italic ? "italic" : "normal",
      textDecoration: style.strikethrough ? "line-through" : "none"
    });
  }

  private renderTextAnnotations(surface: PageSurface): void {
    // Replacing a focused contenteditable loses selection. It remains positioned
    // until it is committed; all normal renders resume once editing finishes.
    if (this.activeTextEditor?.surface === surface) {
      this.logText(surface, "render-skipped-active-editor", { annotationId: this.activeTextEditor.draft.id });
      return;
    }
    // Repainting the page while a control is held used to replaceChildren() on
    // the frame being moved. Keep that exact DOM node alive until release so
    // its outline remains visibly attached to the pointer.
    if (this.textBoxTransformDrag?.surface === surface) return;
    const preview = this.textMoveDrag?.page === surface.page.pageNumber ? this.textMoveDrag.preview : null;
    const selectionPreviews = this.moveDrag?.page === surface.page.pageNumber
      ? new Map((this.moveTextPreview ?? []).map((text) => [text.id, text]))
      : null;
    const annotations = this.texts.page(surface.page.pageNumber).map((text) =>
      preview?.id === text.id ? preview : selectionPreviews?.get(text.id) ?? text
    );
    if (
      !annotations.length
      && !preview
      && !selectionPreviews?.size
      && !surface.textLayer.childElementCount
    ) return;
    const selected = new Set(this.selectedTexts.map((text) => text.id));
    if (this.syncCurrentTextBoxes(surface, annotations, selected)) return;
    const boxes = annotations.map((annotation) => {
      const box = createDetachedDiv(surface.overlay.ownerDocument);
      box.className = "native-pdf-handwriting-text-box";
      box.dataset.annotationId = annotation.id;
      box.dataset.annotationSignature = this.textBoxRenderSignature(annotation, selected.has(annotation.id));
      if (this.textBoxesInteractable()) box.classList.add("is-editable");
      if (selected.has(annotation.id)) box.classList.add("is-selected");
      this.positionTextBox(surface, box, annotation);
      const runs = normalizeTextRuns(annotation.runs);
      renderTextRuns(
        box,
        runs.length && plainTextFromRuns(runs) === annotation.text ? runs : plainTextToRuns(annotation.text, this.textStyle(annotation)),
        this.displayScale(surface)
      );
      this.attachTextBoxOutline(surface, box, annotation);
      return box;
    });
    surface.textLayer.replaceChildren(...boxes);
    this.logText(surface, "render", {
      annotationCount: annotations.length,
      selectedCount: selected.size,
      previewAnnotationId: preview?.id ?? null
    });
  }

  /** Reuse unchanged text DOM so zoom settles do not remove/reinsert visible words. */
  private syncCurrentTextBoxes(
    surface: PageSurface,
    annotations: readonly PdfTextAnnotation[],
    selected: ReadonlySet<string>
  ): boolean {
    const boxes = [...surface.textLayer.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-box")];
    if (boxes.length !== annotations.length) return false;
    const byId = new Map(boxes.map((box) => [box.dataset.annotationId, box]));
    if (!annotations.every((annotation) => {
      const box = byId.get(annotation.id);
      return box?.dataset.annotationSignature === this.textBoxRenderSignature(annotation, selected.has(annotation.id));
    })) return false;
    for (const annotation of annotations) {
      const box = byId.get(annotation.id);
      if (!box) return false;
      this.positionTextBox(surface, box, annotation);
      rescaleTextRuns(box, this.displayScale(surface));
      const outline = box.querySelector<HTMLElement>(".native-pdf-handwriting-text-selection-frame");
      if (outline) this.layoutTextBoxOutline(surface, outline, annotation, annotation);
    }
    return true;
  }

  /** Geometry/state identity only — never store document text in a DOM data attribute. */
  private textBoxRenderSignature(annotation: PdfTextAnnotation, selected: boolean): string {
    return [
      annotation.updatedAt, annotation.x, annotation.y, annotation.width, annotation.height,
      annotation.color, annotation.fontSize, annotation.fontFamily, annotation.bold, annotation.italic,
      annotation.strikethrough, annotation.text.length, annotation.runs.length, selected,
      this.textBoxesInteractable()
    ].join("|");
  }

  private positionTextBox(surface: PageSurface, box: HTMLElement, annotation: PdfTextAnnotation): void {
    const origin = this.mapper(surface).toViewport({ x: annotation.x, y: annotation.y });
    const scale = this.displayScale(surface);
    Object.assign(box.style, {
      left: `${origin.x}px`, top: `${origin.y}px`, width: `${Math.max(24, annotation.width * scale)}px`,
      minHeight: `${Math.max(annotation.fontSize * scale * 1.4, annotation.height * scale)}px`,
      color: annotation.color, fontFamily: annotation.fontFamily, fontSize: `${annotation.fontSize * scale}px`,
      fontWeight: annotation.bold ? "700" : "400", fontStyle: annotation.italic ? "italic" : "normal",
      textDecoration: annotation.strikethrough ? "line-through" : "none"
    });
  }

  /**
   * Canvas ink is deliberately composited during a zoom burst, but text is DOM
   * content. Reproject it immediately so it stays anchored to its PDF-space
   * coordinates instead of retaining the previous scale until settle.
   */
  private syncTextLayoutDuringZoom(surface: PageSurface): void {
    const storedAnnotations = this.texts.page(surface.page.pageNumber);
    const activeEditor = this.activeTextEditor?.surface === surface ? this.activeTextEditor : null;
    if (!storedAnnotations.length && !activeEditor) return;

    const movingPreview = this.textMoveDrag?.page === surface.page.pageNumber ? this.textMoveDrag.preview : null;
    const selectionPreviews = this.moveDrag?.page === surface.page.pageNumber
      ? new Map((this.moveTextPreview ?? []).map((annotation) => [annotation.id, annotation]))
      : null;
    const annotations = storedAnnotations.map((annotation) =>
      movingPreview?.id === annotation.id ? movingPreview : selectionPreviews?.get(annotation.id) ?? annotation
    );

    const annotationsById = new Map(annotations.map((annotation) => [annotation.id, annotation]));
    const scale = this.displayScale(surface);
    const transforming = this.textBoxTransformDrag?.surface === surface;
    if (!transforming) {
      for (const box of surface.textLayer.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-box")) {
        const annotation = box.dataset.annotationId ? annotationsById.get(box.dataset.annotationId) : undefined;
        if (!annotation) continue;
        this.positionTextBox(surface, box, annotation);
        rescaleTextRuns(box, scale);
        const outline = box.querySelector<HTMLElement>(".native-pdf-handwriting-text-selection-frame");
        if (outline) this.layoutTextBoxOutline(surface, outline, annotation, annotation);
      }
    }
    if (activeEditor) {
      const annotation = activeEditor.existing ?? activeEditor.draft;
      this.applyTextElementStyle(surface, activeEditor.element, annotation, activeEditor.style);
      // Do not replace the contenteditable children: that would lose its caret.
      rescaleTextRuns(activeEditor.element, scale);
    }

    if (this.zoomTextLayoutLoggedPages.has(surface.page.pageNumber)) return;
    this.zoomTextLayoutLoggedPages.add(surface.page.pageNumber);
    const layout = this.pageLayout(surface);
    const first = annotations[0];
    const origin = first ? this.mapper(surface).toViewport({ x: first.x, y: first.y }) : null;
    this.logger.textTool("zoom-layout", {
      page: surface.page.pageNumber,
      annotationCount: annotations.length,
      activeEditor: Boolean(activeEditor),
      transforming,
      scale: round(scale),
      offsetX: round(layout.offsetX),
      offsetY: round(layout.offsetY),
      contentWidth: round(layout.contentWidth),
      contentHeight: round(layout.contentHeight),
      ...(first && origin ? {
        annotationId: first.id,
        pdfX: round(first.x),
        pdfY: round(first.y),
        viewportX: round(origin.x),
        viewportY: round(origin.y)
      } : {})
    });
  }

  /** NPDE-style frame: edge strips move, circular dots resize. */
  private attachTextBoxOutline(surface: PageSurface, box: HTMLElement, annotation: PdfTextAnnotation): void {
    if (!this.textBoxesInteractable()) return;
    const outline = createDetachedDiv(box.ownerDocument);
    outline.className = "native-pdf-handwriting-text-selection-frame native-pdf-handwriting-selection-control";
    outline.dataset.annotationId = annotation.id;
    outline.setAttribute("aria-hidden", "true");
    this.layoutTextBoxOutline(surface, outline, annotation, annotation);

    const addControl = (kind: "move" | "resize", handle: TextBoxHandle): void => {
      const control = createDetachedDiv(box.ownerDocument);
      control.className = `native-pdf-handwriting-text-${kind}-${handle} native-pdf-handwriting-selection-control`;
      control.dataset.handle = handle;
      control.setAttribute("aria-label", kind === "move" ? "Move text box" : `Resize text box ${handle}`);
      control.addEventListener("pointerdown", (event) => this.startTextBoxTransform(surface, annotation, kind, handle, outline, event), { signal: this.pointerProbeAbort.signal });
      outline.append(control);
    };
    for (const handle of ["n", "e", "s", "w"] as const) addControl("move", handle);
    for (const handle of ["n", "e", "s", "w", "nw", "ne", "sw", "se"] as const) addControl("resize", handle);
    box.append(outline);
  }

  private startTextBoxTransform(
    surface: PageSurface,
    rendered: PdfTextAnnotation,
    mode: "move" | "resize",
    handle: TextBoxHandle,
    outline: HTMLElement,
    event: PointerEvent
  ): void {
    if (!this.textBoxesInteractable() || event.button !== 0) return;
    const annotation = this.texts.page(surface.page.pageNumber).find((text) => text.id === rendered.id);
    if (!annotation) return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelTextBoxTransform("superseded", false);
    const box = outline.parentElement;
    if (!box) return;
    const abort = new AbortController();
    const drag: TextBoxTransformDrag = {
      surface,
      pointerId: event.pointerId,
      start: this.textPointerToPdfPoint(surface, event),
      before: structuredClone(annotation),
      preview: structuredClone(annotation),
      mode,
      handle,
      box,
      outline,
      abort
    };
    this.textBoxTransformDrag = drag;
    box.classList.add("is-selected", "is-transforming");
    this.selected = [];
    this.selectedTexts = [annotation];
    this.selectionShape = boundingShapeFromSelection([], this.selectedTexts);
    this.selectionPage = surface.page.pageNumber;
    if (isElementInDocument(event.currentTarget, outline.ownerDocument)) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const options = { capture: true, signal: abort.signal };
    surface.overlay.ownerDocument.addEventListener("pointermove", (move) => this.updateTextBoxTransform(move), options);
    surface.overlay.ownerDocument.addEventListener("pointerup", (up) => this.finishTextBoxTransform(up), options);
    surface.overlay.ownerDocument.addEventListener("pointercancel", (cancel) => this.cancelTextBoxTransform("pointer-cancel", true, cancel), options);
    this.logText(surface, "box-transform-start", {
      annotationId: annotation.id, mode, handle,
      ...this.textGeometry(annotation)
    });
  }

  private updateTextBoxTransform(event: PointerEvent): void {
    const drag = this.textBoxTransformDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const point = this.textPointerToPdfPoint(drag.surface, event);
    if (drag.mode === "move") {
      drag.preview = {
        ...drag.before,
        x: drag.before.x + point.x - drag.start.x,
        y: drag.before.y + point.y - drag.start.y
      };
      const origin = this.mapper(drag.surface).toViewport({ x: drag.preview.x, y: drag.preview.y });
      const beforeOrigin = this.mapper(drag.surface).toViewport({ x: drag.before.x, y: drag.before.y });
      setElementCssProps(drag.box, {
        transform: `translate(${origin.x - beforeOrigin.x}px, ${origin.y - beforeOrigin.y}px)`
      });
      // The outline is a child of the translated static box, so it follows
      // exactly without adding the move delta a second time.
      this.layoutTextBoxOutline(drag.surface, drag.outline, drag.before, drag.before);
    } else {
      drag.preview = this.resizeTextAnnotation(drag.before, drag.handle, point);
      this.layoutTextBoxOutline(drag.surface, drag.outline, drag.preview, drag.before);
    }
  }

  private finishTextBoxTransform(event: PointerEvent): void {
    const drag = this.textBoxTransformDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    drag.abort.abort();
    this.textBoxTransformDrag = null;
    setElementCssProps(drag.box, { transform: "none" });
    const changed = drag.before.x !== drag.preview.x || drag.before.y !== drag.preview.y
      || drag.before.width !== drag.preview.width || drag.before.height !== drag.preview.height;
    if (changed) {
      const after = { ...drag.preview, updatedAt: new Date().toISOString() };
      this.executeHistory(new ReplaceTextAnnotationCommand(this.texts, drag.before, after), drag.surface.page.pageNumber);
      this.selectedTexts = [after];
      this.selectionShape = boundingShapeFromSelection([], this.selectedTexts);
      this.logText(drag.surface, "box-transform-commit", {
        annotationId: after.id, mode: drag.mode, handle: drag.handle,
        from: this.textGeometry(drag.before), to: this.textGeometry(after)
      });
    } else {
      this.logText(drag.surface, "box-transform-cancel", { annotationId: drag.before.id, mode: drag.mode, handle: drag.handle, reason: "unchanged" });
    }
    if (this.needsPagePaint(drag.surface.page.pageNumber)) this.renderPage(drag.surface.page.pageNumber);
  }

  private cancelTextBoxTransform(reason: string, render = true, event?: PointerEvent): void {
    const drag = this.textBoxTransformDrag;
    if (!drag) return;
    drag.abort.abort();
    this.textBoxTransformDrag = null;
    setElementCssProps(drag.box, { transform: "none" });
    drag.box.classList.remove("is-transforming");
    this.logText(drag.surface, "box-transform-cancel", { annotationId: drag.before.id, mode: drag.mode, handle: drag.handle, reason });
    if (render && !this.destroyed) this.renderPage(drag.surface.page.pageNumber);
    event?.preventDefault();
  }

  private textPointerToPdfPoint(surface: PageSurface, event: PointerEvent): Pick<PdfPoint, "x" | "y"> {
    const rect = surface.overlay.getBoundingClientRect();
    return this.mapper(surface).toPdf({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  private resizeTextAnnotation(before: PdfTextAnnotation, handle: TextBoxHandle, point: Pick<PdfPoint, "x" | "y">): PdfTextAnnotation {
    const minimumWidth = 24;
    const minimumHeight = Math.max(12, before.fontSize * 1.35);
    let left = before.x;
    let right = before.x + before.width;
    let top = before.y;
    let bottom = before.y - before.height;
    if (handle.includes("w")) left = Math.min(point.x, right - minimumWidth);
    if (handle.includes("e")) right = Math.max(point.x, left + minimumWidth);
    if (handle.includes("n")) top = Math.max(point.y, bottom + minimumHeight);
    if (handle.includes("s")) bottom = Math.min(point.y, top - minimumHeight);
    return { ...before, x: left, y: top, width: right - left, height: top - bottom };
  }

  /** Move/resize frame only; text itself reflows after the pointer is released. */
  private layoutTextBoxOutline(
    surface: PageSurface,
    outline: HTMLElement,
    annotation: PdfTextAnnotation,
    reference: PdfTextAnnotation
  ): void {
    const origin = this.mapper(surface).toViewport({ x: annotation.x, y: annotation.y });
    const referenceOrigin = this.mapper(surface).toViewport({ x: reference.x, y: reference.y });
    const scale = this.displayScale(surface);
    const height = Math.max(annotation.fontSize * scale * 1.4, annotation.height * scale);
    Object.assign(outline.style, {
      left: `${origin.x - referenceOrigin.x - 3}px`,
      top: `${origin.y - referenceOrigin.y - 3}px`,
      width: `${Math.max(24, annotation.width * scale) + 6}px`,
      height: `${height + 6}px`
    });
  }

  private tryStartSelectionMove(surface: PageSurface, sample: PointerSample): boolean {
    if (
      !this.selectionShape
      || this.selectionPage !== surface.page.pageNumber
      || (!this.selected.length && !this.selectedTexts.length)
    ) return false;
    const point = this.toPdfPoint(surface, sample, true);
    if (!shapeContainsPoint(this.selectionShape, point)) return false;
    this.moveDrag = {
      page: surface.page.pageNumber,
      start: point,
      before: this.selected.map((stroke) => structuredClone(stroke)),
      beforeTexts: this.selectedTexts.map((text) => structuredClone(text)),
      beforeShape: structuredClone(this.selectionShape)
    };
    this.movePreview = this.moveDrag.before;
    this.moveTextPreview = this.moveDrag.beforeTexts;
    this.moveShapePreview = this.moveDrag.beforeShape;
    this.logText(surface, "selection-move-start", {
      strokeCount: this.moveDrag.before.length,
      textCount: this.moveDrag.beforeTexts.length
    });
    return true;
  }

  private translateTextAnnotations(
    texts: readonly PdfTextAnnotation[],
    dx: number,
    dy: number,
    now = new Date().toISOString()
  ): PdfTextAnnotation[] {
    return texts.map((text) => ({ ...text, x: text.x + dx, y: text.y + dy, updatedAt: now }));
  }

  private deleteSelection(): void {
    this.reconcileSelection();
    if (!this.selected.length && !this.selectedTexts.length) {
      this.logger.textTool("selection-delete-skipped", { reason: "empty-selection" });
      return;
    }
    const strokes = [...this.selected];
    const texts = [...this.selectedTexts];
    const page = this.selectionPage;
    this.logger.textTool("selection-delete", {
      page,
      textCount: texts.length,
      strokeCount: strokes.length
    });
    // Clear chrome state before history paint so one page-local paint has no outlines.
    this.clearSelection({ refresh: false });
    this.executeHistory({
      label: "Delete annotations",
      execute: () => {
        strokes.forEach((stroke) => this.ink.remove(stroke.id));
        texts.forEach((text) => this.texts.remove(text.id));
      },
      undo: () => {
        strokes.forEach((stroke) => this.ink.add(stroke));
        texts.forEach((text) => this.texts.add(text));
      }
    }, page);
  }

  private copySelection(): void {
    if (!this.selected.length && !this.selectedTexts.length) {
      this.logger.textTool("selection-copy-skipped", { reason: "empty-selection" });
      return;
    }
    const sourcePage = this.selectionPage ?? this.options.adapter.getViewState().pageNumber;
    StrokeClipboard.store(this.selected, sourcePage, this.selectedTexts);
    this.pasteGeneration = 0;
    this.logger.textTool("selection-copy", {
      page: sourcePage,
      textCount: this.selectedTexts.length,
      strokeCount: this.selected.length
    });
  }

  private cutSelection(): void {
    this.logger.textTool("selection-cut", {
      page: this.selectionPage,
      textCount: this.selectedTexts.length,
      strokeCount: this.selected.length
    });
    this.copySelection();
    this.deleteSelection();
  }

  private pasteSelection(): void {
    const clipboard = StrokeClipboard.peek();
    if (!clipboard?.strokes.length && !clipboard?.texts.length) {
      this.logger.textTool("selection-paste-skipped", { reason: "empty-clipboard" });
      return;
    }
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
    const pastedTexts = clipboard.texts.map((text) => ({
      ...text, id: this.id(), page: targetPage, x: text.x + dx, y: text.y + dy,
      createdAt: now, updatedAt: now
    }));
    this.executeHistory({
      label: "Paste annotations",
      execute: () => { pasted.forEach((stroke) => this.ink.add(stroke)); pastedTexts.forEach((text) => this.texts.add(text)); },
      undo: () => { pasted.forEach((stroke) => this.ink.remove(stroke.id)); pastedTexts.forEach((text) => this.texts.remove(text.id)); }
    }, targetPage);
    this.selected = pasted;
    this.selectedTexts = pastedTexts;
    this.selectionPage = targetPage;
    this.selectionShape = boundingShapeFromSelection(pasted, pastedTexts);
    this.moveDrag = null;
    this.movePreview = null;
    this.moveTextPreview = null;
    this.moveShapePreview = null;
    this.ensureSelectionToolbar({ resetPlacement: true });
    this.logger.textTool("selection-paste", {
      sourcePage: clipboard.sourcePage,
      targetPage,
      textCount: pastedTexts.length,
      strokeCount: pasted.length,
      generation: this.pasteGeneration,
      dx,
      dy
    });
    this.refresh("paste-selection");
  }

  private duplicateSelection(): void {
    if (!this.selected.length && !this.selectedTexts.length) {
      this.logger.textTool("selection-duplicate-skipped", { reason: "empty-selection" });
      return;
    }
    const duplicates = translateStrokes(this.selected, 10, -10).map((stroke) => ({ ...stroke, id: this.id() }));
    const now = new Date().toISOString();
    const textDuplicates = this.selectedTexts.map((text) => ({ ...text, id: this.id(), x: text.x + 10, y: text.y - 10, createdAt: now, updatedAt: now }));
    const command: Command = {
      label: "Duplicate annotations",
      execute: () => { duplicates.forEach((stroke) => this.ink.add(stroke)); textDuplicates.forEach((text) => this.texts.add(text)); },
      undo: () => { duplicates.forEach((stroke) => this.ink.remove(stroke.id)); textDuplicates.forEach((text) => this.texts.remove(text.id)); }
    };
    this.executeHistory(command, this.selectionPage);
    this.selected = duplicates;
    this.selectedTexts = textDuplicates;
    this.selectionShape = boundingShapeFromSelection(duplicates, textDuplicates);
    this.ensureSelectionToolbar();
    this.logger.textTool("selection-duplicate", {
      page: this.selectionPage,
      textCount: textDuplicates.length,
      strokeCount: duplicates.length,
      dx: 10,
      dy: -10
    });
  }

  private recolorSelection(color: string): void {
    if (!this.selected.length && !this.selectedTexts.length) {
      this.logger.textTool("selection-recolor-skipped", { reason: "empty-selection", color });
      return;
    }
    const now = new Date().toISOString();
    const after = this.selected.map((stroke) => ({ ...stroke, color, updatedAt: now }));
    const textAfter = this.selectedTexts.map((text) => ({
      ...text,
      color,
      runs: text.runs.map((run) => ({ ...run, color })),
      sourceRuns: text.sourceRuns.map((run) => ({ ...run, color })),
      updatedAt: now
    }));
    const beforeStrokes = [...this.selected];
    const beforeTexts = [...this.selectedTexts];
    this.executeHistory({
      label: "Recolor annotations",
      execute: () => { after.forEach((stroke) => this.ink.replace(stroke)); textAfter.forEach((text) => this.texts.replace(text)); },
      undo: () => { beforeStrokes.forEach((stroke) => this.ink.replace(stroke)); beforeTexts.forEach((text) => this.texts.replace(text)); }
    }, this.selectionPage);
    this.selected = after;
    this.selectedTexts = textAfter;
    this.logger.textTool("selection-recolor", {
      page: this.selectionPage,
      color,
      textCount: textAfter.length,
      strokeCount: after.length
    });
  }

  private selectAllOnCurrentPage(): void {
    const pageNumber = this.options.adapter.getViewState().pageNumber;
    const surface = this.surfaces.get(pageNumber);
    const pageStrokes = this.ink.page(pageNumber);
    const pageTexts = this.texts.page(pageNumber);
    if (!surface || (!pageStrokes.length && !pageTexts.length)) {
      this.clearSelection();
      this.logger.refresh("select-all", { selected: 0, page: pageNumber, empty: true });
      this.logger.textTool("selection-select-all-empty", { page: pageNumber, reason: "page-empty-or-unavailable" });
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
    if (!selected.length && !pageTexts.length) {
      this.clearSelection();
      this.logger.refresh("select-all", { selected: 0, page: pageNumber, filtered: true });
      this.logger.textTool("selection-select-all-empty", { page: pageNumber, reason: "strokes-filtered" });
      return;
    }
    this.selected = selected;
    this.selectedTexts = [...pageTexts];
    this.selectionShape = boundingShapeFromSelection(selected, pageTexts);
    this.selectionPage = pageNumber;
    this.ensureSelectionToolbar({ resetPlacement: true });
    this.logger.textTool("selection-select-all", {
      page: pageNumber,
      textCount: pageTexts.length,
      strokeCount: selected.length,
      availableStrokeCount: pageStrokes.length
    });
    this.refresh("select-all");
  }

  private clearSelection(options: { refresh?: boolean } = {}): void {
    const textCount = this.selectedTexts.length;
    const strokeCount = this.selected.length;
    const page = this.selectionPage;
    this.selected = [];
    this.selectedTexts = [];
    this.selectionShape = null;
    this.selectionPage = null;
    this.moveDrag = null;
    this.movePreview = null;
    this.moveTextPreview = null;
    this.moveShapePreview = null;
    this.selectionToolbar.hide();
    if (textCount) this.logger.textTool("selection-clear", { page, textCount, strokeCount });
    if (options.refresh !== false) this.paintAfterClearSelection(page);
  }

  /** Drop selection chrome without a full multipage ink invalidate. */
  private paintAfterClearSelection(page: number | null): void {
    this.logger.refresh("clear-selection", {
      selected: 0,
      surfaces: this.surfaces.size,
      page,
      pages: page != null && this.surfaces.has(page) ? 1 : 0,
      pageLocal: true
    });
    if (page != null) {
      const surface = this.surfaces.get(page);
      if (surface) {
        this.invalidateInkLayer(surface);
        this.renderPage(page);
        this.renderTextAnnotations(surface);
      }
    }
    this.syncAnnotationCursorMode();
    this.refreshSurfaceCursors();
  }

  private reconcileSelection(): void {
    if ((!this.selected.length && !this.selectedTexts.length) || this.selectionPage === null) return;
    const pageStrokes = this.ink.page(this.selectionPage);
    const byId = new Map(pageStrokes.map((stroke) => [stroke.id, stroke]));
    const synced = this.selected
      .map((stroke) => byId.get(stroke.id))
      .filter((stroke): stroke is InkStroke => stroke !== undefined);
    const textById = new Map(this.texts.page(this.selectionPage).map((text) => [text.id, text]));
    const syncedTexts = this.selectedTexts
      .map((text) => textById.get(text.id))
      .filter((text): text is PdfTextAnnotation => text !== undefined);
    if (!synced.length && !syncedTexts.length) {
      const selectedTextCount = this.selectedTexts.length;
      const selectedStrokeCount = this.selected.length;
      const page = this.selectionPage;
      this.selected = [];
      this.selectedTexts = [];
      this.selectionShape = null;
      this.selectionPage = null;
      this.moveDrag = null;
      this.movePreview = null;
      this.moveTextPreview = null;
      this.moveShapePreview = null;
      this.selectionToolbar.hide();
      if (selectedTextCount) {
        this.logger.textTool("selection-reconciled-empty", {
          page,
          previousTextCount: selectedTextCount,
          previousStrokeCount: selectedStrokeCount
        });
      }
      return;
    }
    const strokesChanged = synced.length !== this.selected.length || synced.some((stroke, index) => stroke !== this.selected[index]);
    if (strokesChanged) this.selected = synced;
    if (syncedTexts.length !== this.selectedTexts.length || syncedTexts.some((text, index) => text !== this.selectedTexts[index])) {
      this.logger.textTool("selection-reconciled", {
        page: this.selectionPage,
        previousTextCount: this.selectedTexts.length,
        textCount: syncedTexts.length
      });
    }
    this.selectedTexts = syncedTexts;
    if (!this.selectionShape || this.selectionShape.type === "rectangle") {
      this.selectionShape = boundingShapeFromSelection(this.selected, this.selectedTexts);
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
      surface.inkLayer = createDetachedEl(surface.overlay.ownerDocument, 'canvas');
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
    const snap = createDetachedEl(surface.overlay.ownerDocument, 'canvas');
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
    // During burst/CSS handoff, only enqueue — releaseZoomCompositeLayers drains.
    if (this.isZoomHandoffActive()) return;
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
    if (this.destroyed) return;
    if (this.isZoomHandoffActive()) {
      if (this.inkUpgradePages.size > 0) {
        this.logger.refresh("ink-upgrade-deferred", {
          selected: this.selected.length,
          surfaces: this.surfaces.size,
          pages: this.inkUpgradePages.size,
          reason: this.zoomCompositing ? "zoom-compositing" : "zoom-handoff"
        });
        // Safety wake if release never runs; release path clears and drains at 0ms.
        this.inkUpgradeTimer = window.setTimeout(() => {
          this.inkUpgradeTimer = null;
          this.drainInkLayerUpgrades();
        }, ViewerInkSession.INK_UPGRADE_MS);
      }
      return;
    }
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
    if (this.hasZoomCompositingClass()) {
      this.logger.zoomFlashProxy("upgrade-while-compositing-class", {
        page: pageNumber,
        zoomCompositing: this.zoomCompositing
      });
    }
    surface.inkLayerValid = false;
    this.logger.refresh("ink-upgrade", {
      selected: this.selected.length,
      surfaces: this.surfaces.size,
      page: pageNumber,
      compositingClass: this.hasZoomCompositingClass(),
      msSinceSettle: this.zoomCompositeSettledAt > 0
        ? roundMs(performance.now() - this.zoomCompositeSettledAt)
        : null
    });
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
    reason = "",
    syncText = true,
    includeActivePreview = true
  ): void {
    const surface = this.surfaces.get(pageNumber);
    if (!surface || this.zoomCompositing) return;
    this.clearLiveDrawPreview(surface);
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
    const erasingLive = includeActivePreview
      && surface.editTool === "eraser"
      && surface.eraserSize !== undefined
      && surface.editPath.length > 0;
    const movingSelection = Boolean(this.movePreview?.length);
    const livePreview = includeActivePreview && (Boolean(surface.builder?.preview().length)
      || (surface.editTool === "lasso" && surface.editPath.length > 0)
      || Boolean(this.selectionShape && this.selectionPage === pageNumber));

    // pages-dom storms + idle zoomed pages: layout sync only — skip giant canvas blit.
    if (
      !needsResize
      && surface.inkLayerValid
      && !erasingLive
      && !movingSelection
      && !livePreview
      && (
        reason.includes("pages-sync")
        || reason.includes("pages-reattach")
        || reason.includes("native-content-reattach")
      )
    ) {
      return;
    }

    const paintStarted = performance.now();
    const previousPaint = this.lastPagePaintAt.get(pageNumber);
    if (
      previousPaint
      && paintStarted - previousPaint.at < ViewerInkSession.FLASH_DOUBLE_PAINT_MS
      && this.isZoomHandoffActive()
    ) {
      this.logger.zoomFlashProxy("double-paint-window", {
        page: pageNumber,
        reasons: [previousPaint.reason, reason || "render"],
        gapMs: roundMs(paintStarted - previousPaint.at)
      });
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

    this.lastPagePaintAt.set(pageNumber, { at: performance.now(), reason: reason || "render" });

    // Lasso/selection chrome is painted on the ink canvas (under the text layer
    // by default). Raise the canvas while that chrome is visible so text boxes
    // do not cover the outline — same look for ink-only and text selections.
    const drawingLasso = surface.editTool === "lasso" && surface.editPath.length > 0;
    const drawingSelection = Boolean(this.selectionShape && this.selectionPage === pageNumber) && !drawingLasso;
    surface.canvas.classList.toggle("is-selection-chrome-raised", drawingLasso || drawingSelection);
    if (drawingLasso) {
      this.drawLassoPreview(surface);
    } else if (drawingSelection && this.selectionShape) {
      this.drawSelectionShape(surface, this.moveShapePreview ?? this.selectionShape, { closeFreeform: true });
    }
    if (includeActivePreview && surface.builder?.preview().length) {
      if (surface.laserDraft) {
        const laser = this.options.settings.toolPreferences.laser;
        this.paintLaserPoints(
          surface,
          surface.builder.preview(true),
          laser.color,
          laser.width,
          laser.opacity,
          laser.holdMs,
          laser.fadeMs
        );
      } else {
        const draft = surface.builder.style;
        const draftId = surface.builder.id;
        this.drawPoints(
          surface,
          surface.shapePreview ?? surface.builder.preview(this.simplifyStrokesEnabled()),
          draft.color,
          draft.width,
          draft.opacity,
          draft.tool,
          false,
          draftId,
          // Pencil: full grit while dragging so release does not densify/reseed.
          draft.tool === "pencil" ? "full" : "draft"
        );
      }
    }
    this.paintLaserTrails(surface, pageNumber);
    if (syncText) this.renderTextAnnotations(surface);
  }

  private paintLaserPoints(
    surface: PageSurface,
    points: readonly PdfPoint[],
    color: string,
    width: number,
    opacity: number,
    holdMs: number,
    fadeMs: number
  ): void {
    if (!points.length) return;
    const mapper = this.mapper(surface);
    const scale = this.displayScale(surface);
    drawLaserStroke(surface.context, mapLaserPoints(points, (point) => mapper.toViewport(point)), {
      color,
      width: Math.max(1, width * scale),
      opacity,
      nowMs: performance.now(),
      holdMs,
      fadeMs
    });
    this.lastLaserPaintAt = performance.now();
  }

  private trimLaserDraft(surface: PageSurface, now: number): void {
    if (!surface.laserDraft || !surface.builder) return;
    const laser = this.options.settings.toolPreferences.laser;
    const retentionMs = Math.max(0, laser.holdMs) + Math.max(1, laser.fadeMs);
    surface.laserDiscardedPoints += surface.builder.discardBefore(now - retentionMs);
    surface.laserDiscardedPoints += surface.builder.discardToMaxPoints(ViewerInkSession.MAX_LASER_DRAFT_POINTS);
  }

  private paintLaserTrails(surface: PageSurface, pageNumber: number): void {
    for (const trail of this.laserTrails) {
      if (trail.page !== pageNumber) continue;
      this.paintLaserPoints(
        surface,
        trail.points,
        trail.color,
        trail.width,
        trail.opacity,
        trail.holdMs,
        trail.fadeMs
      );
    }
  }

  /** Blit cached ink + lasers only — avoids full committed-stroke rebuild every fade tick. */
  private repaintLaserOverlay(pageNumber: number): void {
    const surface = this.surfaces.get(pageNumber);
    if (!surface) return;
    if (!surface.inkLayerValid || !surface.inkLayer) {
      this.renderPage(pageNumber);
      return;
    }
    const rect = surface.overlay.getBoundingClientRect();
    const layout = this.pageLayout(surface);
    const width = Math.max(1, rect.width >= 8 ? rect.width : layout.contentWidth || 1);
    const height = Math.max(1, rect.height >= 8 ? rect.height : layout.contentHeight || 1);
    const { pixelWidth, pixelHeight, backingScale } = inkBackingSize(
      width,
      height,
      window.devicePixelRatio || 1
    );
    // Must restore CSS-pixel transform after the identity blit — same as blitInkLayerToCanvas.
    const startedAt = performance.now();
    this.blitInkLayerToCanvas(surface, pixelWidth, pixelHeight, backingScale);
    const laserDraftPoints = surface.laserDraft ? surface.builder?.preview(true) ?? [] : [];
    if (laserDraftPoints.length) {
      const laser = this.options.settings.toolPreferences.laser;
      this.paintLaserPoints(
        surface,
        laserDraftPoints,
        laser.color,
        laser.width,
        laser.opacity,
        laser.holdMs,
        laser.fadeMs
      );
    } else if (surface.builder?.preview().length && !surface.laserDraft) {
      this.renderPage(pageNumber);
      return;
    }
    this.paintLaserTrails(surface, pageNumber);
    const durationMs = performance.now() - startedAt;
    if (durationMs >= 16) {
      this.logger.laserRepaintSlow(pageNumber, durationMs, laserDraftPoints.length, this.laserTrails.length);
    }
  }

  private ensureLaserFadeLoop(): void {
    if (this.destroyed || this.laserFadeFrame !== null) return;
    const view = this.options.adapter.host.ownerDocument.defaultView;
    if (!view) return;
    const tick = (now: number): void => {
      this.laserFadeFrame = null;
      if (this.destroyed) return;

      const dirtyPages = new Set<number>();
      for (const trail of this.laserTrails) dirtyPages.add(trail.page);
      let visibleDraft = false;
      for (const surface of this.surfaces.values()) {
        if (!surface.laserDraft) continue;
        this.trimLaserDraft(surface, now);
        const laser = this.options.settings.toolPreferences.laser;
        const points = surface.builder?.preview(true) ?? [];
        if (!laserTrailStillVisible(points, now, laser.holdMs, laser.fadeMs)) continue;
        visibleDraft = true;
        dirtyPages.add(surface.page.pageNumber);
      }

      this.laserTrails = this.laserTrails.filter((trail) => {
        dirtyPages.add(trail.page);
        return laserTrailStillVisible(trail.points, now, trail.holdMs, trail.fadeMs);
      });

      // Skip if pointermove just painted (avoids double full-canvas work while dragging).
      const recentlyPainted = now - this.lastLaserPaintAt < ViewerInkSession.LASER_FADE_MIN_MS;
      if (!recentlyPainted) {
        for (const page of dirtyPages) this.repaintLaserOverlay(page);
      }

      const stillActive = this.laserTrails.length > 0 || visibleDraft;
      if (stillActive) {
        this.laserFadeFrame = view.requestAnimationFrame(tick);
      }
    };
    this.laserFadeFrame = view.requestAnimationFrame(tick);
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
    } else if (tool === "highlighter") {
      const prefs = this.options.settings.toolPreferences.highlighter;
      const viewPoints = points.map((point) => {
        const view = mapper.toViewport(point);
        return { x: view.x, y: view.y, pressure: point.pressure };
      });
      drawHighlighterStroke(context, viewPoints, {
        color,
        width: Math.max(2, width * scale),
        opacity,
        pressureSensitivity: prefs.pressureSensitivity,
        thinning: prefs.thinning
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

  private toPdfPoints(
    surface: PageSurface,
    samples: readonly PointerSample[],
    simulateMousePressure: boolean
  ): PdfPoint[] {
    const overlayRect = surface.overlay.getBoundingClientRect();
    const mapper = this.mapper(surface);
    return samples.map((sample) => {
      const viewport = { x: sample.clientX - overlayRect.left, y: sample.clientY - overlayRect.top };
      const point = mapper.toPdf(viewport);
      const pressure = sample.pressure > 0 ? sample.pressure : simulateMousePressure ? 0.5 : 1;
      return { x: point.x, y: point.y, pressure, tiltX: sample.tiltX, tiltY: sample.tiltY, time: sample.timeStamp };
    });
  }

  private toPdfPoint(surface: PageSurface, sample: PointerSample, simulateMousePressure: boolean): PdfPoint {
    return this.toPdfPoints(surface, [sample], simulateMousePressure)[0]!;
  }

  private projectInkScreenPoint(surface: PageSurface, clientX: number, clientY: number): { x: number; y: number } {
    const overlayRect = surface.overlay.getBoundingClientRect();
    const viewport = { x: clientX - overlayRect.left, y: clientY - overlayRect.top };
    const mapper = this.mapper(surface);
    const projected = mapper.toViewport(mapper.toPdf(viewport));
    return { x: overlayRect.left + projected.x, y: overlayRect.top + projected.y };
  }

  private logPositionAlign(
    surface: PageSurface,
    sample: PointerSample,
    phase: "move" | "start" | "end"
  ): void {
    if (!this.logger.shouldLogPositionAlign(phase)) return;
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
    const storedTexts = new Map<number, PdfTextAnnotation[]>();
    for (const stroke of this.ink.all()) stored.set(stroke.page, [...(stored.get(stroke.page) ?? []), stroke]);
    for (const text of this.texts.all()) storedTexts.set(text.page, [...(storedTexts.get(text.page) ?? []), text]);
    const known = new Map(this.options.adapter.pages().map((page) => [page.pageNumber, page]));
    return {
      schemaVersion: 1,
      document: this.identity,
      pages: [...new Set([...stored.keys(), ...storedTexts.keys()])].map((pageNumber) => {
        const strokes = stored.get(pageNumber) ?? [];
        const texts = storedTexts.get(pageNumber) ?? [];
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
          ...(texts.length ? { texts } : {})
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
    const textCount = countSidecarTexts(snapshot);
    const started = performance.now();
    let recoveryWriteMs: number | null = null;
    let sidecarWriteMs: number | null = null;
    let recoveryClearMs: number | null = null;
    const reportPersist = (outcome: string): void => this.reportDevProbe("sidecar-persist", {
      reason,
      outcome,
      durationMs: roundMs(performance.now() - started),
      recoveryWriteMs,
      sidecarWriteMs,
      recoveryClearMs,
      strokeCount,
      textCount
    });
    if (!this.stillOwnsPersist()) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        textCount,
        dirty: false,
        updatedAt: snapshot.updatedAt,
        skipped: this.writesAbandoned ? "abandoned-writer" : "destroyed"
      });
      reportPersist(this.writesAbandoned ? "skipped-abandoned" : "skipped-destroyed");
      return;
    }
    try {
      // Re-check after each await so emergency sync from another session cannot be overwritten.
      if (!this.stillOwnsPersist()) {
        reportPersist("skipped-before-recovery");
        return;
      }
      const recoveryWriteStarted = performance.now();
      await this.options.recovery.save(snapshot);
      recoveryWriteMs = roundMs(performance.now() - recoveryWriteStarted);
      if (!this.stillOwnsPersist()) {
        const recoveryClearStarted = performance.now();
        await this.options.recovery.clear(this.identity.id).catch(() => undefined);
        recoveryClearMs = roundMs(performance.now() - recoveryClearStarted);
        this.logger.sidecarPersist({
          reason,
          documentId: this.identity.id,
          strokeCount,
          textCount,
          dirty: false,
          updatedAt: snapshot.updatedAt,
          skipped: "abandoned-after-recovery"
        });
        reportPersist("skipped-after-recovery");
        return;
      }
      const sidecarWriteStarted = performance.now();
      await this.options.sidecars.save(snapshot);
      sidecarWriteMs = roundMs(performance.now() - sidecarWriteStarted);
      if (!this.stillOwnsPersist()) {
        this.logger.sidecarPersist({
          reason,
          documentId: this.identity.id,
          strokeCount,
          textCount,
          dirty: false,
          updatedAt: snapshot.updatedAt,
          skipped: "abandoned-after-sidecar"
        });
        reportPersist("skipped-after-sidecar");
        return;
      }
      const recoveryClearStarted = performance.now();
      await this.options.recovery.clear(this.identity.id);
      recoveryClearMs = roundMs(performance.now() - recoveryClearStarted);
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        textCount,
        dirty: false,
        updatedAt: snapshot.updatedAt
      });
      reportPersist("saved");
    } catch (error) {
      this.logger.sidecarPersist({
        reason,
        documentId: this.identity.id,
        strokeCount,
        textCount,
        dirty: this.isDirty(),
        updatedAt: snapshot.updatedAt,
        error: this.errorMessage(error)
      });
      reportPersist("error");
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

  setBoostedPdfZoom(enabled: boolean): void {
    this.options.adapter.setBoostedZoom?.(enabled);
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

  private async handleMore(action: MoreAction): Promise<void> {
    if (action === "export") {
      await this.exportCopy().catch((error) => this.options.notice(`Export failed: ${this.errorMessage(error)}`));
      return;
    }
    if (action === "export-editable") {
      await this.exportCopy("editable").catch((error) => this.options.notice(`Export failed: ${this.errorMessage(error)}`));
      return;
    }
    if (action === "toolbar-main" || action === "toolbar-left" || action === "toolbar-right") {
      const placement = action.replace("toolbar-", "") as ToolbarPlacement;
      const previousPlacement = this.currentToolbarPlacement();
      this.logger.toolbarPlacement("request", { previousPlacement, requestedPlacement: placement });
      // Prefer savePluginSettings (assigns via saveSettings + remounts open leaves). Local mutate is fallback only.
      try {
        if (this.options.savePluginSettings) await this.options.savePluginSettings({ toolbarPlacement: placement });
        else this.options.settings.toolbarPlacement = placement;
        this.remountToolbar();
        this.logger.toolbarPlacement("applied", {
          previousPlacement,
          requestedPlacement: placement,
          resolvedPlacement: this.currentToolbarPlacement()
        });
      } catch (error) {
        this.logger.toolbarPlacement("error", {
          previousPlacement,
          requestedPlacement: placement,
          error: this.errorMessage(error)
        });
        throw error;
      }
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
    const sampled = samplePoints(points, 24);
    this.logger.draw({
      phase,
      page: surface.page.pageNumber,
      tool,
      displayScale: Number(this.displayScale(surface).toFixed(4)),
      pointCount: points.length,
      bounds: drawBounds(points),
      points: sampled.map((point) => ({
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

function samplePoints<T>(points: readonly T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return [...points];
  const sampled: T[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    sampled.push(points[Math.round((index * (points.length - 1)) / (maxPoints - 1))]!);
  }
  return sampled;
}

function drawBounds(points: readonly PdfPoint[]): NonNullable<DrawPositionLog["bounds"]> {
  let minX = points[0]!.x;
  let minY = points[0]!.y;
  let maxX = minX;
  let maxY = minY;
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX: round(minX), minY: round(minY), maxX: round(maxX), maxY: round(maxY) };
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
