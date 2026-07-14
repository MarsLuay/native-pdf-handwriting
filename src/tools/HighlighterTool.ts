import type { DrawingToolPreferences, PdfPoint } from "../model";

export interface HighlighterPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface HighlighterStrokeOptions {
  color: string;
  /** Base stroke width in the same space as `points`. */
  width: number;
  opacity: number;
  pressureSensitivity: boolean;
  thinning: number;
}

export function highlighterSampleWidth(
  preferences: DrawingToolPreferences,
  point: PdfPoint
): number {
  const pressure = preferences.pressureSensitivity ? Math.max(0.35, point.pressure) : 1;
  const thinned = 1 - preferences.thinning * (1 - pressure);
  return Math.max(2, preferences.width * thinned);
}

function widthAt(options: HighlighterStrokeOptions, point: HighlighterPoint): number {
  return highlighterSampleWidth(
    {
      color: options.color,
      width: options.width,
      opacity: options.opacity,
      pressureSensitivity: options.pressureSensitivity,
      stabilization: "off",
      thinning: options.thinning,
      textureStrength: 0,
      tiltSensitivity: false,
      simulateMousePressure: false
    },
    { x: point.x, y: point.y, pressure: point.pressure, time: 0 }
  );
}

interface Vec2 {
  x: number;
  y: number;
}

function tangentAt(points: readonly HighlighterPoint[], index: number): Vec2 {
  const point = points[index]!;
  const prev = points[index - 1] ?? point;
  const next = points[index + 1] ?? point;
  let dx = next.x - prev.x;
  let dy = next.y - prev.y;
  let length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    dx = point.x - prev.x;
    dy = point.y - prev.y;
    length = Math.hypot(dx, dy);
  }
  if (length < 1e-6) {
    dx = next.x - point.x;
    dy = next.y - point.y;
    length = Math.hypot(dx, dy);
  }
  if (length < 1e-6) return { x: 1, y: 0 };
  return { x: dx / length, y: dy / length };
}

/** Left/right edge samples for a continuous ribbon (no overlapping stamps). */
export function highlighterRibbonEdges(
  points: readonly HighlighterPoint[],
  options: HighlighterStrokeOptions
): { left: Vec2[]; right: Vec2[]; widths: number[] } {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  const widths: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i]!;
    const tangent = tangentAt(points, i);
    const half = Math.max(1, widthAt(options, point) / 2);
    // Perpendicular to heading — flat marker tip across the stroke.
    const nx = -tangent.y;
    const ny = tangent.x;
    left.push({ x: point.x + nx * half, y: point.y + ny * half });
    right.push({ x: point.x - nx * half, y: point.y - ny * half });
    widths.push(half * 2);
  }
  return { left, right, widths };
}

function strokeSmoothCenterline(
  context: CanvasRenderingContext2D,
  points: readonly HighlighterPoint[],
  lineWidth: number
): void {
  context.lineWidth = lineWidth;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  const first = points[0]!;
  context.moveTo(first.x, first.y);
  if (points.length === 2) {
    context.lineTo(points[1]!.x, points[1]!.y);
  } else {
    for (let i = 1; i < points.length - 1; i += 1) {
      const current = points[i]!;
      const next = points[i + 1]!;
      context.quadraticCurveTo(
        current.x,
        current.y,
        (current.x + next.x) / 2,
        (current.y + next.y) / 2
      );
    }
    const last = points[points.length - 1]!;
    context.lineTo(last.x, last.y);
  }
  context.stroke();
}

/**
 * Flat marker ribbon drawn as one continuous translucent body.
 * Single fill/stroke pass so alpha stays even (stamps stacked dark blotches).
 */
export function drawHighlighterStroke(
  context: CanvasRenderingContext2D,
  points: readonly HighlighterPoint[],
  options: HighlighterStrokeOptions
): void {
  if (!points.length) return;
  context.save();
  context.globalAlpha = options.opacity;
  context.fillStyle = options.color;
  context.strokeStyle = options.color;

  if (points.length === 1) {
    const radius = widthAt(options, points[0]!) / 2;
    context.beginPath();
    context.arc(points[0]!.x, points[0]!.y, radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  const { left, right, widths } = highlighterRibbonEdges(points, options);
  const minW = Math.min(...widths);
  const maxW = Math.max(...widths);
  // Near-constant tip width → smooth centerline stroke (best continuity).
  if (maxW - minW <= Math.max(0.75, minW * 0.12)) {
    strokeSmoothCenterline(context, points, (minW + maxW) / 2);
    context.restore();
    return;
  }

  // Variable width: one filled ribbon + round tips in the same path (single alpha).
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const startTangent = tangentAt(points, 0);
  const endTangent = tangentAt(points, points.length - 1);
  context.beginPath();
  context.moveTo(left[0]!.x, left[0]!.y);
  for (let i = 1; i < left.length; i += 1) {
    context.lineTo(left[i]!.x, left[i]!.y);
  }
  appendRoundCap(
    context,
    end,
    widths[widths.length - 1]! / 2,
    left[left.length - 1]!,
    right[right.length - 1]!,
    endTangent
  );
  for (let i = right.length - 2; i >= 0; i -= 1) {
    context.lineTo(right[i]!.x, right[i]!.y);
  }
  appendRoundCap(
    context,
    start,
    widths[0]! / 2,
    right[0]!,
    left[0]!,
    { x: -startTangent.x, y: -startTangent.y }
  );
  context.closePath();
  context.fill();

  context.restore();
}

function angleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  while (delta > Math.PI) delta -= Math.PI * 2;
  return Math.abs(delta);
}

function goingThrough(from: number, to: number, via: number): boolean {
  return angleDelta(from, via) + angleDelta(via, to) <= angleDelta(from, to) + 1e-6;
}

/** Arc from `from` → `to` that passes near the outward `tangent` tip. */
function appendRoundCap(
  context: CanvasRenderingContext2D,
  center: Vec2,
  half: number,
  from: Vec2,
  to: Vec2,
  outward: Vec2
): void {
  const startAngle = Math.atan2(from.y - center.y, from.x - center.x);
  const endAngle = Math.atan2(to.y - center.y, to.x - center.x);
  const midAngle = Math.atan2(outward.y, outward.x);
  const anticlockwise = !goingThrough(startAngle, endAngle, midAngle);
  context.arc(center.x, center.y, half, startAngle, endAngle, anticlockwise);
}

/** Segment thicknesses for PDF export (same width model as canvas). */
export function highlighterSegmentWidths(
  points: readonly HighlighterPoint[],
  options: HighlighterStrokeOptions
): Array<{ start: HighlighterPoint; end: HighlighterPoint; thickness: number }> {
  const out: Array<{ start: HighlighterPoint; end: HighlighterPoint; thickness: number }> = [];
  if (points.length < 2) return out;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    out.push({ start: a, end: b, thickness: (widthAt(options, a) + widthAt(options, b)) / 2 });
  }
  return out;
}
