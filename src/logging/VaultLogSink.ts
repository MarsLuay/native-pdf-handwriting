export type VaultLogLevel = "info" | "warn";

export interface VaultLogSink {
  write(level: VaultLogLevel, event: string, payload?: Record<string, unknown>): void;
}
