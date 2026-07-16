import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { InkStroke, PdfTextAnnotation } from "../src/model";
import {
  annotatedFilename,
  editableAnnotatedFilename,
  mapInkPointToPdfPage,
  mapInkWidthToPdfPage,
  PdfExportService
} from "../src/pdf/PdfExportService";

const stroke: InkStroke = { id: "s", page: 1, tool: "pen", color: "#ff0000", width: 3, opacity: 0.8, inputType: "pen", points: [{ x: 10, y: 10, pressure: 0.5, time: 0 }, { x: 50, y: 50, pressure: 1, time: 1 }], createdAt: "now", updatedAt: "now" };

function appearanceContents(document: PDFDocument, annotation: PDFDict): string {
  const appearance = annotation.lookup(PDFName.of("AP"), PDFDict);
  const normal = document.context.lookup(appearance.get(PDFName.of("N"))!) as unknown as { getContents(): Uint8Array };
  return new TextDecoder().decode(inflateSync(normal.getContents()));
}

function appearanceBounds(document: PDFDocument, annotation: PDFDict): number[] {
  const appearance = annotation.lookup(PDFName.of("AP"), PDFDict);
  const normal = document.context.lookup(appearance.get(PDFName.of("N"))!) as unknown as { dict: PDFDict };
  return normal.dict.lookup(PDFName.of("BBox"), PDFArray).asArray().map((value) => (value as unknown as { asNumber(): number }).asNumber());
}

async function sourcePdf(width = 100, height = 100): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([width, height]);
  return pdf.save();
}

