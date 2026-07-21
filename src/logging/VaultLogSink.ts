export type VaultLogLevel = "info" | "warn" | "error";

export interface VaultLogSink {
  write(level: VaultLogLevel, event: string, payload?: Record<string, unknown>): void;
  /** Optional immediate flush — used for crash breadcrumbs on Obsidian Mobile. */
  writeUrgent?(level: VaultLogLevel, event: string, payload?: Record<string, unknown>): Promise<void>;
}
