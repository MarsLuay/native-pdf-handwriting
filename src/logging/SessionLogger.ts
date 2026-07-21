import type { PdfViewState } from "../integration/ObsidianPdfAdapter";
import type { VaultLogSink } from "./VaultLogSink";

const PREFIX = "[Handwriting Natively]";

export type ViewStateSource =
  | "scalechanging"
  | "pagechanging"
  | "rotationchanging"
  | "scroll"
  | "data-scale"
  | "pages-dom";

export interface DrawPositionLog {
  phase: "start" | "end" | "eraser" | "lasso";
  page: number;
  tool: string;
  displayScale: number;
  points: Array<{ x: number; y: number; pressure?: number }>;
  /** Full input count when `points` is a bounded diagnostic sample. */
  pointCount?: number;
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface PositionAlignLog {
  phase: "move" | "start" | "end";
  page: number;
  clientX: number;
  clientY: number;
  host: { left: number; top: number; width: number; height: number };
  content: { left: number; top: number; width: number; height: number } | null;
  overlay?: { left: number; top: number; width: number; height: number };
  layout: {
    offsetX: number;
    offsetY: number;
    scale: number;
    scaleX: number;
    scaleY: number;
    pdfWidth: number;
    pdfHeight: number;
  };
  viewport: { x: number; y: number };
  pdf: { x: number; y: number };
  inkScreen: { x: number; y: number };
  delta: { x: number; y: number };
}

export interface ZoomRepaintLog {
  reason: string;
  durationMs: number;
  pagesRepainted: number;
  canvasesResized: number;
  strokesRedrawn: number;
  skippedDisconnected: number;
  msSinceLastRepaint?: number | null;
  burstTicks?: number;
  burstDurationMs?: number;
  scaleStart?: number;
  scaleEnd?: number;
  scale?: number;
}

export interface ZoomTickLog {
  reason: string;
  tick: number;
  source?: string;
  scale?: number;
  msSinceLastTick?: number | null;
}

export class SessionLogger {
  private lastViewState: PdfViewState | null = null;
  private refreshWindowStart = 0;
  private refreshWindowCount = 0;
  private zoomRepaintWindowStart = 0;
  private zoomRepaintWindowCount = 0;
  private lastZoomRepaintAt = 0;
  private lastZoomTickAt = 0;
  private mousePanMoveCount = 0;
  private alignMoveCount = 0;
  private shapeResizeMoveCount = 0;
  private readonly textToolHotCounts = new Map<string, number>();
  /** High-frequency text phases — sample so vault debug does not flood disk I/O. */
  private static readonly TEXT_TOOL_HOT_PHASES = new Set([
    "render",
    "selectionchange",
    "selection-snapshot",
    "render-skipped-active-editor",
    "beforeinput",
    "input",
    "selection",
    "resize",
    "compositionupdate"
  ]);
  /** Reset hot-phase counters when an editor session boundary is crossed. */
  private static readonly TEXT_TOOL_BOUNDARY_PHASES = new Set([
    "focus",
    "blur",
    "focus-ready",
    "editor-open-new",
    "editor-open-existing",
    "commit-create",
    "commit-update",
    "discard-empty",
    "delete-empty",
    "escape"
  ]);

  constructor(
    private readonly documentPath: string,
    private readonly vaultLog?: VaultLogSink,
    private readonly debugEnabled: () => boolean = () => true
  ) {}

  isEnabled(): boolean { return this.debugEnabled(); }

  refresh(reason: string, details: Record<string, unknown> = {}): void {
    const now = Date.now();
    if (!this.refreshWindowStart || now - this.refreshWindowStart > 250) {
      this.refreshWindowStart = now;
      this.refreshWindowCount = 0;
    }
    this.refreshWindowCount += 1;
    const payload = {
      document: this.documentPath,
      reason,
      burstCount: this.refreshWindowCount,
      ...details
    };
    this.emit("info", "session refresh", payload);
    if (this.refreshWindowCount >= 12) {
      this.emit("warn", "refresh storm", payload);
    }
  }

  loopBlocked(kind: string, depth: number): void {
    this.emit("warn", "loop blocked", {
      document: this.documentPath,
      kind,
      depth
    });
  }