describe("PDF export", () => {
  it("generates _export filenames beside the source name", () => {
    expect(annotatedFilename("paper.pdf")).toBe("paper_export.pdf");
    expect(annotatedFilename("PAPER.PDF")).toBe("PAPER_export.pdf");
    expect(editableAnnotatedFilename("paper.pdf")).toBe("paper_editable.pdf");
  });

  it("scales ink page-space into PDF MediaBox points (CSS 96dpi vs PDF 72dpi)", () => {
    const ink = { width: 816, height: 1056 };
    const pdf = { width: 612, height: 792 };
    expect(mapInkPointToPdfPage({ x: 816, y: 1056 }, ink, pdf)).toEqual({ x: 612, y: 792 });
    expect(mapInkPointToPdfPage({ x: 408, y: 528 }, ink, pdf)).toEqual({ x: 306, y: 396 });
    expect(mapInkWidthToPdfPage(3, ink, pdf)).toBeCloseTo(2.25, 5);
  });

  it("uses latest in-memory strokes after flush and leaves source bytes unchanged", async () => {
    const source = await sourcePdf(); const original = source.slice(); let latest: InkStroke[] = [];
    const flush = vi.fn(async () => { latest = [stroke]; });
    const output = await new PdfExportService().export({ sourceBytes: source, getStrokes: () => latest, flush });
    expect(flush).toHaveBeenCalledOnce();
    expect(source).toEqual(original); expect(output).not.toEqual(source);
    expect((await PDFDocument.load(output)).getPageCount()).toBe(1);
  });

  it("renders text directly into flattened exports without annotations", async () => {
    const context = {
      font: "", fillStyle: "", strokeStyle: "", lineWidth: 0,
      measureText: vi.fn((text: string) => ({ width: text.length * 12 })),
      fillRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn()
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1rQAAAABJRU5ErkJggg=="
    );
    const text: PdfTextAnnotation = {
      id: "flattened-korean", page: 1, text: "한글 제목", x: 10, y: 70,
      color: "#dc2626", fontSize: 22, fontFamily: "Noto Sans KR", bold: true, italic: true,
      runs: [{ text: "한글 제목", color: "#dc2626", fontSize: 22, fontFamily: "Noto Sans KR", bold: true, italic: true, strikethrough: true }],
      createdAt: "now", updatedAt: "now"
    };
    const output = await new PdfExportService().export({ sourceBytes: await sourcePdf(), texts: [text], mode: "flattened" });
    const page = (await PDFDocument.load(output)).getPages()[0]!;
    expect(page.node.lookup(PDFName.Annots, PDFArray).size()).toBe(0);
    expect(context.fillText).toHaveBeenCalledWith("한글 제목", expect.any(Number), expect.any(Number));
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
  });

  it("exports when sidecar metrics differ from MediaBox without throwing", async () => {
    const source = await sourcePdf(612, 792);
    const letterStroke: InkStroke = {
      ...stroke,
      points: [
        { x: 87.3, y: 715.9, pressure: 0.5, time: 0 },
        { x: 161.6, y: 717.4, pressure: 0.5, time: 1 }
      ]
    };
    const output = await new PdfExportService().export({
      sourceBytes: source,
      strokes: [letterStroke],
      pageMetrics: [{ page: 1, width: 816, height: 1055.3 }]
    });
    expect((await PDFDocument.load(output)).getPages()[0]!.getSize()).toEqual({ width: 612, height: 792 });
  });

  it("re-exports from the same source without stacking prior export ink", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const source = await pdf.save();
    const exporter = new PdfExportService();
    const first = await exporter.export({ sourceBytes: source, strokes: [stroke] });
    const second = await exporter.export({ sourceBytes: source, strokes: [stroke] });
    expect(first.byteLength).toBe(second.byteLength);
  });

  it("exports editable Ink annotations with appearance streams", async () => {
    const source = await sourcePdf();
    const sourceDocument = await PDFDocument.load(source);
    const existing = sourceDocument.context.register(sourceDocument.context.obj({
      Type: "Annot",
      Subtype: "Text",
      Rect: [1, 1, 10, 10]
    }));
    sourceDocument.getPages()[0]!.node.addAnnot(existing);
    const output = await new PdfExportService().export({
      sourceBytes: await sourceDocument.save(),
      strokes: [
        stroke,
        { ...stroke, id: "highlight", tool: "highlighter", color: "#ffff00", opacity: 0.3 },
        { ...stroke, id: "pencil", tool: "pencil", color: "#555555", opacity: 0.55 }
      ],
      mode: "editable"
    });
    const exported = await PDFDocument.load(output);
    const annots = exported.getPages()[0]!.node.lookup(PDFName.Annots, PDFArray);
    expect(annots.size()).toBe(4);
    expect(annots.lookup(0, PDFDict).lookup(PDFName.of("Subtype"), PDFName).decodeText()).toBe("Text");
    const annotation = annots.lookup(1, PDFDict);
    expect(annotation.lookup(PDFName.of("Subtype"), PDFName).decodeText()).toBe("Ink");
    expect(annotation.lookup(PDFName.of("InkList"), PDFArray).size()).toBe(1);
    expect(annotation.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"))).toBeDefined();
    const inkBounds = appearanceBounds(exported, annotation);
    expect(inkBounds.slice(0, 2)).toEqual([0, 0]);
    expect(inkBounds[2]).toBeGreaterThan(0);
    expect(inkBounds[3]).toBeGreaterThan(0);
  });

  it("exports rich text as editable FreeText annotations with rendered contents", async () => {
    const text: PdfTextAnnotation = {
      id: "text-1",
      page: 1,
      text: "Bold note\nsecond line",
      x: 10,
      y: 70,
      color: "#2563eb",
      fontSize: 12,
      fontFamily: "sans-serif",
      bold: false,
      italic: false,
      runs: [
        { text: "Bold", color: "#dc2626", fontSize: 20, fontFamily: "sans-serif", bold: true, italic: false, strikethrough: false },
        { text: " note\nsecond line", color: "#2563eb", fontSize: 12, fontFamily: "serif", bold: false, italic: true, strikethrough: true }
      ],
      createdAt: "now",
      updatedAt: "now"
    };
    const output = await new PdfExportService().export({
      sourceBytes: await sourcePdf(),
      texts: [text],
      mode: "editable"
    });
    const exported = await PDFDocument.load(output);
    const annots = exported.getPages()[0]!.node.lookup(PDFName.Annots, PDFArray);
    expect(annots.size()).toBe(1);
    const annotation = annots.lookup(0, PDFDict);
    expect(annotation.lookup(PDFName.of("Subtype"), PDFName).decodeText()).toBe("FreeText");
    expect((annotation.lookup(PDFName.of("Contents")) as PDFHexString).decodeText()).toBe("Bold note\nsecond line");
    expect(annotation.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"))).toBeDefined();
    expect(annotation.get(PDFName.of("C"))).toBeUndefined();
    expect(appearanceBounds(exported, annotation).slice(0, 2)).toEqual([0, 0]);
    const contents = appearanceContents(exported, annotation);
    expect(contents).toContain("20 Tf");
    expect(contents).not.toContain(" re\nf");
    expect(contents).toContain(" RG");
  });

  it("exports resolved heading runs without Markdown markers", async () => {
    const text: PdfTextAnnotation = {
      id: "heading", page: 1, text: "Heading\nbody", x: 10, y: 70,
      color: "#111827", fontSize: 16, fontFamily: "sans-serif", bold: false, italic: false,
      runs: [
        { text: "Heading", color: "#111827", fontSize: 27.2, fontFamily: "sans-serif", bold: true, italic: false, strikethrough: false },
        { text: "\nbody", color: "#111827", fontSize: 16, fontFamily: "sans-serif", bold: false, italic: false, strikethrough: false }
      ],
      createdAt: "now", updatedAt: "now"
    };
    const output = await new PdfExportService().export({ sourceBytes: await sourcePdf(), texts: [text], mode: "editable" });
    const exported = await PDFDocument.load(output);
    const annotation = exported.getPages()[0]!.node.lookup(PDFName.Annots, PDFArray).lookup(0, PDFDict);
    const contents = appearanceContents(exported, annotation);
    expect((annotation.lookup(PDFName.of("Contents")) as PDFHexString).decodeText()).toBe("Heading\nbody");
    expect(contents).toContain("27.2 Tf");
    expect(contents).toContain("16 Tf");
    expect(contents).not.toContain("# Heading");
  });

  it("uses installed fonts through rich text for Unicode editable text", async () => {
    const context = {
      font: "", fillStyle: "", strokeStyle: "", lineWidth: 0,
      measureText: vi.fn((text: string) => ({ width: text.length * 12 })),
      fillRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn()
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL1rQAAAABJRU5ErkJggg=="
    );
    const text: PdfTextAnnotation = {
      id: "text-korean",
      page: 1,
      text: "한글 제목",
      x: 10,
      y: 70,
      color: "#111827",
      fontSize: 14,
      fontFamily: "Noto Sans KR",
      bold: false,
      italic: false,
      runs: [{ text: "한글 제목", color: "#dc2626", fontSize: 22, fontFamily: "Noto Sans KR", bold: true, italic: true, strikethrough: true }],
      createdAt: "now",
      updatedAt: "now"
    };
    const output = await new PdfExportService().export({
      sourceBytes: await sourcePdf(),
      texts: [text],
      mode: "editable"
    });
    const exported = await PDFDocument.load(output);
    const annotation = exported.getPages()[0]!.node.lookup(PDFName.Annots, PDFArray).lookup(0, PDFDict);
    expect(annotation.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"))).toBeDefined();
    expect(annotation.get(PDFName.of("RC"))).toBeUndefined();
    expect(annotation.get(PDFName.of("DS"))).toBeUndefined();
    const rect = annotation.lookup(PDFName.of("Rect"), PDFArray).asArray().map((value) => (value as unknown as { asNumber(): number }).asNumber());
    expect(rect[0]).toBeCloseTo(10, 5);
    expect(rect[1]).toBeLessThan(70);
    expect(rect[3]).toBeGreaterThan(70);
    const contents = appearanceContents(exported, annotation);
    expect(contents).toContain("/Im0 Do");
    expect(contents).not.toMatch(/0 -\d+(?:\.\d+)? 0/);
    expect(context.fillRect).not.toHaveBeenCalled();
    expect(context.fillText).toHaveBeenCalledWith("한글 제목", expect.any(Number), expect.any(Number));
    expect(context.fillText.mock.calls[0]?.[2]).toBeGreaterThan(context.fillText.mock.calls[0]?.[1] ?? 0);
    expect(context.stroke).toHaveBeenCalled();
  });
});
