import { describe, expect, it, vi } from "vitest";
import {
  advanceLaserTipAlongPath,
  densifyLaserPath,
  drawLaserStroke,
  laserSampleOpacity,
  laserTipTaperFactor,
  laserTrailStillVisible,
  sliceLaserTrailByAge
} from "../src/tools/LaserTool";

describe("LaserTool", () => {
  it("fades tip samples by age", () => {
    expect(laserSampleOpacity(0, 900, 1400)).toBe(1);
    expect(laserSampleOpacity(900, 900, 1400)).toBe(1);
    expect(laserSampleOpacity(900 + 700, 900, 1400)).toBeCloseTo(0.5, 5);
    expect(laserSampleOpacity(900 + 1400, 900, 1400)).toBe(0);
  });

  it("advances the tip along the path while age-fading (no ghost alpha)", () => {
    const points = [
      { x: 0, y: 0, time: 0 },
      { x: 10, y: 0, time: 400 },
      { x: 20, y: 0, time: 800 },
      { x: 30, y: 0, time: 1600 }
    ];
    const slice = sliceLaserTrailByAge(points, 1600, 900, 1400);
    expect(slice).not.toBeNull();
    expect(slice!.tipFade).toBeLessThan(1);
    expect(slice!.tipFade).toBeGreaterThan(0);
    // Tip moved partway from (0,0) toward (10,0)
    expect(slice!.points[0]!.x).toBeGreaterThan(0);
    expect(slice!.points[0]!.x).toBeLessThan(10);
    expect(slice!.points[0]!.y).toBe(0);
  });

  it("drops only fully expired tip points", () => {
    const points = [
      { x: 0, y: 0, time: 0 },
      { x: 10, y: 0, time: 100 },
      { x: 20, y: 0, time: 2000 },
      { x: 30, y: 0, time: 2500 }
    ];
    const slice = sliceLaserTrailByAge(points, 2500, 900, 1400);
    expect(slice).not.toBeNull();
    expect(slice!.points.map((point) => point.x)).toEqual([20, 30]);
    expect(slice!.tipFade).toBe(1);
  });

  it("reports visibility from the sliced trail", () => {
    const points = [
      { x: 0, y: 0, time: 0 },
      { x: 20, y: 0, time: 1600 }
    ];
    expect(laserTrailStillVisible(points, 1600, 900, 1400)).toBe(true);
    expect(laserTrailStillVisible(points, 1600 + 900 + 1400, 900, 1400)).toBe(false);
  });

  it("tapers only near the tip — body stays full width", () => {
    expect(laserTipTaperFactor(0, 28)).toBe(0);
    expect(laserTipTaperFactor(14, 28)).toBeCloseTo(0.5, 5);
    expect(laserTipTaperFactor(28, 28)).toBe(1);
    expect(laserTipTaperFactor(100, 28)).toBe(1);
  });

  it("slides tip geometry with advanceLaserTipAlongPath", () => {
    const advanced = advanceLaserTipAlongPath(
      [
        { x: 0, y: 0, time: 0 },
        { x: 10, y: 0, time: 1 },
        { x: 20, y: 0, time: 2 }
      ],
      0.5
    );
    expect(advanced[0]).toEqual({ x: 5, y: 0, time: 0 });
    expect(advanced).toHaveLength(3);
  });

  it("paints one continuous ribbon (tip flows into body)", () => {
    const alphas: number[] = [];
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      stroke: vi.fn(),
      closePath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      get globalAlpha() {
        return alphas.at(-1) ?? 1;
      },
      set globalAlpha(value: number) {
        alphas.push(value);
      },
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      miterLimit: 10
    } as unknown as CanvasRenderingContext2D;

    drawLaserStroke(
      context,
      [
        { x: 0, y: 0, time: 1400 },
        { x: 10, y: 0, time: 1450 },
        { x: 20, y: 0, time: 1500 },
        { x: 40, y: 0, time: 1550 },
        { x: 80, y: 0, time: 1600 }
      ],
      {
        color: "#ff0000",
        width: 2,
        opacity: 1,
        nowMs: 1600,
        holdMs: 900,
        fadeMs: 1400
      }
    );

    expect(context.fill).toHaveBeenCalledTimes(1);
    expect(context.closePath).toHaveBeenCalled();
    expect(context.stroke).not.toHaveBeenCalled();
    expect(alphas.every((alpha) => alpha === 1)).toBe(true);
    expect(context.restore).toHaveBeenCalled();
  });

  it("densifies sparse paths so the tip stays pointed", () => {
    const dense = densifyLaserPath(
      [
        { x: 0, y: 0, time: 0 },
        { x: 40, y: 0, time: 1 }
      ],
      4
    );
    expect(dense.length).toBeGreaterThan(5);
    expect(dense[0]).toEqual({ x: 0, y: 0, time: 0 });
    expect(dense.at(-1)).toEqual({ x: 40, y: 0, time: 1 });
  });
});
