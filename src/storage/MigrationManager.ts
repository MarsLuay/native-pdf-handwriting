import { parseSidecar, type SidecarSchemaV1 } from "./SidecarSchema";

export interface LegacySidecarV0 {
  version: 0;
  pdf: { id: string; path: string; fingerprint?: string; contentHash?: string };
  pages: Array<{ page: number; width: number; height: number; rotation?: number; strokes: SidecarSchemaV1["pages"][number]["strokes"] }>;
  createdAt?: string;
  updatedAt?: string;
}

export class MigrationManager {
  migrate(input: unknown, now = new Date().toISOString()): SidecarSchemaV1 {
    if (typeof input === "string") {
      const raw: unknown = JSON.parse(input);
      return this.migrate(raw, now);
    }
    if (this.isV0(input)) {
      const document = {
        id: input.pdf.id,
        vaultPath: input.pdf.path,
        ...(input.pdf.fingerprint === undefined ? {} : { fingerprint: input.pdf.fingerprint }),
        ...(input.pdf.contentHash === undefined ? {} : { contentHash: input.pdf.contentHash })
      };
      return parseSidecar(JSON.stringify({
        schemaVersion: 1,
        document,
        pages: input.pages.map((page) => ({ ...page, rotation: this.rotation(page.rotation) })),
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now
      }));
    }
    return parseSidecar(JSON.stringify(input));
  }

  private isV0(value: unknown): value is LegacySidecarV0 {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<LegacySidecarV0>;
    return candidate.version === 0 && typeof candidate.pdf === "object" &&
      candidate.pdf !== null && Array.isArray(candidate.pages);
  }

  private rotation(value: number | undefined): 0 | 90 | 180 | 270 {
    const normalized = ((value ?? 0) % 360 + 360) % 360;
    if (normalized === 90 || normalized === 180 || normalized === 270) return normalized;
    return 0;
  }
}

