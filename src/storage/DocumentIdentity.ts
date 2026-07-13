import type { SidecarDocumentIdentity } from "./SidecarSchema";

export interface DocumentIdentityInput {
  vaultPath: string;
  fingerprint?: string;
  contentHash?: string;
}

export function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export function createDocumentIdentity(input: DocumentIdentityInput): SidecarDocumentIdentity {
  const vaultPath = normalizeVaultPath(input.vaultPath);
  const stableSource = input.contentHash
    ? `content:${input.contentHash}`
    : input.fingerprint ? `fingerprint:${input.fingerprint}` : `path:${vaultPath}`;
  return {
    id: `pdf-${fnv1a64(stableSource)}`,
    vaultPath,
    ...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
    ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash })
  };
}

