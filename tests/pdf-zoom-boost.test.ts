import { describe, expect, it, vi } from "vitest";
import {
  BOOSTED_MAX_SCALE,
  clampPdfScale,
  computeTargetScale,
  installPdfZoomBoost,
  OBSIDIAN_DEFAULT_MAX_SCALE,
  PINCH_RENDER_DELAY_MS
} from "../src/integration/PdfZoomBoost";

describe("pdf zoom boost", () => {
  it("clamps scales into the boosted range", () => {
    expect(clampPdfScale(0)).toBe(1);
    expect(clampPdfScale(0.05)).toBe(0.1);
    expect(clampPdfScale(40)).toBe(BOOSTED_MAX_SCALE);
    expect(clampPdfScale(12)).toBe(12);
  });

  it("computes step and factor targets like PDF.js", () => {
    expect(computeTargetScale(1, { steps: 1 })).toBe(1.1);
    expect(computeTargetScale(10, { scaleFactor: 1.2 })).toBe(12);
  });

  it("defers PDF.js rasterization while a touch pinch is moving", () => {
    let scale = 1;
    const updateScale = vi.fn((options: { scaleFactor?: number | null }) => {
      scale = computeTargetScale(scale, options) ?? scale;
    });
    const viewer = {
      get currentScale() {
        return scale;
      },
      set currentScale(value: number) {
        scale = value;
      },
      updateScale
    };
    const boost = installPdfZoomBoost(viewer);

    expect(boost?.zoomByScaleFactor(1.2, [120, 240])).toBe(true);
    expect(updateScale).toHaveBeenCalledWith({
      scaleFactor: 1.2,
      drawingDelay: PINCH_RENDER_DELAY_MS,
      origin: [120, 240]
    });

    boost?.destroy();
  });

  it("lifts updateScale past Obsidian's hardcoded 10x clamp", () => {
    const globals = globalThis as typeof globalThis & {
      pdfjsViewer?: { MAX_SCALE: number; AppOptions: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } };
    };
    const previous = globals.pdfjsViewer;
    const appOptions = {
      get: vi.fn(() => 16_777_216),
      set: vi.fn()
    };
    globals.pdfjsViewer = { MAX_SCALE: OBSIDIAN_DEFAULT_MAX_SCALE, AppOptions: appOptions };

    let scale = 9.5;
    const viewer = {
      get currentScale() {
        return scale;
      },
      set currentScale(value: number) {
        scale = value;
      },
      updateScale(options: { steps?: number | null; scaleFactor?: number | null }): void {
        const desired = computeTargetScale(scale, options) ?? scale;
        // Simulate Obsidian clamp at 10.
        scale = Math.min(OBSIDIAN_DEFAULT_MAX_SCALE, Math.max(0.1, desired));
      }
    };

    const boost = installPdfZoomBoost(viewer, BOOSTED_MAX_SCALE);
    expect(boost).not.toBeNull();
    expect(globals.pdfjsViewer.MAX_SCALE).toBe(BOOSTED_MAX_SCALE);
    expect(appOptions.set).toHaveBeenCalledWith("maxCanvasPixels", 64 * 1024 * 1024);

    viewer.updateScale({ steps: 5 });
    expect(scale).toBeGreaterThan(OBSIDIAN_DEFAULT_MAX_SCALE);
    expect(scale).toBeLessThanOrEqual(BOOSTED_MAX_SCALE);
    expect(boost!.maxScale()).toBe(BOOSTED_MAX_SCALE);

    boost!.destroy();
    expect(globals.pdfjsViewer!.MAX_SCALE).toBe(OBSIDIAN_DEFAULT_MAX_SCALE);
    expect(appOptions.set).toHaveBeenCalledWith("maxCanvasPixels", 16_777_216);
    if (previous) globals.pdfjsViewer = previous;
    else delete globals.pdfjsViewer;
  });
});
