import type { DrawingToolPreferences, PdfPoint } from "../model";

export interface PenPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface PenStrokeOptions {
  color: string;
  /** Base stroke width in the same space as `points`. */
  width: number;
  opacity: number;
  pressureSensitivity: boolean;
  thinning: number;
}

export function penSampleWidth(preferences: DrawingToolPreferences, point: PdfPoint): number {
  const pressure = preferences.pressureSensitivity ? Math.max(0.15, point.pressure) : 0.5;
  return Math.max(0.35, preferences.width * (1 - preferences.thinning + preferences.thinning * pressure * 2));
}

function widthAt(options: PenStrokeOptions, point: PenPoint): number {
  return penSampleWidth(
    {
      color: options.color,
      width: options.width,
      opacity: options.opacity,
      pressureSensitivity: options.pressureSensitivity,
      stabilization: "off",
      thinning: options.thinning,
      textureStrength: 0,
      tiltSensitivity: false,
      simulateMousePressure: true
    },
    { x: point.x, y: point.y, pressure: point.pressure, time: 0 }
  );
}

/** Variable-width pen: round stamps / segments so Thinning + Pressure affect the stroke. */
export function drawPenStroke(
  context: CanvasRenderingContext2D,
  points: readonly PenPoint[],
  options: PenStrokeOptions
): void {
  if (!points.length) return;
  context.save();
  context.globalAlpha = options.opacity;
  context.fillStyle = options.color;
  context.strokeStyle = options.color;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (points.length === 1) {
    const radius = widthAt(options, points[0]!) / 2;
    context.beginPath();
    context.arc(points[0]!.x, points[0]!.y, radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segment = Math.hypot(dx, dy);
    const wa = widthAt(options, a);
    const wb = widthAt(options, b);
    if (segment < 1e-6) {
      context.beginPath();
      context.arc(a.x, a.y, wa / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    const avg = (wa + wb) / 2;
    const steps = Math.max(1, Math.ceil(segment / Math.max(0.4, avg * 0.35)));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      const w = wa + (wb - wa) * t;
      context.beginPath();
      context.arc(x, y, Math.max(0.2, w / 2), 0, Math.PI * 2);
      context.fill();
    }
  }

  context.restore();
}

/** Segment thicknesses for PDF export (same width model as canvas). */
export function penSegmentWidths(
  points: readonly PenPoint[],
  options: PenStrokeOptions
): Array<{ start: PenPoint; end: PenPoint; thickness: number }> {
  const out: Array<{ start: PenPoint; end: PenPoint; thickness: number }> = [];
  if (points.length < 2) return out;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    out.push({ start: a, end: b, thickness: (widthAt(options, a) + widthAt(options, b)) / 2 });
  }
  return out;
}
