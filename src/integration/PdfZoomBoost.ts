import type { PdfJsViewerLike } from "./PdfViewerCompatibility";

/** Obsidian PDF.js clamps pinch/button zoom at literal 10× in updateScale. */
export const OBSIDIAN_DEFAULT_MAX_SCALE = 10;
/** Allow denser writing; still below extreme canvas blowups. */
export const BOOSTED_MAX_SCALE = 25;
const MIN_SCALE = 0.1;
/** Default Obsidian maxCanvasPixels is 16MP — letter @ ~10× already exceeds it. */
const BOOSTED_MAX_CANVAS_PIXELS = 64 * 1024 * 1024;
/** Keep the current PDF.js bitmap visible while a touch pinch is still moving. */
export const PINCH_RENDER_DELAY_MS = 150;

export type UpdateScaleOptions = {
  drawingDelay?: number;
  scaleFactor?: number | null;
  steps?: number | null;
  origin?: unknown;
};

export type ZoomablePdfViewer = PdfJsViewerLike & {
  updateScale?(options: UpdateScaleOptions): void;
  currentScale?: number;
};

type AppOptionsLike = {
  get?(name: string): unknown;
  set?(name: string, value: unknown): void;
};

type PdfjsViewerGlobals = {
  MAX_SCALE?: number;
  MIN_SCALE?: number;
  AppOptions?: AppOptionsLike;
};

export interface PdfZoomBoostHandle {
  setScale(scale: number): boolean;
  setScaleValue(value: string | number): boolean;
  zoomBySteps(steps: number): boolean;
  zoomByScaleFactor(factor: number, origin?: [number, number]): boolean;
  maxScale(): number;
  destroy(): void;
}

export function clampPdfScale(scale: number, maxScale = BOOSTED_MAX_SCALE): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(maxScale, Math.max(MIN_SCALE, scale));
}

function pdfjsGlobals(): PdfjsViewerGlobals | undefined {
  const root = window as typeof window & { pdfjsViewer?: PdfjsViewerGlobals };
  return root.pdfjsViewer;
}

export function computeTargetScale(current: number, options: UpdateScaleOptions): number | null {
  const factor = options.scaleFactor ?? null;
  const steps = options.steps ?? null;
  if (factor != null && factor > 0 && factor !== 1) {
    return Math.round(current * factor * 100) / 100;
  }
  if (steps) {
    const stepFactor = steps > 0 ? 1.1 : 1 / 1.1;
    const rounder = steps > 0 ? Math.ceil : Math.floor;
    let next = current;
    let remaining = Math.abs(steps);
    do {
      next = rounder(10 * Number((next * stepFactor).toFixed(2))) / 10;
    } while (--remaining > 0);
    return next;
  }
  return null;
}

/**
 * Raises Obsidian's effective PDF zoom ceiling past the hardcoded 10× clamp
 * and increases maxCanvasPixels so high zoom can still rasterize pages.
 */
export function installPdfZoomBoost(
  viewer: PdfJsViewerLike | undefined,
  maxScale = BOOSTED_MAX_SCALE
): PdfZoomBoostHandle | null {
  if (!viewer) return null;
  const zoomable = viewer as ZoomablePdfViewer;

  const globals = pdfjsGlobals();
  const previousMax = globals?.MAX_SCALE;
  const appOptions = globals?.AppOptions;
  const previousCanvasPixels = typeof appOptions?.get === "function"
    ? appOptions.get("maxCanvasPixels")
    : undefined;
  if (globals && typeof globals.MAX_SCALE === "number") globals.MAX_SCALE = maxScale;
  if (typeof appOptions?.set === "function") {
    appOptions.set("maxCanvasPixels", BOOSTED_MAX_CANVAS_PIXELS);
  }

  const originalUpdateScale = typeof zoomable.updateScale === "function"
    ? zoomable.updateScale.bind(zoomable)
    : null;

  if (originalUpdateScale) {
    zoomable.updateScale = (options: UpdateScaleOptions): void => {
      const before = Number(zoomable.currentScale) || 1;
      originalUpdateScale(options);
      const after = Number(zoomable.currentScale) || before;
      const desired = computeTargetScale(before, options);
      if (desired == null) return;
      const capped = clampPdfScale(desired, maxScale);
      // Obsidian clamped at 10 — apply the remaining zoom via currentScale (no clamp).
      if (Math.abs(capped - after) > 0.01) {
        zoomable.currentScale = capped;
      }
    };
  }

  const setScale = (scale: number): boolean => {
    const capped = clampPdfScale(scale, maxScale);
    try {
      zoomable.currentScale = capped;
      return true;
    } catch {
      return false;
    }
  };

  return {
    setScale,
    setScaleValue(value: string | number): boolean {
      if (typeof value === "number") return setScale(value);
      try {
        zoomable.currentScaleValue = value;
        return true;
      } catch {
        return false;
      }
    },
    zoomBySteps(steps: number): boolean {
      const before = Number(zoomable.currentScale) || 1;
      if (originalUpdateScale) {
        zoomable.updateScale?.({ steps, drawingDelay: 400 });
        return true;
      }
      const desired = computeTargetScale(before, { steps });
      return desired != null ? setScale(desired) : false;
    },
    zoomByScaleFactor(factor: number, origin?: [number, number]): boolean {
      if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 0.001) return false;
      if (originalUpdateScale) {
        zoomable.updateScale?.({ scaleFactor: factor, drawingDelay: PINCH_RENDER_DELAY_MS, origin });
        return true;
      }
      const desired = computeTargetScale(Number(zoomable.currentScale) || 1, { scaleFactor: factor });
      return desired != null ? setScale(desired) : false;
    },
    maxScale: () => maxScale,
    destroy(): void {
      if (originalUpdateScale) zoomable.updateScale = originalUpdateScale;
      else delete zoomable.updateScale;
      if (globals && previousMax !== undefined) globals.MAX_SCALE = previousMax;
      if (typeof appOptions?.set === "function" && previousCanvasPixels !== undefined) {
        appOptions.set("maxCanvasPixels", previousCanvasPixels);
      }
    }
  };
}
