import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { InkStroke } from "../src/model";
import {
  annotatedFilename,
  mapInkPointToPdfPage,
  mapInkWidthToPdfPage,
  PdfExportService
} from "../src/pdf/PdfExportService";

const stroke: InkStroke = { id: "s", page: 1, tool: "pen", color: "#ff0000", width: 3, opacity: 0.8, inputType: "pen", points: [{ x: 10, y: 10, pressure: 0.5, time: 0 }, { x: 50, y: 50, pressure: 1, time: 1 }], createdAt: "now", updatedAt: "now" };

async function sourcePdf(width = 100, height = 100): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([width, height]);
  return pdf.save();
}

describe("PDF export", () => {
  it("generates _export filenames beside the source name", () => {
    expect(annotatedFilename("paper.pdf")).toBe("paper_export.pdf");
    expect(annotatedFilename("PAPER.PDF")).toBe("PAPER_export.pdf");
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
});
