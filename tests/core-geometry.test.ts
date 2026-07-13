import { describe, expect, it } from "vitest";
import type { InkStroke, PdfPoint } from "../src/model";
import { hitTestStroke } from "../src/ink/StrokeHitTesting";
import { simplifyPoints } from "../src/ink/StrokeStabilizer";
import { PdfCoordinateMapper, type PageRotation } from "../src/pdf/PdfCoordinateMapper";
import { selectStrokes, type SelectionShape } from "../src/tools/LassoTool";

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
    { type: "rectangle", bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } },
    { type: "ellipse", bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } }
  ])("supports $type enclosed/intersecting selection", (shape) => {
    const inside = stroke("inside", [point(4, 5), point(6, 5)]);
    const crossing = stroke("crossing", [point(-2, 5), point(5, 5)]);
    expect(selectStrokes([inside, crossing], shape, "enclosed").map((item) => item.id)).toEqual(["inside"]);
    expect(selectStrokes([inside, crossing], shape, "intersecting").map((item) => item.id)).toEqual(["inside", "crossing"]);
  });
});

