import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import {
  drawGraphiteStroke,
  graphiteGrainSize,
  graphiteMarks,
  graphiteNoise,
  graphiteSpacing,
  graphiteStampCircles,
  pencilSample,
  seedFromId
} from "../src/tools/PencilTool";

const pencil = DEFAULT_SETTINGS.toolPreferences.pencil;

describe("pencil graphite approximation", () => {
  it("widens and darkens with pressure when sensitivity is on", () => {
    const light = pencilSample(pencil, { x: 0, y: 0, pressure: 0.2, time: 0 });
    const heavy = pencilSample(pencil, { x: 0, y: 0, pressure: 0.95, time: 0 });
    expect(heavy.width).toBeGreaterThan(light.width);
    expect(heavy.opacity).toBeGreaterThan(light.opacity);
    expect(light.textureStrength).toBe(pencil.textureStrength);
  });

  it("uses deterministic grain noise for stable redraws", () => {
    expect(graphiteNoise(42, 3, 1)).toBe(graphiteNoise(42, 3, 1));
    expect(graphiteNoise(42, 3, 1)).not.toBe(graphiteNoise(42, 4, 1));
    expect(seedFromId("a")).not.toBe(seedFromId("b"));
  });

  it("keeps spacing proportional to tip so zoom-in does not multiply stamps", () => {
    expect(graphiteSpacing(4, 0.45, "full")).toBeLessThan(2);
    expect(graphiteSpacing(28, 0.45, "full")).toBeGreaterThan(graphiteSpacing(4, 0.45, "full") * 3);
    expect(graphiteSpacing(56, 0.45, "full")).toBeGreaterThan(graphiteSpacing(28, 0.45, "full") * 1.5);
    const size = graphiteGrainSize(14, 0.5, 0.45);
    expect(size.rx).toBeGreaterThan(size.ry * 1.4);
    expect(size.rx).toBeLessThan(4);
  });

  it("emits elongated grit with readable alpha, not solid pen cover", () => {
    const marks = graphiteMarks(
      [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 40, y: 0, pressure: 0.5 }
      ],
      {
        color: "#4b5563",
        width: 3.5 * 0.65,
        opacity: 0.65,
        textureStrength: 0.45,
        pressureSensitivity: true,
        tiltSensitivity: true,
        thinning: 0.2,
        seed: 7
      }
    );
    const grains = marks.filter((mark) => mark.kind === "grain");
    expect(grains.length).toBeGreaterThan(8);
    const elongated = grains.filter((mark) => mark.rx > mark.ry * 1.2);
    expect(elongated.length).toBeGreaterThan(grains.length * 0.5);
    const medianA = [...grains.map((s) => s.opacity)].sort((a, b) => a - b)[Math.floor(grains.length / 2)]!;
    expect(medianA).toBeGreaterThan(0.06);
    expect(medianA).toBeLessThan(0.8);
    const again = graphiteMarks(
      [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 40, y: 0, pressure: 0.5 }
      ],
      {
        color: "#4b5563",
        width: 3.5 * 0.65,
        opacity: 0.65,
        textureStrength: 0.45,
        pressureSensitivity: true,
        tiltSensitivity: true,
        thinning: 0.2,
        seed: 7
      }
    );
    expect(again).toEqual(marks);
  });

  it("keeps thick / zoom-scaled tips under a budget (no ellipse carpet)", () => {
    const points = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 80, y: 0, pressure: 0.5 }
    ];
    const thin = graphiteMarks(points, {
      color: "#111",
      width: 3,
      opacity: 0.7,
      textureStrength: 0.55,
      pressureSensitivity: false,
      tiltSensitivity: false,
      thinning: 0,
      seed: 1
    });
    const thick = graphiteMarks(points, {
      color: "#111",
      width: 24,
      opacity: 0.7,
      textureStrength: 0.55,
      pressureSensitivity: false,
      tiltSensitivity: false,
      thinning: 0,
      seed: 1
    });
    const zoomed = graphiteMarks(points, {
      color: "#111",
      width: 7 * 8,
      opacity: 0.7,
      textureStrength: 0.45,
      pressureSensitivity: false,
      tiltSensitivity: false,
      thinning: 0,
      seed: 1
    });
    const normal = graphiteMarks(points, {
      color: "#111",
      width: 7,
      opacity: 0.7,
      textureStrength: 0.45,
      pressureSensitivity: false,
      tiltSensitivity: false,
      thinning: 0,
      seed: 1
    });
    expect(Math.max(...thick.filter((m) => m.kind === "grain").map((m) => m.rx))).toBeLessThan(3.5);
    expect(thick.length).toBeLessThan(thin.length * 1.25);
    expect(zoomed.length).toBeLessThan(normal.length * 2.5);
    expect(zoomed.length).toBeLessThan(900);
  });

  it("draft quality uses fewer marks for live previews", () => {
    const points = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 120, y: 40, pressure: 0.5 }
    ];
    const base = {
      color: "#111",
      width: 16,
      opacity: 0.7,
      textureStrength: 0.85,
      pressureSensitivity: false,
      tiltSensitivity: false,
      thinning: 0,
      seed: 3
    } as const;
    const full = graphiteStampCircles(points, { ...base, quality: "full" });
    const draft = graphiteStampCircles(points, { ...base, quality: "draft" });
    expect(draft.length).toBeLessThan(full.length);
  });

  it("draws ribbon + elliptical grit onto a canvas context without throwing", () => {
    const ops: string[] = [];
    const context = {
      save: () => ops.push("save"),
      restore: () => ops.push("restore"),
      beginPath: () => ops.push("beginPath"),
      moveTo: () => ops.push("moveTo"),
      lineTo: () => ops.push("lineTo"),
      arc: () => ops.push("arc"),
      ellipse: () => ops.push("ellipse"),
      stroke: () => ops.push("stroke"),
      fill: () => ops.push("fill"),
      lineCap: "",
      lineJoin: "",
      lineWidth: 1,
      fillStyle: "",
      strokeStyle: "",
      globalAlpha: 1
    } as unknown as CanvasRenderingContext2D;
    drawGraphiteStroke(context, [
      { x: 8, y: 8, pressure: 0.3 },
      { x: 40, y: 32, pressure: 0.9 }
    ], {
      color: "#111827",
      width: 4,
      opacity: 0.7,
      textureStrength: 0.5,
      pressureSensitivity: true,
      tiltSensitivity: false,
      thinning: 0.2,
      seed: 99
    });
    expect(ops).toContain("save");
    expect(ops).toContain("ellipse");
    expect(ops).toContain("fill");
    expect(ops).toContain("restore");
  });
});
