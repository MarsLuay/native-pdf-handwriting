import { describe, expect, it } from "vitest";
import type { InkStroke } from "../src/model";
import { createDocumentIdentity } from "../src/storage/DocumentIdentity";
import { MigrationManager } from "../src/storage/MigrationManager";
import { SidecarRepository, type TextFileAdapter } from "../src/storage/SidecarRepository";
import { parseSidecar, pickNewerSidecar, serializeSidecar, type SidecarSchemaV1 } from "../src/storage/SidecarSchema";

const stroke: InkStroke = { id: "s1", page: 1, tool: "pen", color: "#000000", width: 2, opacity: 1, inputType: "pen", points: [{ x: 1, y: 2, pressure: 0.5, time: 3 }], createdAt: "2026-01-01", updatedAt: "2026-01-01" };
const sidecar = (): SidecarSchemaV1 => ({ schemaVersion: 1, document: { id: "doc", vaultPath: "a.pdf" }, pages: [{ page: 1, width: 100, height: 200, rotation: 0, strokes: [stroke] }], createdAt: "2026-01-01", updatedAt: "2026-01-01" });

class MemoryFiles implements TextFileAdapter {
  data = new Map<string, string>();
  failRename = false;
  async exists(path: string) { return this.data.has(path); }
  async read(path: string) { const value = this.data.get(path); if (value === undefined) throw new Error("missing"); return value; }
  async write(path: string, contents: string) { this.data.set(path, contents); }
  async rename(from: string, to: string) { if (this.failRename) throw new Error("rename failed"); this.data.set(to, await this.read(from)); this.data.delete(from); }
  async remove(path: string) { this.data.delete(path); }
}

describe("sidecar storage", () => {
  it("round-trips schema v1 and rejects invalid JSON", () => {
    expect(parseSidecar(serializeSidecar(sidecar()))).toEqual(sidecar());
    expect(() => parseSidecar("{}")) .toThrow("invalid sidecar");
  });

  it("migrates v0 pages to schema v1 with default rotation", () => {
    const migrated = new MigrationManager().migrate({ version: 0, pdf: { id: "doc", path: "a.pdf" }, pages: [{ page: 1, width: 100, height: 200, strokes: [stroke] }] }, "now");
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.pages[0]?.rotation).toBe(0);
    expect(migrated.pages[0]?.strokes).toEqual([stroke]);
  });

  it("uses fingerprint/content hash identity across renames and path fallback otherwise", () => {
    expect(createDocumentIdentity({ vaultPath: "old.pdf", fingerprint: "fp" }).id).toBe(createDocumentIdentity({ vaultPath: "new.pdf", fingerprint: "fp" }).id);
    expect(createDocumentIdentity({ vaultPath: "old.pdf" }).id).not.toBe(createDocumentIdentity({ vaultPath: "new.pdf" }).id);
  });

  it("prefers the newer sidecar or recovery snapshot when both exist", () => {
    const older = sidecar();
    const newer = sidecar();
    newer.updatedAt = "2026-02-01";
    expect(pickNewerSidecar(older, newer)).toBe(newer);
    expect(pickNewerSidecar(newer, older)).toBe(newer);
    expect(pickNewerSidecar(older, null)).toBe(older);
    expect(pickNewerSidecar(null, newer)).toBe(newer);
  });

  it("falls back to copy-and-replace when the adapter rename fails", async () => {
    const files = new MemoryFiles(); const repository = new SidecarRepository(files, "annotations");
    await repository.save(sidecar());
    const original = await files.read("annotations/doc.json");
    files.failRename = true;
    const changed = sidecar(); changed.updatedAt = "later";
    await repository.save(changed);
    expect(await files.read("annotations/doc.json")).not.toBe(original);
    expect((await repository.load("doc"))?.updatedAt).toBe("later");
    expect(files.data.has("annotations/doc.json.tmp")).toBe(false);
  });
});

