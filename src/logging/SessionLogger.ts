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

  constructor(
    private readonly documentPath: string,
    private readonly vaultLog?: VaultLogSink
  ) {}

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
      pointCount: entry.points.length,
      bounds
    });
  }

  positionAlign(entry: PositionAlignLog): void {
    if (entry.phase === "move") {
      this.alignMoveCount += 1;
      if (this.alignMoveCount !== 1 && this.alignMoveCount % 6 !== 0) return;
    } else {
      this.alignMoveCount = 0;
    }
    this.emit("info", "ink align", {
      document: this.documentPath,
      ...entry
    });
  }

  pointerRoute(route: string, details: Record<string, unknown> = {}): void {
    this.emit("info", "pointer route", {
      document: this.documentPath,
      route,
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

  sessionAttach(details: {
    scrollRoot: string;
    panCapture: string;
    panBoundary?: string;
    drawEnabled?: boolean;
    toolbarPlacement?: string;
    loadedStrokes?: number;
    sidecarStrokes?: number;
    recoveryStrokes?: number;
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
    recoveryStrokes: number;
    loadedStrokes: number;
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

  private emit(level: "info" | "warn", event: string, payload: Record<string, unknown>): void {
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
