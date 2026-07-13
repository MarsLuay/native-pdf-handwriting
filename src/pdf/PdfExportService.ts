import { PDFDocument, rgb } from "pdf-lib";
import type { InkStroke } from "../model";

export interface PdfExportInput {
  sourceBytes: Uint8Array;
  strokes?: readonly InkStroke[];
  getStrokes?: () => readonly InkStroke[];
  flush?: () => Promise<void>;
}

function parseColor(value: string): ReturnType<typeof rgb> {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return rgb(0, 0, 0);
  const hex = match[1]!;
  return rgb(Number.parseInt(hex.slice(0, 2), 16) / 255, Number.parseInt(hex.slice(2, 4), 16) / 255, Number.parseInt(hex.slice(4, 6), 16) / 255);
}

export function annotatedFilename(sourceName: string): string {
  const base = sourceName.replace(/\.pdf$/i, "");
  return `${base || "document"}-annotated.pdf`;
}

export class PdfExportService {
  async export(input: PdfExportInput): Promise<Uint8Array> {
    await input.flush?.();
    const strokes = input.getStrokes?.() ?? input.strokes ?? [];
    const sourceSnapshot = input.sourceBytes.slice();
    const document = await PDFDocument.load(sourceSnapshot);
    for (const stroke of strokes) {
      const page = document.getPages()[stroke.page - 1];
      if (!page) throw new RangeError(`Stroke ${stroke.id} references missing page ${stroke.page}`);
      const color = parseColor(stroke.color);
      if (stroke.points.length === 1) {
        const point = stroke.points[0]!;
        page.drawCircle({ x: point.x, y: point.y, size: stroke.width / 2, color, opacity: stroke.opacity });
      }
      for (let index = 1; index < stroke.points.length; index += 1) {
        const start = stroke.points[index - 1]!; const end = stroke.points[index]!;
        const pressure = Math.max(0.15, (start.pressure + end.pressure) / 2);
        page.drawLine({ start, end, thickness: stroke.width * pressure, color, opacity: stroke.opacity });
      }
    }
    const exported = await document.save();
    await PDFDocument.load(exported);
    if (!input.sourceBytes.every((byte, index) => byte === sourceSnapshot[index])) throw new Error("Source PDF bytes changed during export");
    return exported;
  }

  async validate(bytes: Uint8Array): Promise<void> { await PDFDocument.load(bytes); }
}

export interface BinaryFileAdapter {
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  replace(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface DirectWriteOptions {
  confirmed: boolean;
  createBackup?: boolean;
  backupPath?: string;
  retainSidecar?: boolean;
  onDiscardSidecar?: () => Promise<void>;
}

export const DEFAULT_YOLO_OPTIONS = { enabled: false, createBackup: true, retainSidecar: true } as const;

export class DirectPdfWriteTransaction {
  constructor(private readonly files: BinaryFileAdapter, private readonly validate: (bytes: Uint8Array) => Promise<void>) {}

  async commit(sourcePath: string, output: Uint8Array, options: DirectWriteOptions): Promise<void> {
    if (!options.confirmed) throw new Error("YOLO Mode direct write requires explicit confirmation");
    const tempPath = `${sourcePath}.ink-tmp`;
    const backupPath = options.backupPath ?? `${sourcePath}.ink-backup`;
    const createBackup = options.createBackup ?? true;
    const retainSidecar = options.retainSidecar ?? true;
    let backupCreated = false;
    let replaced = false;
    await this.files.write(tempPath, output);
    try {
      await this.validate(await this.files.read(tempPath));
      if (createBackup) { await this.files.copy(sourcePath, backupPath); backupCreated = true; }
      try { await this.files.replace(tempPath, sourcePath); }
      catch (error) {
        if (backupCreated) await this.files.copy(backupPath, sourcePath);
        throw error;
      }
      replaced = true;
      try { await this.validate(await this.files.read(sourcePath)); }
      catch (error) {
        if (backupCreated) await this.files.copy(backupPath, sourcePath);
        throw error;
      }
      if (!retainSidecar) await options.onDiscardSidecar?.();
    } catch (error) {
      if (!replaced) {
        try { await this.files.remove(tempPath); } catch { /* recovery cleanup is best effort */ }
      }
      throw error;
    }
  }
}
