import type { InkStroke, PdfPoint } from "../model";

type Point = Pick<PdfPoint, "x" | "y">;
type Interval = readonly [start: number, end: number];
interface Bounds { minX: number; minY: number; maxX: number; maxY: number; }

export interface SegmentEraserOptions {
  /** Viewport pixels per PDF unit when `size` is expressed in viewport pixels. */
  scale?: number;
  now?: () => string;
  createFragmentId?: (stroke: InkStroke, fragmentIndex: number) => string;
}

export interface SegmentEraseResult {
  /** Complete post-erase stroke set, including untouched strokes and fragments. */
  kept: InkStroke[];
  /** Original strokes changed or fully removed by the erase operation. */
  erased: InkStroke[];
  /** Replacement fragments produced from changed strokes. */
  fragments: InkStroke[];
}

const EPSILON = 1e-9;

function clampUnit(value: number): number { return Math.max(0, Math.min(1, value)); }

function intersect(a: Interval | null, b: Interval | null): Interval | null {
  if (!a || !b) return null;
  const start = Math.max(a[0], b[0]);
  const end = Math.min(a[1], b[1]);
  return end + EPSILON >= start ? [clampUnit(start), clampUnit(end)] : null;
}

/** Values of t in [0,1] for which min <= origin + delta*t <= max. */
function linearInterval(origin: number, delta: number, min: number, max: number): Interval | null {
  if (Math.abs(delta) <= EPSILON) return origin >= min - EPSILON && origin <= max + EPSILON ? [0, 1] : null;
  const first = (min - origin) / delta;
  const second = (max - origin) / delta;
  return intersect([Math.min(first, second), Math.max(first, second)], [0, 1]);
}

function circleInterval(start: Point, end: Point, center: Point, radius: number): Interval | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const fx = start.x - center.x;
  const fy = start.y - center.y;
  const a = dx * dx + dy * dy;
  const c = fx * fx + fy * fy - radius * radius;
  if (a <= EPSILON) return c <= EPSILON ? [0, 1] : null;
  const b = 2 * (fx * dx + fy * dy);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -EPSILON) return null;
  const root = Math.sqrt(Math.max(0, discriminant));
  return intersect([(-b - root) / (2 * a), (-b + root) / (2 * a)], [0, 1]);
}

/** Exact intersection interval between a line segment and a swept circular eraser capsule. */
function capsuleIntervals(strokeStart: Point, strokeEnd: Point, eraserStart: Point, eraserEnd: Point, radius: number): Interval[] {
  const ex = eraserEnd.x - eraserStart.x;
  const ey = eraserEnd.y - eraserStart.y;
  const lengthSquared = ex * ex + ey * ey;
  if (lengthSquared <= EPSILON) {
    const interval = circleInterval(strokeStart, strokeEnd, eraserStart, radius);
    return interval ? [interval] : [];
  }

  const sx = strokeEnd.x - strokeStart.x;
  const sy = strokeEnd.y - strokeStart.y;
  const fromEraserX = strokeStart.x - eraserStart.x;
  const fromEraserY = strokeStart.y - eraserStart.y;
  const projectionStart = (fromEraserX * ex + fromEraserY * ey) / lengthSquared;
  const projectionDelta = (sx * ex + sy * ey) / lengthSquared;
  const projected = linearInterval(projectionStart, projectionDelta, 0, 1);
  const crossStart = fromEraserX * ey - fromEraserY * ex;
  const crossDelta = sx * ey - sy * ex;
  const strip = linearInterval(crossStart, crossDelta, -radius * Math.sqrt(lengthSquared), radius * Math.sqrt(lengthSquared));
  const body = intersect(projected, strip);
  return [circleInterval(strokeStart, strokeEnd, eraserStart, radius), body,
    circleInterval(strokeStart, strokeEnd, eraserEnd, radius)].filter((interval): interval is Interval => interval !== null);
}

function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.map(([start, end]) => [clampUnit(start), clampUnit(end)] as Interval)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || interval[0] > previous[1] + EPSILON) merged.push([interval[0], interval[1]]);
    else previous[1] = Math.max(previous[1], interval[1]);
  }
  return merged;
}

