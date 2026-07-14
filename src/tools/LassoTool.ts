import type { InkStroke, PdfPoint } from "../model";
import { strokeBounds, type Bounds } from "../ink/StrokeHitTesting";

const OVERLAY_MARGIN_PX = 4;
/** Strokes whose span is at most this many stroke-widths count as tap/dot marks. */
const SHORT_STROKE_SPAN_WIDTHS = 4;

export type Point = Pick<PdfPoint, "x" | "y">;
export type SelectionShape =
  | { type: "freeform"; points: Point[] }
  | { type: "rectangle"; bounds: Bounds };

const inBounds = (point: Point, bounds: Bounds) => point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!; const b = polygon[j]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function shapeContainsPoint(shape: SelectionShape, point: Point): boolean {
  if (shape.type === "freeform") return pointInPolygon(point, shape.points);
  return inBounds(point, shape.bounds);
}

export function translateShape(shape: SelectionShape, dx: number, dy: number): SelectionShape {
  if (shape.type === "freeform") {
    return { type: "freeform", points: shape.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
  }
  const bounds = shape.bounds;
  return {
    type: shape.type,
    bounds: {
      minX: bounds.minX + dx,
      minY: bounds.minY + dy,
      maxX: bounds.maxX + dx,
      maxY: bounds.maxY + dy
    }
  };
}

function contains(shape: SelectionShape, point: Point): boolean {
  return shapeContainsPoint(shape, point);
}

function strokeBoundsCenter(stroke: InkStroke): Point {
  const bounds = strokeBounds(stroke);
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
}

function strokeMatchesSelection(stroke: InkStroke, shape: SelectionShape): boolean {
  if (!stroke.points.length) return false;
  if (contains(shape, strokeBoundsCenter(stroke))) return true;
  const insideCount = stroke.points.filter((point) => contains(shape, point)).length;
  if (insideCount === 0) return false;
  if (stroke.points.length === 1) return true;
  const bounds = strokeBounds(stroke);
  const span = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  // i/j dots and tap marks: one point inside the lasso is enough
  if (span <= Math.max(stroke.width * SHORT_STROKE_SPAN_WIDTHS, 8)) return true;
  return insideCount >= 2;
}

export function selectionShapeArea(shape: SelectionShape): number {
  if (shape.type === "freeform") {
    const bounds = shapeBounds(shape);
    return Math.max(0, bounds.maxX - bounds.minX) * Math.max(0, bounds.maxY - bounds.minY);
  }
  const bounds = shape.bounds;
  return Math.max(0, bounds.maxX - bounds.minX) * Math.max(0, bounds.maxY - bounds.minY);
}

export function selectStrokes(strokes: readonly InkStroke[], shape: SelectionShape): InkStroke[] {
  return strokes.filter((stroke) => strokeMatchesSelection(stroke, shape));
}

/** Keep ink visible on the overlay. Do not gate on live pageWidth/Height — those can drift from pinned drawing metrics and hide real strokes. */
export function strokeDiscernibleInOverlay(
  stroke: InkStroke,
  _pageWidth: number,
  _pageHeight: number,
  _scale: number,
  overlayWidth: number,
  overlayHeight: number,
  toViewport: (point: Point) => Point,
  _minScreenPx?: number
): boolean {
  if (!stroke.points.length) return false;
  if (!(overlayWidth > 0) || !(overlayHeight > 0)) return false;
  for (const point of stroke.points) {
    const view = toViewport(point);
    if (view.x >= -OVERLAY_MARGIN_PX && view.x <= overlayWidth + OVERLAY_MARGIN_PX
      && view.y >= -OVERLAY_MARGIN_PX && view.y <= overlayHeight + OVERLAY_MARGIN_PX) {
      return true;
    }
  }
  return false;
}

export function filterSelectableStrokes(
  strokes: readonly InkStroke[],
  pageWidth: number,
  pageHeight: number,
  scale: number,
  overlayWidth: number,
  overlayHeight: number,
  toViewport: (point: Point) => Point
): InkStroke[] {
  return strokes.filter((stroke) => strokeDiscernibleInOverlay(
    stroke,
    pageWidth,
    pageHeight,
    scale,
    overlayWidth,
    overlayHeight,
    toViewport
  ));
}

export function shapeBounds(shape: SelectionShape): Bounds {
  if (shape.type !== "freeform") return shape.bounds;
  const fake = { width: 0, points: shape.points } as InkStroke;
  return strokeBounds(fake);
}

export function boundingShapeFromStrokes(strokes: readonly InkStroke[]): SelectionShape | null {
  if (!strokes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    const bounds = strokeBounds(stroke);
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }
  if (!Number.isFinite(minX)) return null;
  return { type: "rectangle", bounds: { minX, minY, maxX, maxY } };
}

