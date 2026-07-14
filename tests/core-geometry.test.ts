import { describe, expect, it } from "vitest";
import type { InkStroke, PdfPoint } from "../src/model";
import { hitTestStroke } from "../src/ink/StrokeHitTesting";
import { simplifyPoints } from "../src/ink/StrokeStabilizer";
import { PdfCoordinateMapper, type PageRotation } from "../src/pdf/PdfCoordinateMapper";
import { selectStrokes, shapeContainsPoint, strokeDiscernibleInOverlay, translateShape, type SelectionShape } from "../src/tools/LassoTool";

const point = (x: number, y: number): PdfPoint => ({ x, y, pressure: 0.5, time: x });
const stroke = (id: string, points: PdfPoint[]): InkStroke => ({ id, page: 1, tool: "pen", color: "#000000", width: 2, opacity: 1, inputType: "pen", points, createdAt: "now", updatedAt: "now" });

describe("coordinates and geometry", () => {
  it.each([0, 90, 180, 270] as PageRotation[])("round-trips rotation %i", (rotation) => {
    const mapper = new PdfCoordinateMapper({ width: 100, height: 200, scale: 2, rotation, offsetX: 5, offsetY: 7 });
    const viewport = mapper.toViewport({ x: 25, y: 50 });
    expect(mapper.toPdf(viewport)).toEqual({ x: 25, y: 50 });
  });

  it("uses expected rotated viewport axes", () => {
    expect(new PdfCoordinateMapper({ width: 100, height: 200, scale: 1, rotation: 90 }).toViewport({ x: 20, y: 30 })).toEqual({ x: 30, y: 20 });
    expect(new PdfCoordinateMapper({ width: 100, height: 200, scale: 1, rotation: 270 }).toViewport({ x: 20, y: 30 })).toEqual({ x: 170, y: 80 });
  });

  it("simplifies collinear points and hit-tests stroke width", () => {
    expect(simplifyPoints([point(0, 0), point(1, 0.01), point(2, 0)], 0.1)).toHaveLength(2);
    expect(hitTestStroke(stroke("a", [point(0, 0), point(10, 0)]), { x: 5, y: 0.9 })).toBe(true);
    expect(hitTestStroke(stroke("a", [point(0, 0), point(10, 0)]), { x: 5, y: 2 })).toBe(false);
  });

  it.each<SelectionShape>([
    { type: "freeform", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] },
    { type: "rectangle", bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } }
  ])("supports $type intersecting selection when ink is inside", (shape) => {
    const inside = stroke("inside", [point(4, 5), point(6, 5)]);
    const crossing = stroke("crossing", [point(-2, 5), point(5, 5)]);
    expect(selectStrokes([inside, crossing], shape).map((item) => item.id)).toEqual(["inside", "crossing"]);
  });

  it("ignores strokes that only cross the lasso edge", () => {
    const shape: SelectionShape = { type: "rectangle", bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } };
    const grazing = stroke("grazing", [point(-5, 5), point(-1, 5)]);
    const inside = stroke("inside", [point(4, 5), point(6, 5)]);
    expect(selectStrokes([grazing, inside], shape).map((item) => item.id)).toEqual(["inside"]);
  });

  it("ignores multi-point strokes with only one point inside", () => {
    const shape: SelectionShape = { type: "rectangle", bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } };
    const grazing = stroke("grazing", [point(9.9, 5), point(30, 5)]);
    const inside = stroke("inside", [point(4, 5), point(6, 5)]);
    const pair = stroke("pair", [point(8, 5), point(9, 5), point(20, 5)]);
    expect(selectStrokes([grazing, inside, pair], shape).map((item) => item.id)).toEqual(["inside", "pair"]);
  });

  it("translates selection shapes and hit-tests interior points", () => {
    const shape: SelectionShape = { type: "rectangle", bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } };
    const moved = translateShape(shape, 5, -3);
    expect(moved).toEqual({ type: "rectangle", bounds: { minX: 5, minY: -3, maxX: 15, maxY: 7 } });
    expect(shapeContainsPoint(moved, { x: 8, y: 0 })).toBe(true);
    expect(shapeContainsPoint(moved, { x: 1, y: 0 })).toBe(false);
  });

  it("maps host viewport coordinates through content offsets", () => {
    const mapper = new PdfCoordinateMapper({ width: 100, height: 200, scale: 2, rotation: 0, offsetX: 0, offsetY: 12 });
    expect(mapper.toPdf({ x: 20, y: 32 })).toEqual({ x: 10, y: 190 });
    expect(mapper.toViewport({ x: 10, y: 190 })).toEqual({ x: 20, y: 32 });
  });

  it("ignores subpixel and off-overlay strokes for lasso selection", () => {
    const mapper = new PdfCoordinateMapper({ width: 100, height: 200, scale: 0.5, rotation: 0 });
    const visible = stroke("visible", [point(50, 100), point(70, 100)]);
    const tiny = stroke("tiny", [point(10, 10), point(10.2, 10)]);
    const offPage = stroke("off-page", [point(150, 250), point(160, 250)]);
    const toViewport = (point: { x: number; y: number }) => mapper.toViewport(point);
    // Tiny on-page dots stay selectable so i/j marks move with words
    expect(strokeDiscernibleInOverlay(visible, 100, 200, 0.5, 50, 100, toViewport)).toBe(true);
    expect(strokeDiscernibleInOverlay(tiny, 100, 200, 0.5, 50, 100, toViewport)).toBe(true);
    expect(strokeDiscernibleInOverlay(offPage, 100, 200, 0.5, 50, 100, toViewport)).toBe(false);
  });

  it("keeps strokes selectable when live page size is stale but overlay mapping is correct", () => {
    // Real page 1517x1964; live locator wrongly reports letter size.
    const mapper = new PdfCoordinateMapper({ width: 1517, height: 1964, scale: 0.634, rotation: 0 });
    const line = stroke("line", [point(711, 1480), point(758, 1947)]);
    const toViewport = (point: { x: number; y: number }) => mapper.toViewport(point);
    const overlayW = 1517 * 0.634;
    const overlayH = 1964 * 0.634;
    expect(strokeDiscernibleInOverlay(line, 612, 792, 0.634, overlayW, overlayH, toViewport)).toBe(true);
  });

  it("selects short tap/dot strokes with a single point inside the lasso", () => {
    const shape: SelectionShape = { type: "rectangle", bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } };
    const dot = stroke("dot", [point(9.5, 5), point(10.5, 5)]);
    const long = stroke("long", [point(9.5, 5), point(30, 5)]);
    expect(selectStrokes([dot, long], shape).map((item) => item.id)).toEqual(["dot"]);
  });
});

