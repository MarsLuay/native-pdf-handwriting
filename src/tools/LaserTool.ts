import type { PdfPoint } from "../model";

export interface LaserPoint {
  x: number;
  y: number;
  /** DOMHighRes timestamp when the sample arrived (`performance.now()` clock). */
  time?: number;
}

export interface LaserStrokeOptions {
  color: string;
  width: number;
  opacity: number;
  /** When set with hold/fade, only the oldest tip trims/fades. */
  nowMs?: number;
  holdMs?: number;
  fadeMs?: number;
}

export interface LaserTrailSlice {
  /** Remaining trail (oldest tip may be advanced along the path while fading). */
  points: LaserPoint[];
  /** 0..1 age progress of the oldest tip sample (used to advance tip geometry). */
  tipFade: number;
}

/** Opacity for one sample age — used only for the disappearing tip. */
export function laserSampleOpacity(
  ageMs: number,
  holdMs: number,
  fadeMs: number
): number {
  const hold = Math.max(0, holdMs);
  const fade = Math.max(1, fadeMs);
  if (ageMs <= hold) return 1;
  if (ageMs >= hold + fade) return 0;
  return 1 - (ageMs - hold) / fade;
}

function pointAge(point: LaserPoint, nowMs: number): number {
  const time = typeof point.time === "number" && Number.isFinite(point.time) ? point.time : nowMs;
  return Math.max(0, nowMs - time);
}

/**
 * Drop fully expired points. Soft tip-fade advances the tip along the path
 * so the trailing triangle stays full-opacity and fixed-length.
 */
export function sliceLaserTrailByAge(
  points: readonly LaserPoint[],
  nowMs: number,
  holdMs: number,
  fadeMs: number
): LaserTrailSlice | null {
  if (!points.length) return null;
  const hold = Math.max(0, holdMs);
  const fade = Math.max(1, fadeMs);
  const maxAge = hold + fade;

  let start = 0;
  while (start < points.length && pointAge(points[start]!, nowMs) >= maxAge) {
    start += 1;
  }
  if (start >= points.length) return null;

  let kept = points.slice(start).map((point) => ({ ...point }));
  const tipFade = laserSampleOpacity(pointAge(kept[0]!, nowMs), hold, fade);
  if (tipFade <= 0.001 && kept.length === 1) return null;

  // While the oldest sample is in the fade window, slide tip forward (don't ghost alpha).
  if (tipFade < 0.999 && kept.length >= 2) {
    kept = advanceLaserTipAlongPath(kept, 1 - tipFade);
  }

  return { points: kept, tipFade: Math.max(0, tipFade) };
}

/** True while any sample is still within hold+fade. */
export function laserTrailStillVisible(
  points: readonly LaserPoint[],
  nowMs: number,
  holdMs: number,
  fadeMs: number
): boolean {
  return sliceLaserTrailByAge(points, nowMs, holdMs, fadeMs) !== null;
}

/**
 * Flat solid trail — full-width body; fixed-length tip triangle at the oldest end.
 * Tip shape stays constant while disappearing (trail shortens; tip does not soft-fade).
 */
export function drawLaserStroke(
  context: CanvasRenderingContext2D,
  points: readonly LaserPoint[],
  options: LaserStrokeOptions
): void {
  if (!points.length || options.opacity <= 0.001) return;
  const ageAware = options.nowMs !== undefined
    && options.holdMs !== undefined
    && options.fadeMs !== undefined;
  const width = Math.max(1, options.width);

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  context.miterLimit = 2;

  if (!ageAware) {
    if (points.length === 1) {
      paintLaserDot(context, points[0]!, width, options.color, options.opacity);
    } else {
      paintLaserTrail(context, points, width, options.color, options.opacity);
    }
    context.restore();
    return;
  }

  const slice = sliceLaserTrailByAge(points, options.nowMs!, options.holdMs!, options.fadeMs!);
  if (!slice) {
    context.restore();
    return;
  }

  const { points: kept, tipFade } = slice;
  if (kept.length === 1) {
    // Last sample: shrink the tip point as it exits (no body left).
    paintLaserDot(context, kept[0]!, width * tipFade, options.color, options.opacity * tipFade);
    context.restore();
    return;
  }

  paintLaserTrail(context, kept, width, options.color, options.opacity);
  context.restore();
}

/** Screen-space length of the tip triangle (older end only). Always this size. */
export function laserTipTaperLength(width: number): number {
  return Math.max(18, width * 10);
}

/**
 * Width scale along the trail: 0 at oldest tip → 1 once past the tip zone.
 * Body stays 1 (full width).
 */
export function laserTipTaperFactor(distanceFromTip: number, taperLength: number): number {
  if (taperLength <= 0) return 1;
  if (distanceFromTip >= taperLength) return 1;
  return Math.max(0, Math.min(1, distanceFromTip / taperLength));
}

/**
 * Slide the oldest tip forward along the path as it age-fades.
 * Keeps a sharp tip + fixed taper; disappearance shortens the trail instead of ghosting.
 */
