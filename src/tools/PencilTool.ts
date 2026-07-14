import type { DrawingToolPreferences, PdfPoint } from "../model";

export interface PencilSample { width: number; opacity: number; textureStrength: number }

/** Viewport (or PDF-space) sample with pressure/tilt for graphite stamp placement. */
export interface GraphitePoint {
  x: number;
  y: number;
  pressure: number;
  tiltX?: number | undefined;
  tiltY?: number | undefined;
}

export interface GraphiteStrokeOptions {
  color: string;
  /** Base stroke width in the same space as `points` (viewport px or PDF points). */
  width: number;
  opacity: number;
  textureStrength: number;
  pressureSensitivity: boolean;
  tiltSensitivity: boolean;
  thinning: number;
  /** Stable seed so redraws match (stroke id hash, etc.). */
  seed?: number;
  /**
   * `full` — final paint / export.
   * `draft` — live pointer preview (cheaper; still graphite, not pen).
   */
  quality?: "full" | "draft";
}

/**
 * Elliptical graphite fleck.
 * `rx` / `ry` in stroke space; `rotation` is world heading (radians).
 */
export interface GraphiteMark {
  x: number;
  y: number;
  rx: number;
  ry: number;
  rotation: number;
  opacity: number;
  /** Soft spine samples approximate the continuous ribbon for PDF export. */
  kind: "grain" | "fleck" | "spine";
}

export function pencilSample(preferences: DrawingToolPreferences, point: PdfPoint): PencilSample {
  const pressure = preferences.pressureSensitivity ? Math.max(0.1, point.pressure) : 0.5;
  const tilt = preferences.tiltSensitivity
    ? Math.min(1, (Math.abs(point.tiltX ?? 0) + Math.abs(point.tiltY ?? 0)) / 120)
    : 0;
  const thinned = 1 - preferences.thinning * (1 - pressure);
  return {
    width: preferences.width * (0.75 + pressure * 0.7 + tilt * 0.35) * thinned,
    opacity: Math.min(1, preferences.opacity * (0.48 + pressure * 0.48)),
    textureStrength: preferences.textureStrength
  };
}

/** Deterministic unit noise in [0, 1). */
export function graphiteNoise(seed: number, index: number, channel = 0): number {
  const n = Math.imul(seed ^ (index * 374761393) ^ (channel * 668265263), 1103515245);
  return ((n >>> 0) % 10_000) / 10_000;
}

