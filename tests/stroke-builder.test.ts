import { describe, expect, it } from "vitest";
import { StrokeBuilder } from "../src/ink/StrokeBuilder";

function point(x: number, y: number) {
  return { x, y, pressure: 0.5, time: 0 };
}

describe("stroke builder", () => {
  const base = {
    id: "stroke-1",
    page: 1,
    tool: "pen" as const,
    color: "#111827",
    width: 2,
    opacity: 1,
    inputType: "mouse" as const,
    stabilization: "off" as const,
    now: () => "2026-07-12T00:00:00.000Z"
  };

  it("simplifies finished strokes by default", () => {
    const builder = new StrokeBuilder(base);
    builder.add(point(0, 0));
    builder.add(point(1, 0.01));
    builder.add(point(2, 0));
    expect(builder.finish(true).points).toHaveLength(2);
  });

  it("keeps the raw path when simplification is disabled", () => {
    const builder = new StrokeBuilder(base);
    builder.add(point(0, 0));
    builder.add(point(1, 0.01));
    builder.add(point(2, 0));
    expect(builder.finish(false).points).toHaveLength(3);
  });

  it("does not stabilize on finish when simplification is disabled", () => {
    const builder = new StrokeBuilder({ ...base, stabilization: "medium" });
    builder.add(point(0, 0));
    builder.add(point(1, 4));
    builder.add(point(2, 0));
    const finished = builder.finish(false).points;
    expect(finished[1]?.y).toBe(4);
    expect(builder.preview(false)[1]?.y).toBe(4);
  });

  it("matches preview and finish when simplification is disabled", () => {
    const builder = new StrokeBuilder({ ...base, stabilization: "high" });
    builder.add(point(0, 0));
    builder.add(point(1, 3));
    builder.add(point(2, 1));
    expect(builder.preview(false)).toEqual(builder.finish(false).points);
  });

  it("uses a straight line for preview and finish after a hold is recognized", () => {
    const builder = new StrokeBuilder(base);
    builder.add(point(0, 0));
    builder.add(point(2, 4));
    builder.add(point(6, 1));
    expect(builder.straighten()).toBe(true);
    expect(builder.preview(false)).toEqual([point(0, 0), point(6, 1)]);
    expect(builder.finish(false).points).toEqual([point(0, 0), point(6, 1)]);
  });

  it("snaps held lines within one degree of horizontal or vertical", () => {
    const horizontal = new StrokeBuilder(base);
    horizontal.add(point(0, 0));
    horizontal.add(point(100, 1.74)); // Just under 1 degree.
    horizontal.straighten();
    expect(horizontal.finish(false).points[1]).toMatchObject({ x: 100, y: 0 });

    const vertical = new StrokeBuilder(base);
    vertical.add(point(0, 0));
    vertical.add(point(1.74, 100)); // Just under 1 degree from vertical.
    vertical.straighten();
    expect(vertical.finish(false).points[1]).toMatchObject({ x: 0, y: 100 });
  });

  it("keeps held lines outside the one-degree axis threshold unchanged", () => {
    const builder = new StrokeBuilder(base);
    builder.add(point(0, 0));
    builder.add(point(100, 1.75)); // Just over 1 degree.
    builder.straighten();
    expect(builder.finish(false).points[1]).toMatchObject({ x: 100, y: 1.75 });
  });

  it("updates the straight line endpoint without leaving straightened mode", () => {
    const builder = new StrokeBuilder(base);
    builder.add(point(0, 0));
    builder.add(point(4, 4));
    builder.straighten();
    expect(builder.updateStraightenedEndpoint(point(6, 2))).toBe(true);
    expect(builder.preview(false)).toEqual([point(0, 0), point(6, 2)]);
    expect(builder.finish(false).points).toEqual([point(0, 0), point(6, 2)]);
  });
});
