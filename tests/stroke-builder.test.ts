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

  it("finishMatchingPreview keeps live preview geometry (no release snap)", () => {
    const opts = { ...base, stabilization: "medium" as const };
    const builder = new StrokeBuilder(opts);
    for (const p of [point(0, 0), point(1, 0.01), point(2, 0), point(3, 0.02), point(4, 0)]) {
      builder.add(p);
    }
    const preview = builder.preview(true);
    const matched = builder.finishMatchingPreview(true).points;
    expect(matched).toEqual(preview);
    expect(builder.id).toBe("stroke-1");

    const simplifyBuilder = new StrokeBuilder(opts);
    for (const p of [point(0, 0), point(1, 0.01), point(2, 0), point(3, 0.02), point(4, 0)]) {
      simplifyBuilder.add(p);
    }
    // Regular finish simplifies — that was the release snap.
    expect(simplifyBuilder.finish(true).points.length).toBeLessThan(matched.length);
  });
});