function sampleAt(
  options: GraphiteStrokeOptions,
  point: GraphitePoint
): { width: number; opacity: number; tilt: number } {
  const prefs: DrawingToolPreferences = {
    color: options.color,
    width: options.width,
    opacity: options.opacity,
    pressureSensitivity: options.pressureSensitivity,
    stabilization: "off",
    thinning: options.thinning,
    textureStrength: options.textureStrength,
    tiltSensitivity: options.tiltSensitivity,
    simulateMousePressure: true
  };
  const sample = pencilSample(prefs, {
    x: point.x,
    y: point.y,
    pressure: point.pressure,
    ...(point.tiltX !== undefined ? { tiltX: point.tiltX } : {}),
    ...(point.tiltY !== undefined ? { tiltY: point.tiltY } : {}),
    time: 0
  });
  const tilt = options.tiltSensitivity
    ? Math.min(1, (Math.abs(point.tiltX ?? 0) + Math.abs(point.tiltY ?? 0)) / 120)
    : 0;
  return { width: sample.width, opacity: sample.opacity, tilt };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Along-path stamp pitch. Scales with tip width so displayScale zoom does not
 * multiply ellipse count (viewport width = pdfWidth × scale).
 */
export function graphiteSpacing(width: number, texture: number, quality: "full" | "draft"): number {
  const t = clamp01(texture);
  const draftBoost = quality === "draft" ? 1.55 : 1;
  // ~0.2 tip diameters between stamps — looks like grit, stays O(1) under zoom-in.
  const pitch = Math.max(1.15, width * (0.18 + (1 - t) * 0.1));
  return pitch * draftBoost;
}

/**
 * Flecks per sample. Almost flat vs tip half-width — zoom-in must not add grains.
 */
export function graphiteGrainCount(half: number, texture: number, quality: "full" | "draft"): number {
  const t = clamp01(texture);
  const acrossFill = Math.min(2, Math.floor(half / 6));
  const base = 2 + Math.floor(t * 2) + acrossFill;
  const draftScale = quality === "draft" ? 2 : 1;
  return Math.max(2, Math.round(base / draftScale));
}

/** Visual fleck size — grows slowly with tip width, never giant discs. */
export function graphiteGrainSize(half: number, noise: number, texture: number): { rx: number; ry: number } {
  const t = clamp01(texture);
  // ~0.35–1.35 px major for typical pens; scales gently with half.
  const major = Math.max(0.32, Math.min(1.35, 0.28 + half * (0.045 + t * 0.015) + noise * 0.28));
  // Paper tooth is short and skinny; higher texture → more needle-like.
  const aspect = 2.0 + noise * (1.0 + t * 1.1);
  const rx = Math.min(3.2, major * aspect);
  return {
    rx,
    ry: Math.max(0.2, Math.min(major * 0.85, rx / (aspect * (0.9 + t * 0.2))))
  };
}

/**
 * Paper-tooth graphite:
 * - faint broken ribbon (not a pen tube)
 * - dense fine elliptical grit that fills tip width (screen-capped sizes)
 * - mixed fiber angle (along stroke + paper bias)
 * - ragged edges; never solid coverage
 */
export function graphiteMarks(
  points: readonly GraphitePoint[],
  options: GraphiteStrokeOptions
): GraphiteMark[] {
  const out: GraphiteMark[] = [];
  if (!points.length) return out;
  const seed = options.seed ?? 1;
  const texture = clamp01(options.textureStrength);
  const quality = options.quality ?? "full";

  const stampAt = (
    point: GraphitePoint,
    index: number,
    heading: number,
    nx: number,
    ny: number
  ) => {
    const { width, opacity, tilt } = sampleAt(options, point);
    const half = Math.max(0.75, width / 2);
    const tipWiden = 1 + tilt * 0.55;

    // Sparse soft spine for export / faint body — fades as texture rises.
    if (graphiteNoise(seed, index, 0) >= 0.35 + texture * 0.45) {
      out.push({
        x: point.x,
        y: point.y,
        rx: half * (0.7 + (1 - texture) * 0.25),
        ry: half * (0.35 + (1 - texture) * 0.3) * tipWiden,
        rotation: heading,
        opacity: Math.min(0.22, opacity * (0.12 + (1 - texture) * 0.16)),
        kind: "spine"
      });
    }

    const grains = graphiteGrainCount(half, texture, quality);
    for (let g = 0; g < grains; g += 1) {
      // Fill tip width; mild Gaussian bias to center.
      const raw = graphiteNoise(seed, index, g * 9 + 1) * 2 - 1;
      const acrossUnit = Math.sign(raw) * Math.pow(Math.abs(raw), 0.72) * tipWiden;
      const edge = Math.min(1, Math.abs(acrossUnit));
      // Porosity: skip more at margins + high texture.
      const skip = 0.08 + texture * 0.28 + edge * edge * (0.28 + texture * 0.35);
      if (graphiteNoise(seed, index, g * 9 + 2) < skip) continue;

      const along = (graphiteNoise(seed, index, g * 9 + 3) - 0.5) * half * (0.4 + texture * 0.45);
      // Rare overhang past tip for ragged edges.
      const overhang = graphiteNoise(seed, index, g * 9 + 4) < 0.12 + texture * 0.15 ? 1.12 : 1;
      const across = acrossUnit * half * overhang * (0.82 + texture * 0.2);
      const gx = point.x + nx * across - ny * along;
      const gy = point.y + ny * across + nx * along;

      const sizeNoise = graphiteNoise(seed, index, g * 9 + 5);
      const { rx, ry } = graphiteGrainSize(half, sizeNoise, texture);
      const grainA = Math.min(
        0.72,
        opacity
          * (0.32 + texture * 0.28)
          * (0.4 + graphiteNoise(seed, index, g * 9 + 6) * 0.5)
          * (1 - edge * 0.4)
      );

      // Mix stroke-aligned flakes with paper-fiber angle (~35°) so it isn’t stamped.
      const fiber = graphiteNoise(seed, index, g * 9 + 7);
      const fiberBias = fiber < 0.38 ? (fiber < 0.19 ? 1 : -1) * (0.55 + texture * 0.35) : 0;
      const rotJitter = (graphiteNoise(seed, index, g * 9 + 8) - 0.5) * (0.4 + texture * 0.55);
      out.push({
        x: gx,
        y: gy,
        rx,
        ry,
        rotation: heading + fiberBias + rotJitter,
        opacity: grainA,
        kind: "grain"
      });
    }

    if (quality === "full") {
      const flecks = 1 + Math.floor(texture * 2) + Math.min(2, Math.floor(half / 4));
      for (let f = 0; f < flecks; f += 1) {
        if (graphiteNoise(seed, index, f * 5 + 50) < 0.35 + texture * 0.22) continue;
        const acrossUnit = (graphiteNoise(seed, index, f * 5 + 51) * 2 - 1) * tipWiden;
        const along = (graphiteNoise(seed, index, f * 5 + 52) - 0.5) * half;
        const across = acrossUnit * half * (0.9 + texture * 0.15);
        const size = Math.max(0.2, Math.min(0.85, 0.18 + half * 0.025 + graphiteNoise(seed, index, f * 5 + 53) * 0.2));
        out.push({
          x: point.x + nx * across - ny * along,
          y: point.y + ny * across + nx * along,
          rx: size * (1.5 + texture * 0.8),
          ry: size * 0.55,
          rotation: heading + (graphiteNoise(seed, index, f * 5 + 54) - 0.5) * 1.4,
          opacity: Math.min(0.5, opacity * (0.18 + texture * 0.28) * (0.4 + graphiteNoise(seed, index, f * 5 + 55) * 0.5)),
          kind: "fleck"
        });
      }
    }
  };

  if (points.length === 1) {
    stampAt(points[0]!, 0, 0, 0, 1);
    return out;
  }

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segment = Math.hypot(dx, dy);
    if (segment < 1e-6) continue;

    const mid = sampleAt(options, {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      pressure: (a.pressure + b.pressure) / 2,
      tiltX: ((a.tiltX ?? 0) + (b.tiltX ?? 0)) / 2,
      tiltY: ((a.tiltY ?? 0) + (b.tiltY ?? 0)) / 2
    });
    const spacing = graphiteSpacing(mid.width, texture, quality);
    const steps = Math.max(1, Math.ceil(segment / spacing));
    const nx = -dy / segment;
    const ny = dx / segment;
    const heading = Math.atan2(dy, dx);

    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      stampAt({
        x: a.x + dx * t,
        y: a.y + dy * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
        tiltX: (a.tiltX ?? 0) + ((b.tiltX ?? 0) - (a.tiltX ?? 0)) * t,
        tiltY: (a.tiltY ?? 0) + ((b.tiltY ?? 0) - (a.tiltY ?? 0)) * t
      }, i * 97 + step, heading, nx, ny);
    }
  }
  return out;
}

