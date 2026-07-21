import { describe, expect, it, vi } from "vitest";
import type { InkStroke, PdfPoint } from "../src/model";
import { eraseStrokeSegments, eraseStrokes, eraseWholeStrokes } from "../src/tools/EraserTool";

const point = (x: number, y: number, pressure = 0.5, time = x): PdfPoint => ({ x, y, pressure, time });
const stroke = (id: string, points: PdfPoint[], width = 2): InkStroke => ({
  id, page: 1, tool: "pen", color: "#123456", width, opacity: 0.8,
  inputType: "pen", points, createdAt: "created", updatedAt: "before"
});

describe("circular segment eraser", () => {
  it("is the default eraser and preserves both untouched sides", () => {
    expect(eraseStrokes).toBe(eraseStrokeSegments);
    const original = stroke("line", [point(0, 0, 0.2, 0), point(10, 0, 0.8, 10)]);
    const result = eraseStrokes([original], [point(5, 0)], 2, { now: () => "after" });
    expect(result.erased).toEqual([original]);
    expect(result.fragments).toHaveLength(2);
    expect(result.fragments[0]?.id).toBe("line");
    expect(result.fragments[1]?.id).toBe("line~erase-1");
    expect(result.fragments[0]?.points.at(-1)?.x).toBeCloseTo(3);
    expect(result.fragments[1]?.points[0]?.x).toBeCloseTo(7);
    expect(result.fragments.every((fragment) => fragment.updatedAt === "after" && fragment.createdAt === "created")).toBe(true);
    expect(result.fragments[0]?.points.at(-1)?.pressure).toBeCloseTo(0.38);
  });

  it("uses a swept circle between sparse pointer samples", () => {
    const original = stroke("line", [point(0, 0), point(10, 0)]);
    // Neither pointer sample touches the stroke; the swept vertical capsule does.
    const result = eraseStrokeSegments([original], [point(5, -5), point(5, 5)], 2, { now: () => "after" });
    expect(result.fragments).toHaveLength(2);
    expect(result.fragments[0]?.points.at(-1)?.x).toBeCloseTo(3);
    expect(result.fragments[1]?.points[0]?.x).toBeCloseTo(7);
  });

  it("keeps sparse distant segments untouched while preserving exact swept-path results", () => {
    const distant = stroke("distant", Array.from({ length: 300 }, (_, index) => point(index, 100)));
    const hit = stroke("hit", [point(0, 0), point(10, 0)]);
    const path = [point(5, -5), point(5, 5)];

    const segments = eraseStrokeSegments([distant, hit], path, 20, { scale: 10, now: () => "after" });
    expect(segments.erased).toEqual([hit]);
    expect(segments.kept[0]).toBe(distant);
    expect(segments.fragments).toHaveLength(2);
    expect(segments.fragments[0]?.points.at(-1)?.x).toBeCloseTo(3);
    expect(segments.fragments[1]?.points[0]?.x).toBeCloseTo(7);

    const whole = eraseWholeStrokes([distant, hit], path, 20, { scale: 10 });
    expect(whole.erased).toEqual([hit]);
    expect(whole.kept).toEqual([distant]);
  });

  it("stitches preserved portions across original polyline vertices", () => {
    const original = stroke("polyline", [point(0, 0), point(4, 0), point(8, 0), point(12, 0)]);
    const result = eraseStrokeSegments([original], [point(10, 0)], 2, { now: () => "after" });
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]?.points.map((sample) => sample.x)).toEqual([0, 4, 8]);
  });

  it("converts viewport-sized erasers into PDF units using scale", () => {
    const original = stroke("line", [point(0, 0), point(10, 0)]);
    const result = eraseStrokeSegments([original], [point(5, 0)], 20, { scale: 10, now: () => "after" });
    expect(result.fragments[0]?.points.at(-1)?.x).toBeCloseTo(3);
    expect(result.fragments[1]?.points[0]?.x).toBeCloseTo(7);
  });

  it("keeps untouched strokes by identity and fully removes covered strokes", () => {
    const untouched = stroke("far", [point(0, 20), point(10, 20)]);
    const covered = stroke("short", [point(4.5, 0), point(5.5, 0)]);
    const result = eraseStrokeSegments([untouched, covered], [point(5, 0)], 2);
    expect(result.kept).toEqual([untouched]);
    expect(result.erased).toEqual([covered]);
    expect(result.fragments).toEqual([]);
  });

  it("optionally removes the complete touched stroke", () => {
    const original = stroke("line", [point(0, 0), point(10, 0)]);
    const result = eraseWholeStrokes([original], [point(5, 0)], 2);
    expect(result.erased).toEqual([original]);
    expect(result.kept).toEqual([]);
    expect(result.fragments).toEqual([]);
  });

  it("whole-stroke erasing stops at contact without creating segment fragments", () => {
    const original = stroke("line", [point(0, 0), point(10, 0)]);
    const createFragmentId = vi.fn(() => "unused");
    const result = eraseWholeStrokes([original], [point(5, -5), point(5, 5)], 2, { createFragmentId });

    expect(result.erased).toEqual([original]);
    expect(result.kept).toEqual([]);
    expect(result.fragments).toEqual([]);
    expect(createFragmentId).not.toHaveBeenCalled();
  });

  it("does not split a stroke at exact tangency", () => {
    const original = stroke("line", [point(0, 0), point(10, 0)]);
    const result = eraseStrokeSegments([original], [point(5, 2)], 2);
    expect(result.erased).toEqual([]);
    expect(result.kept).toEqual([original]);
  });

  it("whole-stroke erasing also ignores exact tangency", () => {
    const original = stroke("line", [point(0, 0), point(10, 0)]);
    const result = eraseWholeStrokes([original], [point(5, 2)], 2);
    expect(result.erased).toEqual([]);
    expect(result.kept).toEqual([original]);
  });

  it("assigns collision-free IDs across repeated eraser passes", () => {
    let nextId = 0;
    const createFragmentId = () => `fragment-${nextId++}`;
    const original = stroke("line", [point(0, 0), point(20, 0)]);
    const first = eraseStrokeSegments([original], [point(7, 0)], 2, { createFragmentId });
    const second = eraseStrokeSegments(first.kept, [point(14, 0)], 2, { createFragmentId });
    const ids = second.kept.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(second.kept).toHaveLength(3);
  });

  it("rejects invalid size and coordinate scale", () => {
    expect(() => eraseStrokeSegments([], [], 0)).toThrow("positive");
    expect(() => eraseStrokeSegments([], [], 2, { scale: 0 })).toThrow("scale");
  });
});