  lassoSelection(page: number, strokeCount: number, pathPoints: number, shape: string): void {
    this.emit("info", "lasso selection", {
      document: this.documentPath,
      page,
      strokeCount,
      pathPoints,
      shape
    });
  }

  lassoSelectionFiltered(page: number, matchedCount: number, details: Record<string, unknown> = {}): void {
    this.emit("info", "lasso selection filtered", {
      document: this.documentPath,
      page,
      matchedCount,
      reason: "not-discernible-on-overlay",
      ...details
    });
  }

  viewState(state: PdfViewState, source: ViewStateSource): void {
    const previousScale = this.lastViewState?.scale ?? state.scale;
    this.lastViewState = { ...state };
    const delta = state.scale - previousScale;
    const action = Math.abs(delta) <= 0.0001
      ? "view-change"
      : delta > 0
        ? "zoom-in"
        : "zoom-out";
    const shouldLogZoom = source === "scalechanging" || source === "data-scale";
    const shouldLogView = source === "pagechanging" || source === "rotationchanging";
    if (!shouldLogZoom && !shouldLogView) return;
    this.emit("info", shouldLogZoom ? "pdf zoom" : "pdf view", {
      document: this.documentPath,
      action,
      source,
      pageNumber: state.pageNumber,
      previousScale,
      scale: state.scale,
      rotation: state.rotation,
      scrollFraction: Number(state.scrollFraction.toFixed(4))
    });
  }

  pagesChanged(reason: string, pageCount: number, overlayConnected: Record<number, boolean>): void {
    this.emit("info", "pdf pages", {
      document: this.documentPath,
      reason,
      pageCount,
      overlayConnected
    });
  }

  draw(entry: DrawPositionLog): void {
    const bounds = entry.bounds ?? boundsFrom(entry.points);
    this.emit("info", "draw position", {
      document: this.documentPath,
      ...entry,
      pointCount: entry.pointCount ?? entry.points.length,
      bounds
    });
  }

  laserDraft(page: number, retainedPoints: number, discardedPoints: number, retentionMs: number): void {
    this.emit("info", "laser draft", {
      document: this.documentPath,
      page,
      retainedPoints,
      discardedPoints,
      retentionMs
    });
  }

  laserRepaintSlow(page: number, durationMs: number, draftPoints: number, trailCount: number): void {
    this.emit("warn", "laser repaint slow", {
      document: this.documentPath,
      page,
      durationMs: round(durationMs),
      draftPoints,
      trailCount
    });
  }

  positionAlign(entry: PositionAlignLog): void {
    this.emit("info", "ink align", {
      document: this.documentPath,
      ...entry
    });
  }

  /** Check sampling before callers spend time gathering layout diagnostics. */
  shouldLogPositionAlign(phase: PositionAlignLog["phase"]): boolean {
    if (!this.isEnabled()) return false;
    if (phase === "move") {
      this.alignMoveCount += 1;
      return this.alignMoveCount === 1 || this.alignMoveCount % 6 === 0;
    } else {
      this.alignMoveCount = 0;
    }
    return true;
  }

  /** Slow live input frames are actionable; normal frames remain silent. */
  inputPaint(page: number, durationMs: number, kind: "draw" | "edit", sampleCount: number): void {
    if (!this.isEnabled() || durationMs < 8) return;
    this.emit(durationMs >= 16 ? "warn" : "info", "ink input paint", {
      document: this.documentPath,
      page,
      kind,
      durationMs: round(durationMs),
      sampleCount
    });
  }

  pointerRoute(route: string, details: Record<string, unknown> = {}): void {
    this.emit("info", "pointer route", {
      document: this.documentPath,
      route,
      ...details
    });
  }

  /** Input ownership identifies and replaces duplicate page routers. */
  inputOwner(phase: "claim" | "supersede" | "release", details: Record<string, unknown> = {}): void {
    this.emit("info", "session input owner", {
      document: this.documentPath,
      phase,
      ...details
    });
  }

