import type { InkStroke } from "../model";

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
  /** Reserved edit operations keep segment erasure additive and migration-free. */
  erasures?: SegmentErasure[];
}

export interface SegmentErasure {
  id: string;
  strokeId: string;
  fromPoint: number;
  toPoint: number;
  createdAt: string;
}

export interface SidecarSchemaV1 {
  schemaVersion: 1;
  document: SidecarDocumentIdentity;
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
    (value.tool === "pen" || value.tool === "pencil") &&
    typeof value.color === "string" && isFiniteNumber(value.width) && value.width > 0 &&
    isFiniteNumber(value.opacity) && value.opacity >= 0 && value.opacity <= 1 &&
    (value.inputType === "pen" || value.inputType === "mouse" || value.inputType === "touch") &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" &&
    value.points.every((point) => isRecord(point) && isFiniteNumber(point.x) &&
      isFiniteNumber(point.y) && isFiniteNumber(point.pressure) &&
      isFiniteNumber(point.time));
};

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
    (page.erasures === undefined || (Array.isArray(page.erasures) && page.erasures.every((erasure) =>
      isRecord(erasure) && typeof erasure.id === "string" && typeof erasure.strokeId === "string" &&
      Number.isInteger(erasure.fromPoint) && Number.isInteger(erasure.toPoint) && typeof erasure.createdAt === "string"))));
}

export function serializeSidecar(sidecar: SidecarSchemaV1): string {
  if (!validateSidecar(sidecar)) throw new TypeError("Invalid sidecar data");
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}

export function parseSidecar(json: string): SidecarSchemaV1 {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch {
    throw new TypeError("Sidecar is not valid JSON");
  }
  if (!validateSidecar(parsed)) throw new TypeError("Unsupported or invalid sidecar schema");
  return parsed;
}
