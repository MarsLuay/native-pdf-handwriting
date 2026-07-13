import type { InkStroke, PdfPoint } from "../model";

export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export function distanceToSegment(point: Pick<PdfPoint, "x" | "y">, start: Pick<PdfPoint, "x" | "y">, end: Pick<PdfPoint, "x" | "y">): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

export function hitTestStroke(stroke: InkStroke, point: Pick<PdfPoint, "x" | "y">, radius = 0): boolean {
  const threshold = stroke.width / 2 + radius;
  if (stroke.points.length === 1) return distanceToSegment(point, stroke.points[0]!, stroke.points[0]!) <= threshold;
  for (let index = 1; index < stroke.points.length; index += 1) {
    if (distanceToSegment(point, stroke.points[index - 1]!, stroke.points[index]!) <= threshold) return true;
  }
  return false;
}

export function strokeBounds(stroke: InkStroke): Bounds {
  const half = stroke.width / 2;
  const xs = stroke.points.map((point) => point.x);
  const ys = stroke.points.map((point) => point.y);
  return { minX: Math.min(...xs) - half, minY: Math.min(...ys) - half, maxX: Math.max(...xs) + half, maxY: Math.max(...ys) + half };
}

export function segmentsIntersect(a: Pick<PdfPoint, "x" | "y">, b: Pick<PdfPoint, "x" | "y">, c: Pick<PdfPoint, "x" | "y">, d: Pick<PdfPoint, "x" | "y">): boolean {
  const cross = (p: typeof a, q: typeof a, r: typeof a) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const values = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)];
  return values[0]! * values[1]! <= 0 && values[2]! * values[3]! <= 0;
}