/**
 * Broken haze only — graphite identity comes from grit, not a solid pen tube.
 * High texture → almost no continuous ribbon.
 */
function drawSoftRibbon(
  context: CanvasRenderingContext2D,
  points: readonly GraphitePoint[],
  options: GraphiteStrokeOptions
): void {
  if (!points.length) return;
  const texture = clamp01(options.textureStrength);
  const seed = options.seed ?? 1;
  context.save();
  context.strokeStyle = options.color;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (points.length === 1) {
    const sample = sampleAt(options, points[0]!);
    context.globalAlpha = Math.min(0.2, sample.opacity * (0.14 + (1 - texture) * 0.12));
    context.fillStyle = options.color;
    context.beginPath();
    context.arc(points[0]!.x, points[0]!.y, Math.max(0.55, sample.width * 0.32), 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  for (let i = 1; i < points.length; i += 1) {
    // Texture punches holes in the ribbon so it never reads as ink.
    if (graphiteNoise(seed, i, 90) < texture * 0.55) continue;
    const a = points[i - 1]!;
    const b = points[i]!;
    const mid = sampleAt(options, {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      pressure: (a.pressure + b.pressure) / 2,
      tiltX: ((a.tiltX ?? 0) + (b.tiltX ?? 0)) / 2,
      tiltY: ((a.tiltY ?? 0) + (b.tiltY ?? 0)) / 2
    });
    const haze = Math.min(0.14, mid.opacity * (0.08 + (1 - texture) * 0.1));
    const core = Math.min(0.18, mid.opacity * (0.1 + (1 - texture) * 0.1));
    context.globalAlpha = haze;
    context.lineWidth = Math.max(0.7, mid.width * (0.95 + mid.tilt * 0.2));
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
    if (graphiteNoise(seed, i, 91) < 0.4 + texture * 0.4) continue;
    context.globalAlpha = core;
    context.lineWidth = Math.max(0.5, mid.width * (0.55 + (1 - texture) * 0.12));
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  context.restore();
}

function fillEllipse(
  context: CanvasRenderingContext2D,
  mark: GraphiteMark
): void {
  if (typeof context.ellipse === "function") {
    context.beginPath();
    context.ellipse(mark.x, mark.y, mark.rx, mark.ry, mark.rotation, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.save();
  context.translate(mark.x, mark.y);
  context.rotate(mark.rotation);
  context.scale(mark.rx, mark.ry);
  context.beginPath();
  context.arc(0, 0, 1, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

export function drawGraphiteStroke(
  context: CanvasRenderingContext2D,
  points: readonly GraphitePoint[],
  options: GraphiteStrokeOptions
): void {
  if (!points.length) return;
  drawSoftRibbon(context, points, options);

  const marks = graphiteMarks(points, options).filter((mark) => mark.kind !== "spine");
  if (!marks.length) return;
  context.save();
  context.fillStyle = options.color;
  for (const mark of marks) {
    context.globalAlpha = mark.opacity;
    fillEllipse(context, mark);
  }
  context.restore();
}

/** Stable 32-bit seed from an id string. */
export function seedFromId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Stamp positions for vector export (PDF) — ellipse ≈ circle with mean radius. */
export function graphiteStampCircles(
  points: readonly GraphitePoint[],
  options: GraphiteStrokeOptions
): Array<{ x: number; y: number; radius: number; opacity: number }> {
  return graphiteMarks(points, options).map((mark) => ({
    x: mark.x,
    y: mark.y,
    radius: Math.max(0.22, (mark.rx + mark.ry) * 0.5),
    opacity: mark.opacity
  }));
}
