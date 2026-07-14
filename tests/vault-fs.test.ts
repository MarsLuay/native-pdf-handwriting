import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createVaultFsTextAdapter, createVaultSyncWriter, resolveVaultAbsolutePath } from "../src/storage/VaultFs";
import type { Vault } from "obsidian";

function writeUnderRoot(root: string, relative: string, contents: string): void {
  const absolute = resolve(join(root, relative));
  if (!absolute.startsWith(root)) {
    throw new Error(`Refusing path outside vault root: ${absolute}`);
  }
  writeFileSync(absolute, contents, "utf8");
}

function readUnderRoot(root: string, relative: string): string {
  const absolute = resolve(join(root, relative));
  if (!absolute.startsWith(root)) {
    throw new Error(`Refusing path outside vault root: ${absolute}`);
  }
  return readFileSync(absolute, "utf8");
}

describe("vault fs sidecar I/O", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses paths that escape the vault root", () => {
    expect(() => resolveVaultAbsolutePath("/vault", "../outside.txt")).toThrow(/outside vault root/);
  });

  it("sync writer and fs adapter share disk bytes (no stale adapter cache)", async () => {
    const root = mkdtempSync(join(tmpdir(), "native-pdf-ink-vault-"));
    temps.push(root);
    mkdirSync(join(root, "annotations"), { recursive: true });

    const vault = {
      adapter: { getBasePath: () => root }
    } as unknown as Vault;

    const writeSync = createVaultSyncWriter(vault);
    expect(writeSync).not.toBeNull();
    const files = createVaultFsTextAdapter(vault);

    const path = "annotations/doc.json";
    const stale = JSON.stringify({ updatedAt: "2026-01-01", strokes: 4 });
    const next = JSON.stringify({ updatedAt: "2026-07-13T22:08:34.000Z", strokes: 1 });

    writeUnderRoot(root, path, stale);
    writeSync!(path, next);

    expect(readUnderRoot(root, path)).toBe(next);
    expect(await files.read(path)).toBe(next);

    await files.write(path, JSON.stringify({ updatedAt: "later", strokes: 0 }));
    expect(JSON.parse(await files.read(path)).strokes).toBe(0);
  });
});
