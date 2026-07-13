import type { InkStroke, PdfPoint, SelectionMode } from "../model";
import { segmentsIntersect, strokeBounds, type Bounds } from "../ink/StrokeHitTesting";

export type Point = Pick<PdfPoint, "x" | "y">;
export type SelectionShape =
  | { type: "freeform"; points: Point[] }
  | { type: "rectangle"; bounds: Bounds }
  | { type: "ellipse"; bounds: Bounds };

const inBounds = (point: Point, bounds: Bounds) => point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!; const b = polygon[j]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function pointInEllipse(point: Point, bounds: Bounds): boolean {
  const rx = (bounds.maxX - bounds.minX) / 2;
  const ry = (bounds.maxY - bounds.minY) / 2;
  if (rx <= 0 || ry <= 0) return false;
  const cx = bounds.minX + rx; const cy = bounds.minY + ry;
  return ((point.x - cx) / rx) ** 2 + ((point.y - cy) / ry) ** 2 <= 1;
}

function contains(shape: SelectionShape, point: Point): boolean {
  if (shape.type === "freeform") return pointInPolygon(point, shape.points);
  if (shape.type === "ellipse") return pointInEllipse(point, shape.bounds);
  return inBounds(point, shape.bounds);
}

function boundarySegments(shape: SelectionShape, resolution = 32): Array<[Point, Point]> {
  let points: Point[];
  if (shape.type === "freeform") points = shape.points;
  else if (shape.type === "rectangle") {
    const b = shape.bounds;
    points = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
  } else {
    const b = shape.bounds; const rx = (b.maxX - b.minX) / 2; const ry = (b.maxY - b.minY) / 2;
    const cx = b.minX + rx; const cy = b.minY + ry;
    points = Array.from({ length: resolution }, (_, i) => ({ x: cx + Math.cos(i * Math.PI * 2 / resolution) * rx, y: cy + Math.sin(i * Math.PI * 2 / resolution) * ry }));
  }
  return points.map((point, index) => [point, points[(index + 1) % points.length]!] as [Point, Point]);
}

export function selectStrokes(strokes: readonly InkStroke[], shape: SelectionShape, mode: SelectionMode): InkStroke[] {
  const edges = boundarySegments(shape);
  return strokes.filter((stroke) => {
    if (stroke.points.length === 0) return false;
    if (mode === "enclosed") return stroke.points.every((point) => contains(shape, point));
    if (stroke.points.some((point) => contains(shape, point))) return true;
    for (let i = 1; i < stroke.points.length; i += 1) {
      if (edges.some(([a, b]) => segmentsIntersect(stroke.points[i - 1]!, stroke.points[i]!, a, b))) return true;
    }
    return false;
  });
}

export function shapeBounds(shape: SelectionShape): Bounds {
  if (shape.type !== "freeform") return shape.bounds;
  const fake = { width: 0, points: shape.points } as InkStroke;
  return strokeBounds(fake);
}