function complement(intervals: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  let cursor = 0;
  for (const [start, end] of mergeIntervals(intervals)) {
    if (start > cursor + EPSILON) result.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < 1 - EPSILON) result.push([cursor, 1]);
  return result;
}

function interpolate(start: PdfPoint, end: PdfPoint, t: number): PdfPoint {
  const optional = (a: number | undefined, b: number | undefined): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? b ?? 0) + ((b ?? a ?? 0) - (a ?? b ?? 0)) * t;
  const tiltX = optional(start.tiltX, end.tiltX);
  const tiltY = optional(start.tiltY, end.tiltY);
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    pressure: start.pressure + (end.pressure - start.pressure) * t,
    time: start.time + (end.time - start.time) * t,
    ...(tiltX === undefined ? {} : { tiltX }),
    ...(tiltY === undefined ? {} : { tiltY })
  };
}

function samePoint(a: Point, b: Point): boolean { return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON; }

/** One gesture-wide broad phase. It can only admit extra work, never reject contact. */
function boundsOfPath(path: readonly Point[]): Bounds {
  const first = path[0]!;
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;
  for (let index = 1; index < path.length; index += 1) {
    const point = path[index]!;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

/** A segment outside the path envelope expanded by its collision radius cannot touch any capsule. */
function segmentMayTouchPath(start: Point, end: Point, pathBounds: Bounds, radius: number): boolean {
  const minX = Math.min(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxX = Math.max(start.x, end.x);
  const maxY = Math.max(start.y, end.y);
  return maxX >= pathBounds.minX - radius
    && minX <= pathBounds.maxX + radius
    && maxY >= pathBounds.minY - radius
    && minY <= pathBounds.maxY + radius;
}

function eraseStroke(stroke: InkStroke, path: readonly Point[], radius: number, pathBounds: Bounds): PdfPoint[][] | null {
  if (stroke.points.length === 0 || path.length === 0) return null;
  if (stroke.points.length === 1) {
    const touched = path.length === 1
      ? Math.hypot(stroke.points[0]!.x - path[0]!.x, stroke.points[0]!.y - path[0]!.y) <= radius
      : path.slice(1).some((end, index) => capsuleIntervals(stroke.points[0]!, stroke.points[0]!, path[index]!, end, radius).length > 0);
    return touched ? [] : null;
  }

  const fragments: PdfPoint[][] = [];
  let active: PdfPoint[] | undefined;
  let changed = false;
  for (let index = 1; index < stroke.points.length; index += 1) {
    const start = stroke.points[index - 1]!;
    const end = stroke.points[index]!;
    const erased = !segmentMayTouchPath(start, end, pathBounds, radius)
      ? []
      : path.length === 1
        ? capsuleIntervals(start, end, path[0]!, path[0]!, radius)
        : path.slice(1).flatMap((eraserEnd, pathIndex) => capsuleIntervals(start, end, path[pathIndex]!, eraserEnd, radius));
    const removed = mergeIntervals(erased).filter(([from, to]) => to - from > EPSILON);
    if (removed.length > 0) changed = true;
    const preserved = complement(removed);
    if (preserved.length === 0) { active = undefined; continue; }
    for (const [from, to] of preserved) {
      const fromPoint = interpolate(start, end, from);
      const toPoint = interpolate(start, end, to);
      if (active && from <= EPSILON && samePoint(active[active.length - 1]!, fromPoint)) active.push(toPoint);
      else { active = [fromPoint, toPoint]; fragments.push(active); }
      if (to < 1 - EPSILON) active = undefined;
    }
  }
  return changed ? fragments.map((points) => points.filter((item, index) => index === 0 || !samePoint(item, points[index - 1]!))) : null;
}

/**
 * Default eraser: remove only stroke portions touched by the swept circular path.
 * `size` is the eraser diameter; stroke thickness participates in collision.
 */
export function eraseStrokeSegments(strokes: readonly InkStroke[], path: readonly Point[], size: number, options: SegmentEraserOptions = {}): SegmentEraseResult {
  const scale = options.scale ?? 1;
  if (!Number.isFinite(size) || size <= 0) throw new RangeError("Eraser size must be positive");
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError("Coordinate scale must be positive");
  const eraserRadius = size / (2 * scale);
  const pathBounds = path.length ? boundsOfPath(path) : undefined;
  const kept: InkStroke[] = [];
  const erased: InkStroke[] = [];
  const fragments: InkStroke[] = [];
  for (const stroke of strokes) {
    const replacementPoints = pathBounds
      ? eraseStroke(stroke, path, eraserRadius + stroke.width / 2, pathBounds)
      : null;
    if (replacementPoints === null) { kept.push(stroke); continue; }
    erased.push(stroke);
    const updatedAt = options.now?.() ?? new Date().toISOString();
    replacementPoints.forEach((points, fragmentIndex) => {
      if (points.length === 0) return;
      const fragment: InkStroke = {
        ...stroke,
        id: options.createFragmentId?.(stroke, fragmentIndex) ?? (fragmentIndex === 0 ? stroke.id : `${stroke.id}~erase-${fragmentIndex}`),
        points,
        updatedAt
      };
      fragments.push(fragment);
      kept.push(fragment);
    });
  }
  return { kept, erased, fragments };
}

/**
 * Whole-stroke erasing only needs contact, not clipped fragments. Keep this
 * separate from `eraseStroke` so the hot path can stop at the first actual
 * (non-tangent) capsule overlap.
 */
function strokeIntersectsEraserPath(stroke: InkStroke, path: readonly Point[], radius: number, pathBounds: Bounds): boolean {
  if (stroke.points.length === 0 || path.length === 0) return false;
  if (stroke.points.length === 1) {
    const point = stroke.points[0]!;
    if (path.length === 1) return Math.hypot(point.x - path[0]!.x, point.y - path[0]!.y) <= radius;
    return path.slice(1).some((eraserEnd, index) =>
      capsuleIntervals(point, point, path[index]!, eraserEnd, radius).length > 0
    );
  }

  for (let strokeIndex = 1; strokeIndex < stroke.points.length; strokeIndex += 1) {
    const start = stroke.points[strokeIndex - 1]!;
    const end = stroke.points[strokeIndex]!;
    if (!segmentMayTouchPath(start, end, pathBounds, radius)) continue;
    const intersects = (eraserStart: Point, eraserEnd: Point): boolean =>
      mergeIntervals(capsuleIntervals(start, end, eraserStart, eraserEnd, radius))
        .some(([from, to]) => to - from > EPSILON);
    if (path.length === 1) {
      if (intersects(path[0]!, path[0]!)) return true;
      continue;
    }
    for (let pathIndex = 1; pathIndex < path.length; pathIndex += 1) {
      if (intersects(path[pathIndex - 1]!, path[pathIndex]!)) return true;
    }
  }
  return false;
}

/** Whole-stroke eraser: any contact removes the complete original stroke. */
export function eraseWholeStrokes(strokes: readonly InkStroke[], path: readonly Point[], size: number, options: SegmentEraserOptions = {}): SegmentEraseResult {
  const scale = options.scale ?? 1;
  if (!Number.isFinite(size) || size <= 0) throw new RangeError("Eraser size must be positive");
  if (!Number.isFinite(scale) || scale <= 0) throw new RangeError("Coordinate scale must be positive");
  const eraserRadius = size / (2 * scale);
  const pathBounds = path.length ? boundsOfPath(path) : undefined;
  const erased = pathBounds
    ? strokes.filter((stroke) => strokeIntersectsEraserPath(stroke, path, eraserRadius + stroke.width / 2, pathBounds))
    : [];
  const erasedIds = new Set(erased.map((stroke) => stroke.id));
  return {
    kept: strokes.filter((stroke) => !erasedIds.has(stroke.id)),
    erased,
    fragments: []
  };
}

/** Default eraser entry point. */
export const eraseStrokes = eraseStrokeSegments;
