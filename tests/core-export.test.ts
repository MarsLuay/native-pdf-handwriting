import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { InkStroke } from "../src/model";
import { annotatedFilename, DirectPdfWriteTransaction, DEFAULT_YOLO_OPTIONS, PdfExportService, type BinaryFileAdapter } from "../src/pdf/PdfExportService";

const stroke: InkStroke = { id: "s", page: 1, tool: "pen", color: "#ff0000", width: 3, opacity: 0.8, inputType: "pen", points: [{ x: 10, y: 10, pressure: 0.5, time: 0 }, { x: 50, y: 50, pressure: 1, time: 1 }], createdAt: "now", updatedAt: "now" };

async function sourcePdf(): Promise<Uint8Array> { const pdf = await PDFDocument.create(); pdf.addPage([100, 100]); return pdf.save(); }

class MemoryBinaryFiles implements BinaryFileAdapter {
  data = new Map<string, Uint8Array>(); failReplace = false;
  async read(path: string) { const value = this.data.get(path); if (!value) throw new Error(`missing ${path}`); return value.slice(); }
  async write(path: string, bytes: Uint8Array) { this.data.set(path, bytes.slice()); }
  async copy(from: string, to: string) { this.data.set(to, await this.read(from)); }
  async replace(from: string, to: string) { if (this.failReplace) { this.data.set(to, new Uint8Array([0])); throw new Error("replace failed"); } this.data.set(to, await this.read(from)); this.data.delete(from); }
  async remove(path: string) { this.data.delete(path); }
}

describe("PDF export", () => {
  it("generates annotated filenames", () => {
    expect(annotatedFilename("paper.pdf")).toBe("paper-annotated.pdf");
    expect(annotatedFilename("PAPER.PDF")).toBe("PAPER-annotated.pdf");
  });

  it("uses latest in-memory strokes after flush and leaves source bytes unchanged", async () => {
    const source = await sourcePdf(); const original = source.slice(); let latest: InkStroke[] = [];
    const flush = vi.fn(async () => { latest = [stroke]; });
    const output = await new PdfExportService().export({ sourceBytes: source, getStrokes: () => latest, flush });
    expect(flush).toHaveBeenCalledOnce();
    expect(source).toEqual(original); expect(output).not.toEqual(source);
    expect((await PDFDocument.load(output)).getPageCount()).toBe(1);
  });
});

describe("explicit direct-write transaction", () => {
  it("defaults YOLO off, backups on, and sidecar retention on", () => {
    expect(DEFAULT_YOLO_OPTIONS).toEqual({ enabled: false, createBackup: true, retainSidecar: true });
  });

  it("requires confirmation and validates before replacing", async () => {
    const files = new MemoryBinaryFiles(); files.data.set("source.pdf", await sourcePdf());
    const transaction = new DirectPdfWriteTransaction(files, async (bytes) => { await PDFDocument.load(bytes); });
    await expect(transaction.commit("source.pdf", new Uint8Array([0]), { confirmed: true })).rejects.toThrow();
    expect(await PDFDocument.load(await files.read("source.pdf"))).toBeTruthy();
    await expect(transaction.commit("source.pdf", await sourcePdf(), { confirmed: false })).rejects.toThrow("explicit confirmation");
  });

  it("creates a backup, rolls back failed replacement, and retains sidecar by default", async () => {
    const files = new MemoryBinaryFiles(); const original = await sourcePdf(); files.data.set("source.pdf", original); files.failReplace = true;
    const discard = vi.fn(async () => undefined); const transaction = new DirectPdfWriteTransaction(files, async () => undefined);
    await expect(transaction.commit("source.pdf", await sourcePdf(), { confirmed: true, onDiscardSidecar: discard })).rejects.toThrow("replace failed");
    expect(await files.read("source.pdf")).toEqual(original); expect(files.data.has("source.pdf.ink-backup")).toBe(true); expect(discard).not.toHaveBeenCalled();
  });

  it("rolls back when post-replacement validation fails", async () => {
    const files = new MemoryBinaryFiles(); const original = await sourcePdf(); files.data.set("source.pdf", original);
    let validations = 0;
    const transaction = new DirectPdfWriteTransaction(files, async () => { validations += 1; if (validations === 2) throw new Error("post validation"); });
    await expect(transaction.commit("source.pdf", await sourcePdf(), { confirmed: true })).rejects.toThrow("post validation");
    expect(await files.read("source.pdf")).toEqual(original);
  });

  it("discards sidecar only after a successful opted-out commit", async () => {
    const files = new MemoryBinaryFiles(); files.data.set("source.pdf", await sourcePdf()); const discard = vi.fn(async () => undefined);
    const transaction = new DirectPdfWriteTransaction(files, async (bytes) => { await PDFDocument.load(bytes); });
    await transaction.commit("source.pdf", await sourcePdf(), { confirmed: true, retainSidecar: false, onDiscardSidecar: discard });
    expect(discard).toHaveBeenCalledOnce();
  });
});
