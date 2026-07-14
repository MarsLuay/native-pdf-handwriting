import { describe, expect, it, vi } from "vitest";
import {
  drawHighlighterStroke,
  highlighterRibbonEdges,
  highlighterSampleWidth,
  highlighterSegmentWidths
} from "../src/tools/HighlighterTool";
import { DEFAULT_SETTINGS } from "../src/model";

describe("HighlighterTool", () => {
  it("keeps width nearly constant without pressure sensitivity", () => {
    const prefs = DEFAULT_SETTINGS.toolPreferences.highlighter;
    const soft = highlighterSampleWidth(prefs, { x: 0, y: 0, pressure: 0.2, time: 0 });
    const hard = highlighterSampleWidth(prefs, { x: 0, y: 0, pressure: 1, time: 0 });
    expect(soft).toBe(hard);
    expect(soft).toBeCloseTo(prefs.width, 5);
  });

  it("thins slightly when pressure sensitivity is on", () => {
    const prefs = {
      ...DEFAULT_SETTINGS.toolPreferences.highlighter,
      pressureSensitivity: true,
      thinning: 0.4
    };
    const soft = highlighterSampleWidth(prefs, { x: 0, y: 0, pressure: 0.35, time: 0 });
    const hard = highlighterSampleWidth(prefs, { x: 0, y: 0, pressure: 1, time: 0 });
    expect(hard).toBeGreaterThan(soft);
  });

  it("builds segment thicknesses for export", () => {
    const segments = highlighterSegmentWidths(
      [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 10, y: 0, pressure: 0.5 },
        { x: 20, y: 0, pressure: 0.5 }
      ],
      {
        color: "#facc15",
        width: 14,
        opacity: 0.35,
        pressureSensitivity: false,
        thinning: 0
      }
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]!.thickness).toBe(14);
  });

  it("builds parallel ribbon edges for continuous fills", () => {
    const { left, right, widths } = highlighterRibbonEdges(
      [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 20, y: 0, pressure: 0.5 }
      ],
      {
        color: "#facc15",
        width: 14,
        opacity: 0.35,
        pressureSensitivity: false,
        thinning: 0
      }
    );
    expect(widths).toEqual([14, 14]);
    expect(Math.abs(left[0]!.y)).toBeCloseTo(7, 5);
    expect(right[0]!.y).toBeCloseTo(-left[0]!.y, 5);
    expect(left[1]!.x).toBeCloseTo(20, 5);
  });

  it("paints a continuous translucent stroke (not elliptical stamps)", () => {
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      ellipse: vi.fn(),
      arc: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      closePath: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      globalAlpha: 1,
      fillStyle: "",
      strokeStyle: "",
      lineCap: "butt",
      lineJoin: "round",
      lineWidth: 1
    } as unknown as CanvasRenderingContext2D;

    drawHighlighterStroke(
      context,
      [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 20, y: 0, pressure: 0.5 },
        { x: 40, y: 0, pressure: 0.5 }
      ],
      {
        color: "#facc15",
        width: 14,
        opacity: 0.35,
        pressureSensitivity: false,
        thinning: 0
      }
    );

    expect(context.save).toHaveBeenCalled();
    expect(context.restore).toHaveBeenCalled();
    expect(context.globalAlpha).toBe(0.35);
    expect(context.stroke).toHaveBeenCalled();
    expect(context.ellipse).not.toHaveBeenCalled();
    expect(context.quadraticCurveTo).toHaveBeenCalled();
  });

  it("fills a ribbon when width varies strongly with pressure", () => {
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      ellipse: vi.fn(),
      arc: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      closePath: vi.fn(),
      globalAlpha: 1,
      fillStyle: "",
      strokeStyle: "",
      lineCap: "butt",
      lineJoin: "round",
      lineWidth: 1
    } as unknown as CanvasRenderingContext2D;

    drawHighlighterStroke(
      context,
      [
        { x: 0, y: 0, pressure: 0.35 },
        { x: 40, y: 0, pressure: 1 }
      ],
      {
        color: "#facc15",
        width: 20,
        opacity: 0.35,
        pressureSensitivity: true,
        thinning: 0.7
      }
    );

    expect(context.fill).toHaveBeenCalled();
    expect(context.closePath).toHaveBeenCalled();
    expect(context.ellipse).not.toHaveBeenCalled();
  });
});
