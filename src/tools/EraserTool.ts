import type { InkStroke, PdfPoint } from "../model";
import { hitTestStroke } from "../ink/StrokeHitTesting";

export function eraseWholeStrokes(strokes: readonly InkStroke[], path: readonly Pick<PdfPoint, "x" | "y">[], size: number): { kept: InkStroke[]; erased: InkStroke[] } {
  const erased = strokes.filter((stroke) => path.some((point) => hitTestStroke(stroke, point, size / 2)));
  const ids = new Set(erased.map((stroke) => stroke.id));
  return { kept: strokes.filter((stroke) => !ids.has(stroke.id)), erased };
}

