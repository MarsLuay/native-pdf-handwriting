import { describe, expect, it } from "vitest";
import { inkBackingSize, MAX_INK_EDGE_PX, MAX_INK_PIXELS } from "../src/runtime/inkBackingSize";

describe("inkBackingSize", () => {
  it("uses css×dpr while under the budget", () => {
    const size = inkBackingSize(800, 600, 2);
    expect(size.pixelWidth).toBe(1600);
    expect(size.pixelHeight).toBe(1200);
    expect(size.backingScale).toBeCloseTo(2, 5);
  });

  it("caps huge zoomed pages so settle does not allocate multi‑MP canvases", () => {
    // Typical letter page at ~8× CSS: earlier logs ~6500×8400 @ dpr2 → ~218MP uncut.
    const size = inkBackingSize(6500, 8400, 2);
    expect(size.pixelWidth).toBeLessThanOrEqual(MAX_INK_EDGE_PX);
    expect(size.pixelHeight).toBeLessThanOrEqual(MAX_INK_EDGE_PX);
    expect(size.pixelWidth * size.pixelHeight).toBeLessThanOrEqual(MAX_INK_PIXELS + 2);
    expect(size.backingScale).toBeLessThan(2);
    expect(size.backingScale).toBeGreaterThan(0.1);
  });

  it("keeps the same backing size once past the cap (further zoom = CSS stretch only)", () => {
    const a = inkBackingSize(4000, 5200, 2);
    const b = inkBackingSize(8000, 10400, 2);
    expect(a.pixelWidth).toBe(b.pixelWidth);
    expect(a.pixelHeight).toBe(b.pixelHeight);
  });
});
