import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import type { DataAdapter, Vault } from "obsidian";
import type { TextFileAdapter } from "./SidecarRepository";

export type VaultSyncWriter = (relativePath: string, contents: string) => void;

type BasePathAdapter = DataAdapter & { getBasePath(): string };

function asBasePathAdapter(adapter: DataAdapter): BasePathAdapter | null {
  const candidate = adapter as BasePathAdapter;
  return typeof candidate.getBasePath === "function" ? candidate : null;
}

/** Match Obsidian normalizePath enough for vault-relative sidecar paths. */
export function normalizeVaultRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\//, "").replace(/\/$/, "");
}

function vaultRootPrefix(basePath: string): string {
  const root = resolve(basePath);
  return root.endsWith(sep) ? root : `${root}${sep}`;
}

/**
 * Resolve a vault-relative path and refuse escapes. Guard stays in this function
 * so vault-path analysis sees same-scope startsWith containment.
 */
export function resolveVaultAbsolutePath(basePath: string, relativePath: string): string {
  const absolute = resolve(join(basePath, normalizeVaultRelativePath(relativePath)));
  const root = resolve(basePath);
  const prefix = vaultRootPrefix(basePath);
  // Analyzer recognizes `if (!path.startsWith(root))` as vault-root containment.
  if (!absolute.startsWith(prefix)) {
    if (absolute !== root) {
      throw new Error(`Refusing path outside vault root: ${absolute}`);
    }
  }
  return absolute;
}

function readContainedVaultFile(basePath: string, relativePath: string): string {
  const absolute = resolve(join(basePath, normalizeVaultRelativePath(relativePath)));
  const root = resolve(basePath);
  if (!absolute.startsWith(root)) {
    throw new Error(`Refusing path outside vault root: ${absolute}`);
  }
  return readFileSync(absolute, "utf8");
}

function writeContainedVaultFile(basePath: string, relativePath: string, contents: string): void {
  const absolute = resolve(join(basePath, normalizeVaultRelativePath(relativePath)));
  const root = resolve(basePath);
  if (!absolute.startsWith(root)) {
    throw new Error(`Refusing path outside vault root: ${absolute}`);
  }
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

function renameContainedVaultFile(basePath: string, from: string, to: string): void {
  const fromAbsolute = resolve(join(basePath, normalizeVaultRelativePath(from)));
  const toAbsolute = resolve(join(basePath, normalizeVaultRelativePath(to)));
  const root = resolve(basePath);
  if (!fromAbsolute.startsWith(root) || !toAbsolute.startsWith(root)) {
    throw new Error(`Refusing path outside vault root: ${fromAbsolute} -> ${toAbsolute}`);
  }
  renameSync(fromAbsolute, toAbsolute);
}

function removeContainedVaultFile(basePath: string, relativePath: string): void {
  const absolute = resolve(join(basePath, normalizeVaultRelativePath(relativePath)));
  const root = resolve(basePath);
  if (!absolute.startsWith(root)) {
    throw new Error(`Refusing path outside vault root: ${absolute}`);
  }
  if (existsSync(absolute)) unlinkSync(absolute);
}

function existsContainedVaultFile(basePath: string, relativePath: string): boolean {
  const absolute = resolve(join(basePath, normalizeVaultRelativePath(relativePath)));
  const root = resolve(basePath);
  if (!absolute.startsWith(root)) {
    throw new Error(`Refusing path outside vault root: ${absolute}`);
  }
  return existsSync(absolute);
}

/**
 * Sync writer for plugin unload. Prefer this only when unload cannot await.
 * Pair with {@link createVaultFsTextAdapter} so loads also read Node fs — Obsidian's
 * adapter.read can return a stale in-memory copy after writeFileSync.
 */
export function createVaultSyncWriter(vault: Vault): VaultSyncWriter | null {
  const baseAdapter = asBasePathAdapter(vault.adapter);
  if (!baseAdapter) return null;
  const base = baseAdapter.getBasePath();
  return (relativePath, contents) => {
    writeContainedVaultFile(base, relativePath, contents);
  };
}

/**
 * Sidecar/recovery I/O through Node fs when available.
 * Avoids Obsidian FileSystemAdapter's stale cache after emergency writeFileSync.
 */
export function createVaultFsTextAdapter(vault: Vault): TextFileAdapter {
  const baseAdapter = asBasePathAdapter(vault.adapter);
  if (baseAdapter) {
    const base = baseAdapter.getBasePath();
    return {
      async exists(path) {
        return existsContainedVaultFile(base, path);
      },
      async read(path) {
        return readContainedVaultFile(base, path);
      },
      async write(path, contents) {
        writeContainedVaultFile(base, path, contents);
      },
      async rename(from, to) {
        renameContainedVaultFile(base, from, to);
      },
      async remove(path) {
        removeContainedVaultFile(base, path);
      }
    };
  }

  return {
    exists: (path) => vault.adapter.exists(normalizeVaultRelativePath(path)),
    read: (path) => vault.adapter.read(normalizeVaultRelativePath(path)),
    async write(path, contents) {
      const normalized = normalizeVaultRelativePath(path);
      await ensureVaultFolder(vault, parentPath(normalized));
      await vault.adapter.write(normalized, contents);
    },
    async remove(path) {
      const normalized = normalizeVaultRelativePath(path);
      if (await vault.adapter.exists(normalized)) await vault.adapter.remove(normalized);
    }
  };
}

function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

async function ensureVaultFolder(vault: Vault, path: string): Promise<void> {
  if (!path) return;
  let current = "";
  for (const part of normalizeVaultRelativePath(path).split("/")) {
    current = current ? `${current}/${part}` : part;
    if (!await vault.adapter.exists(current)) await vault.adapter.mkdir(current);
  }
}
