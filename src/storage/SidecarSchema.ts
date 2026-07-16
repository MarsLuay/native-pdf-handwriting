import type { InkStroke, PdfTextAnnotation, PdfTextRun } from "../model";

export const SIDECAR_SCHEMA_VERSION = 1 as const;

export interface SidecarDocumentIdentity {
  id: string;
  vaultPath: string;
  fingerprint?: string;
  contentHash?: string;
}

export interface SidecarPage {
  page: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  strokes: InkStroke[];
  texts?: PdfTextAnnotation[];
}

export interface SidecarSchemaV1 {
  schemaVersion: 1;
  "document": SidecarDocumentIdentity;
  pages: SidecarPage[];
  createdAt: string;
  updatedAt: string;
  extensions?: Record<string, unknown>;
}

export type SidecarSchema = SidecarSchemaV1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStroke = (value: unknown): value is InkStroke => {
  if (!isRecord(value) || !Array.isArray(value.points)) return false;
  return typeof value.id === "string" && Number.isInteger(value.page) &&
    (value.tool === "pen" || value.tool === "pencil" || value.tool === "highlighter") &&
    typeof value.color === "string" && isFiniteNumber(value.width) && value.width > 0 &&
    isFiniteNumber(value.opacity) && value.opacity >= 0 && value.opacity <= 1 &&
    (value.inputType === "pen" || value.inputType === "mouse" || value.inputType === "touch") &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" &&
    value.points.every((point) => isRecord(point) && isFiniteNumber(point.x) &&
      isFiniteNumber(point.y) && isFiniteNumber(point.pressure) &&
      isFiniteNumber(point.time));
};

const isText = (value: unknown): value is PdfTextAnnotation => {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && Number.isInteger(value.page) && typeof value.text === "string" &&
    isFiniteNumber(value.x) && isFiniteNumber(value.y) && typeof value.color === "string" &&
    isFiniteNumber(value.fontSize) && value.fontSize > 0 && typeof value.createdAt === "string" && typeof value.updatedAt === "string" &&
    (value.runs === undefined || (Array.isArray(value.runs) && value.runs.every(isTextRun))) &&
    (value.sourceRuns === undefined || (Array.isArray(value.sourceRuns) && value.sourceRuns.every(isTextRun)));
};

const isTextRun = (value: unknown): value is PdfTextRun => isRecord(value) &&
  typeof value.text === "string" && typeof value.color === "string" &&
  isFiniteNumber(value.fontSize) && value.fontSize > 0 && typeof value.fontFamily === "string" &&
  typeof value.bold === "boolean" && typeof value.italic === "boolean" &&
  (value.strikethrough === undefined || typeof value.strikethrough === "boolean");

export function validateSidecar(value: unknown): value is SidecarSchemaV1 {
  if (!isRecord(value) || value.schemaVersion !== SIDECAR_SCHEMA_VERSION ||
      !isRecord(value.document) || !Array.isArray(value.pages)) return false;
  if (typeof value.document.id !== "string" || typeof value.document.vaultPath !== "string" ||
      (value.document.fingerprint !== undefined && typeof value.document.fingerprint !== "string") ||
      (value.document.contentHash !== undefined && typeof value.document.contentHash !== "string") ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  return value.pages.every((page) => isRecord(page) && Number.isInteger(page.page) &&
    isFiniteNumber(page.width) && page.width > 0 && isFiniteNumber(page.height) && page.height > 0 &&
    (page.rotation === 0 || page.rotation === 90 || page.rotation === 180 || page.rotation === 270) &&
    Array.isArray(page.strokes) && page.strokes.every(isStroke) &&
    (page.texts === undefined || (Array.isArray(page.texts) && page.texts.every(isText))));
}

export function pickNewerSidecar(
  sidecar: SidecarSchemaV1 | null,
  recovery: SidecarSchemaV1 | null
): SidecarSchemaV1 | null {
  if (!sidecar) return recovery;
  if (!recovery) return sidecar;
  return sidecar.updatedAt >= recovery.updatedAt ? sidecar : recovery;
}

export function countSidecarStrokes(sidecar: SidecarSchemaV1 | null | undefined): number {
  if (!sidecar) return 0;
  return sidecar.pages.reduce((sum, page) => sum + page.strokes.length, 0);
}

function normalizeTextRun(run: PdfTextRun): PdfTextRun {
  return {
    text: run.text,
    color: run.color,
    fontSize: run.fontSize,
    fontFamily: run.fontFamily,
    bold: run.bold,
    italic: run.italic,
    strikethrough: run.strikethrough ?? false
  };
}

function normalizeText(text: PdfTextAnnotation): PdfTextAnnotation {
  return {
    ...text,
    ...(text.runs ? { runs: text.runs.map(normalizeTextRun) } : {}),
    ...(text.sourceRuns ? { sourceRuns: text.sourceRuns.map(normalizeTextRun) } : {})
  };
}

function normalizeSidecar(sidecar: SidecarSchemaV1): SidecarSchemaV1 {
  return {
    ...sidecar,
    pages: sidecar.pages.map((page) => ({
      ...page,
      ...(page.texts ? { texts: page.texts.map(normalizeText) } : {})
    }))
  };
}

export function serializeSidecar(sidecar: SidecarSchemaV1): string {
  if (!validateSidecar(sidecar)) throw new TypeError("Invalid sidecar data");
  return `${JSON.stringify(normalizeSidecar(sidecar), null, 2)}\n`;
}

export function parseSidecar(json: string): SidecarSchemaV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch {
    throw new TypeError("Sidecar is not valid JSON");
  }
  if (!validateSidecar(parsed)) throw new TypeError("Unsupported or invalid sidecar schema");
  return normalizeSidecar(parsed);
}