  /** Raw pointer/touch probe — every type (mouse/pen/touch/…) for diagnosis. */
  pointerSeen(details: Record<string, unknown>): void {
    this.emit("info", "pointer seen", {
      document: this.documentPath,
      ...details
    });
  }

  /**
   * Structured Text-tool diagnostics. Annotation contents never enter logs;
   * use lengths, line counts, geometry, and style flags to diagnose behavior.
   * Hot phases (render/selection/input) are sampled like ink-align moves.
   */
  textTool(phase: string, details: Record<string, unknown> = {}): void {
    if (SessionLogger.TEXT_TOOL_BOUNDARY_PHASES.has(phase)) {
      this.textToolHotCounts.clear();
    }
    let sampled: Record<string, unknown> = {};
    if (SessionLogger.TEXT_TOOL_HOT_PHASES.has(phase)) {
      const n = (this.textToolHotCounts.get(phase) ?? 0) + 1;
      this.textToolHotCounts.set(phase, n);
      if (n !== 1 && n % 10 !== 0) return;
      sampled = { sampled: true, sampleN: n };
    }
    this.emit("info", "text tool", {
      document: this.documentPath,
      phase,
      ...redactTextToolDetails(details),
      ...sampled
    });
  }

  /** Shape hold/resize diagnostics, with resize moves sampled to keep logs usable. */
  shapeTool(phase: "recognized" | "resize" | "commit" | "cancel", details: Record<string, unknown> = {}): void {
    if (phase === "resize") {
      this.shapeResizeMoveCount += 1;
      if (this.shapeResizeMoveCount !== 1 && this.shapeResizeMoveCount % 6 !== 0) return;
    } else {
      this.shapeResizeMoveCount = 0;
    }
    this.emit("info", "shape tool", {
      document: this.documentPath,
      phase,
      ...details
    });
  }

  mousePan(phase: "probe" | "start" | "pending" | "activate" | "move" | "end" | "cancel" | "abort" | "skip" | "config", details: Record<string, unknown> = {}): void {
    if (phase === "move") {
      this.mousePanMoveCount += 1;
      if (this.mousePanMoveCount !== 1 && this.mousePanMoveCount % 8 !== 0) return;
    } else if (phase === "start" || phase === "probe") {
      this.mousePanMoveCount = 0;
    }
    this.emit("info", "mouse pan", {
      document: this.documentPath,
      phase,
      ...details
    });
  }

  /** Placement transitions make stale More-menu state and failed remounts diagnosable. */
  toolbarPlacement(phase: "request" | "applied" | "error", details: Record<string, unknown> = {}): void {
    this.emit(phase === "error" ? "warn" : "info", "toolbar placement", {
      document: this.documentPath,
      phase,
      ...details
    });
  }

  sessionAttach(details: {
    scrollRoot: string;
    panCapture: string;
    panBoundary?: string;
    drawEnabled?: boolean;
    mouseDragScroll?: boolean;
    toolbarPlacement?: string;
    loadedStrokes?: number;
    loadedTexts?: number;
    sidecarStrokes?: number;
    sidecarTexts?: number;
    recoveryStrokes?: number;
    recoveryTexts?: number;
    persistEpoch?: number;
  }): void {
    this.emit("info", "session attach", {
      document: this.documentPath,
      ...details
    });
  }

  sidecarLoad(details: {
    documentId: string;
    sidecarStrokes: number;
    sidecarTexts?: number;
    recoveryStrokes: number;
    recoveryTexts?: number;
    loadedStrokes: number;
    loadedTexts?: number;
    sidecarUpdatedAt: string | null;
    recoveryUpdatedAt: string | null;
  }): void {
    this.emit("info", "sidecar load", {
      document: this.documentPath,
      ...details
    });
  }

  sidecarPersist(details: {
    reason: string;
    documentId: string;
    strokeCount: number;
    textCount?: number;
    dirty: boolean;
    updatedAt: string;
    skipped?: string;
    error?: string;
  }): void {
    this.emit(details.error || details.skipped ? "warn" : "info", "sidecar persist", {
      document: this.documentPath,
      ...details
    });
  }

