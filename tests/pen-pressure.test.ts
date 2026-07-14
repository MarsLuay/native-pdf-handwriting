import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import { drawPenStroke, penSampleWidth, penSegmentWidths } from "../src/tools/PenTool";

const pen = DEFAULT_SETTINGS.toolPreferences.pen;

describe("pen pressure / thinning", () => {
  it("widens with pressure when sensitivity is on", () => {
    const light = penSampleWidth(pen, { x: 0, y: 0, pressure: 0.2, time: 0 });
    const heavy = penSampleWidth(pen, { x: 0, y: 0, pressure: 1, time: 0 });
    expect(heavy).toBeGreaterThan(light);
  });

  it("amplifies pressure effect as thinning increases", () => {
    const lowThin = { ...pen, thinning: 0.1 };
    const highThin = { ...pen, thinning: 0.9 };
    const delta = (prefs: typeof pen) =>
      penSampleWidth(prefs, { x: 0, y: 0, pressure: 1, time: 0 })
      - penSampleWidth(prefs, { x: 0, y: 0, pressure: 0.2, time: 0 });
    expect(delta(highThin)).toBeGreaterThan(delta(lowThin));
  });

  it("exports variable segment thicknesses", () => {
    const segments = penSegmentWidths(
      [
        { x: 0, y: 0, pressure: 0.2 },
        { x: 10, y: 0, pressure: 1 }
      ],
      {
        color: "#111",
        width: 2.5,
        opacity: 1,
        pressureSensitivity: true,
        thinning: 0.55
      }
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]!.thickness).toBeGreaterThan(0);
  });

  it("draws onto a canvas context without throwing", () => {
    const ops: string[] = [];
    const context = {
      save: () => ops.push("save"),
      restore: () => ops.push("restore"),
      beginPath: () => ops.push("beginPath"),
      arc: () => ops.push("arc"),
      fill: () => ops.push("fill"),
      globalAlpha: 1,
      fillStyle: "",
      strokeStyle: "",
      lineCap: "",
      lineJoin: ""
    } as unknown as CanvasRenderingContext2D;
    drawPenStroke(context, [
      { x: 0, y: 0, pressure: 0.3 },
      { x: 20, y: 5, pressure: 0.9 }
    ], {
      color: "#111827",
      width: 2.5,
      opacity: 1,
      pressureSensitivity: true,
      thinning: 0.55
    });
    expect(ops).toContain("save");
    expect(ops).toContain("arc");
    expect(ops).toContain("restore");
  });
});
