import type { InkStroke } from "../model";

export class StrokeClipboard {
  private static data: { strokes: InkStroke[]; sourcePage: number } | null = null;

  static store(strokes: readonly InkStroke[], sourcePage: number): void {
    this.data = {
      strokes: strokes.map((stroke) => structuredClone(stroke)),
      sourcePage
    };
  }

  static peek(): { strokes: InkStroke[]; sourcePage: number } | null {
    return this.data;
  }

  static clear(): void {
    this.data = null;
  }
}