export function advanceLaserTipAlongPath(
  points: readonly LaserPoint[],
  consume01: number
): LaserPoint[] {
  if (points.length < 2 || consume01 <= 0) return points.map((point) => ({ ...point }));
  const t = Math.min(1, Math.max(0, consume01));
  if (t >= 1) return points.slice(1).map((point) => ({ ...point }));
  const a = points[0]!;
  const b = points[1]!;
  const tip: LaserPoint = {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t
  };
  if (typeof a.time === "number") tip.time = a.time;
  return [tip, ...points.slice(1).map((point) => ({ ...point }))];
}

function paintLaserDot(
  context: CanvasRenderingContext2D,
  point: LaserPoint,
  width: number,
  color: string,
  alpha: number
): void {
  if (alpha <= 0.001 || width <= 0.05) return;
  context.fillStyle = color;
  context.globalAlpha = Math.min(1, alpha);
  context.beginPath();
  context.arc(point.x, point.y, Math.max(0.35, width * 0.5), 0, Math.PI * 2);
  context.fill();
}

function pathDistances(points: readonly LaserPoint[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1]!;
    const next = points[i]!;
    cum.push(cum[i - 1]! + Math.hypot(next.x - prev.x, next.y - prev.y));
  }
  return cum;
}

/** Insert points so the tip triangle has enough samples to stay sharp + smooth. */
export function densifyLaserPath(
  points: readonly LaserPoint[],
  stepPx: number
): LaserPoint[] {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const step = Math.max(1.5, stepPx);
  const out: LaserPoint[] = [];
  const push = (point: LaserPoint): void => {
    const last = out[out.length - 1];
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.2) return;
    out.push(point);
  };
  push({ ...points[0]! });
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const parts = Math.max(1, Math.ceil(dist / step));
    for (let part = 1; part <= parts; part += 1) {
      const t = part / parts;
      const point: LaserPoint = {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t
      };
      if (typeof a.time === "number" && typeof b.time === "number") {
        point.time = a.time + (b.time - a.time) * t;
      } else if (typeof b.time === "number") {
        point.time = b.time;
      } else if (typeof a.time === "number") {
        point.time = a.time;
      }
      push(point);
    }
  }
  return out;
}

function unitPerp(dx: number, dy: number): { nx: number; ny: number } {
  const len = Math.hypot(dx, dy) || 1;
  return { nx: -dy / len, ny: dx / len };
}

/** Averaged outline normal so tip→body width change doesn't crease. */
function ribbonNormal(
  points: readonly LaserPoint[],
  index: number
): { nx: number; ny: number } {
  const n = points.length;
  const cur = points[index]!;
  if (index === 0) {
    const next = points[1]!;
    return unitPerp(next.x - cur.x, next.y - cur.y);
  }
  if (index === n - 1) {
    const prev = points[n - 2]!;
    return unitPerp(cur.x - prev.x, cur.y - prev.y);
  }
  const prev = points[index - 1]!;
  const next = points[index + 1]!;
  const a = unitPerp(cur.x - prev.x, cur.y - prev.y);
  const b = unitPerp(next.x - cur.x, next.y - cur.y);
  const nx = a.nx + b.nx;
  const ny = a.ny + b.ny;
  const len = Math.hypot(nx, ny);
  if (len < 1e-6) return a;
  return { nx: nx / len, ny: ny / len };
}

/**
 * One continuous ribbon: sharp tip → fixed taper → full body (no tip/body seam).
 */
function paintLaserTrail(
  context: CanvasRenderingContext2D,
  points: readonly LaserPoint[],
  width: number,
  color: string,
  alpha: number
): void {
  if (points.length < 2 || alpha <= 0.001) return;
  const taperLen = laserTipTaperLength(width);
  const path = densifyLaserPath(points, Math.min(3.5, Math.max(1.75, width * 0.65)));
  const cum = pathDistances(path);
  const n = path.length;
  const halfW = width * 0.5;

  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < n; i += 1) {
    const point = path[i]!;
    const factor = laserTipTaperFactor(cum[i]!, taperLen);
    const half = halfW * factor;
    // Collapse the tip vertices onto the centerline → true pointed end.
    if (i === 0 || half < 0.05) {
      left.push({ x: point.x, y: point.y });
      right.push({ x: point.x, y: point.y });
      continue;
    }
    const { nx, ny } = ribbonNormal(path, i);
    left.push({ x: point.x + nx * half, y: point.y + ny * half });
    right.push({ x: point.x - nx * half, y: point.y - ny * half });
  }

  context.fillStyle = color;
  context.globalAlpha = Math.min(1, alpha);
  context.beginPath();
  context.moveTo(left[0]!.x, left[0]!.y);
  for (let i = 1; i < n; i += 1) context.lineTo(left[i]!.x, left[i]!.y);
  for (let i = n - 1; i >= 0; i -= 1) context.lineTo(right[i]!.x, right[i]!.y);
  context.closePath();
  context.fill();
}

/** Map PDF/page points through a viewport mapper for canvas paint. */
export function mapLaserPoints(
  points: readonly PdfPoint[],
  toViewport: (point: PdfPoint) => { x: number; y: number }
): LaserPoint[] {
  return points.map((point) => {
    const view = toViewport(point);
    return { x: view.x, y: view.y, time: point.time };
  });
}