  sessionDestroy(details: {
    reason: string;
    silent: boolean;
    strokeCount: number;
    textCount?: number;
    dirty: boolean;
    alreadyPersisted: boolean;
  }): void {
    this.emit("info", "session destroy", {
      document: this.documentPath,
      ...details
    });
  }

  zoomTick(details: ZoomTickLog): void {
    const now = performance.now();
    const msSinceLastTick = this.lastZoomTickAt ? round(now - this.lastZoomTickAt) : null;
    this.lastZoomTickAt = now;
    this.emit("info", "ink zoom tick", {
      document: this.documentPath,
      deferred: true,
      msSinceLastTick,
      ...details
    });
  }

  zoomRepaint(details: ZoomRepaintLog): void {
    const now = performance.now();
    const msSinceLastRepaint = this.lastZoomRepaintAt ? round(now - this.lastZoomRepaintAt) : null;
    this.lastZoomRepaintAt = now;

    if (!this.zoomRepaintWindowStart || now - this.zoomRepaintWindowStart > 500) {
      this.zoomRepaintWindowStart = now;
      this.zoomRepaintWindowCount = 0;
    }
    this.zoomRepaintWindowCount += 1;
    const burstWindowMs = now - this.zoomRepaintWindowStart;
    const repaintsPerSec = burstWindowMs > 0
      ? round((this.zoomRepaintWindowCount / burstWindowMs) * 1000)
      : 0;

    const payload = {
      document: this.documentPath,
      ...details,
      msSinceLastRepaint,
      burstCount: this.zoomRepaintWindowCount,
      repaintsPerSec,
      burstWindowMs: round(burstWindowMs)
    };
    this.emit("info", "ink zoom repaint", payload);
    if (details.durationMs >= 16 || (msSinceLastRepaint !== null && msSinceLastRepaint < 32)) {
      this.emit("warn", "ink zoom repaint hot", payload);
    }
  }

  zoomRepaintInterrupt(reason: string, details: Record<string, unknown> = {}): void {
    this.emit("warn", "ink zoom repaint interrupt", {
      document: this.documentPath,
      reason,
      ...details
    });
  }

  /** Tracks the compositor handoff around a zoom-settle repaint. */
  zoomComposite(
    phase: "begin" | "settle-paint" | "native-content" | "release-scheduled" | "release",
    details: Record<string, unknown> = {}
  ): void {
    this.emit("info", "ink zoom composite", {
      document: this.documentPath,
      phase,
      ...details
    });
  }

  /**
   * Heuristic flash detectors (blank/handoff races). Warn so vault debug log
   * surfaces them without a dedicated frame-capture metric.
   */
  zoomFlashProxy(proxy: string, details: Record<string, unknown> = {}): void {
    this.emit("warn", "ink zoom flash proxy", {
      document: this.documentPath,
      proxy,
      ...details
    });
  }

  private emit(level: "info" | "warn", event: string, payload: Record<string, unknown>): void {
    if (!this.isEnabled()) return;
    if (level === "info") console.debug(PREFIX, event, payload);
    else console.warn(PREFIX, event, payload);
    this.vaultLog?.write(level, event, payload);
  }
}

function boundsFrom(points: readonly { x: number; y: number }[]): DrawPositionLog["bounds"] | undefined {
  if (!points.length) return undefined;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: round(xs.reduce((min, value) => Math.min(min, value), xs[0]!)),
    minY: round(ys.reduce((min, value) => Math.min(min, value), ys[0]!)),
    maxX: round(xs.reduce((max, value) => Math.max(max, value), xs[0]!)),
    maxY: round(ys.reduce((max, value) => Math.max(max, value), ys[0]!))
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const TEXT_CONTENT_KEYS = new Set(["text", "content", "html", "value", "data", "runs", "sourceruns"]);

/** Keep text-tool debug diagnostics useful without storing annotation contents. */
function redactTextToolDetails(details: Record<string, unknown>): Record<string, unknown> {
  return redactTextToolValue(details) as Record<string, unknown>;
}

function redactTextToolValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTextToolValue);
  if (!value || typeof value !== "object") return value;
  const safe: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (TEXT_CONTENT_KEYS.has(key.toLowerCase())) continue;
    safe[key] = redactTextToolValue(child);
  }
  return safe;
}
