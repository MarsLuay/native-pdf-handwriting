import type { DataAdapter, Vault } from "obsidian";
import type { TextFileAdapter } from "./SidecarRepository";

export type VaultSyncWriter = (relativePath: string, contents: string) => void;

/** Match Obsidian normalizePath enough for vault-relative sidecar paths. */
export function normalizeVaultRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\//, "").replace(/\/$/, "");
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

/**
 * Resolve a vault-relative path and refuse escapes (string-only; no Node path/fs).
 * Kept for unit tests of containment logic.
 */
export function resolveVaultAbsolutePath(basePath: string, relativePath: string): string {
  const normalizedBase = basePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const relative = normalizeVaultRelativePath(relativePath);
  const parts = relative.split("/").filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) {
        throw new Error(`Refusing path outside vault root: ${relativePath}`);
      }
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `${normalizedBase}/${stack.join("/")}`;
}

type MutableAdapter = DataAdapter & {
  write: (path: string, data: string) => Promise<void>;
  read: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  remove: (path: string) => Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
};

/**
 * Sync unload writer using only the Obsidian vault adapter (no Node `fs`).
 * Fire-and-forget write; prefer normal async saves while the plugin is alive.
 */
export function createVaultSyncWriter(vault: Vault): VaultSyncWriter | null {
  const adapter = vault.adapter as MutableAdapter;
  if (typeof adapter.write !== "function") return null;
  return (relativePath, contents) => {
    const normalized = normalizeVaultRelativePath(relativePath);
    void (async () => {
      await ensureVaultFolder(vault, parentPath(normalized));
      await adapter.write(normalized, contents);
    })().catch(() => undefined);
  };
}

/** Sidecar/recovery I/O via Obsidian DataAdapter only (mobile-safe, catalog-safe). */
export function createVaultFsTextAdapter(vault: Vault): TextFileAdapter {
  const adapter = vault.adapter as MutableAdapter;
  return {
    exists: (path) => adapter.exists(normalizeVaultRelativePath(path)),
    read: (path) => adapter.read(normalizeVaultRelativePath(path)),
    async write(path, contents) {
      const normalized = normalizeVaultRelativePath(path);
      await ensureVaultFolder(vault, parentPath(normalized));
      await adapter.write(normalized, contents);
    },
    async rename(from, to) {
      const src = normalizeVaultRelativePath(from);
      const dest = normalizeVaultRelativePath(to);
      if (typeof adapter.rename === "function") {
        try {
          await ensureVaultFolder(vault, parentPath(dest));
          await adapter.rename(src, dest);
          return;
        } catch {
          // Some mobile adapters expose rename but do not support it for sidecar files.
        }
      }
      const contents = await adapter.read(src);
      await ensureVaultFolder(vault, parentPath(dest));
      await adapter.write(dest, contents);
      if (await adapter.exists(src)) await adapter.remove(src);
    },
    async remove(path) {
      const normalized = normalizeVaultRelativePath(path);
      if (await adapter.exists(normalized)) await adapter.remove(normalized);
    }
  };
}
