import { describe, expect, it } from "vitest";
import { isSelectablePdfTarget } from "../src/input/PdfSelectableTarget";

describe("pdf selectable targets", () => {
  it("detects pdf text glyphs and form controls", () => {
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    const span = document.createElement("span");
    span.textContent = "Hello";
    textLayer.append(span);
    expect(isSelectablePdfTarget(span)).toBe(true);

    const input = document.createElement("input");
    expect(isSelectablePdfTarget(input)).toBe(true);

    const canvas = document.createElement("canvas");
    expect(isSelectablePdfTarget(canvas)).toBe(false);
  });

  it("allows pan gestures through empty text layer padding", () => {
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    expect(isSelectablePdfTarget(textLayer)).toBe(false);

    const emptySpan = document.createElement("span");
    textLayer.append(emptySpan);
    expect(isSelectablePdfTarget(emptySpan)).toBe(false);
  });

  it("treats PDF++ backlinks as selectable pass-through", () => {
    const link = document.createElement("a");
    link.className = "pdf-plus-backlink";
    link.textContent = "note";
    expect(isSelectablePdfTarget(link)).toBe(true);

    const palette = document.createElement("div");
    palette.className = "pdf-plus-color-palette";
    const swatch = document.createElement("button");
    palette.append(swatch);
    expect(isSelectablePdfTarget(swatch)).toBe(true);
  });
});
