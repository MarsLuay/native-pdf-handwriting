import { describe, expect, it } from "vitest";
import type { Vault } from "obsidian";
import { VaultDebugLog } from "../src/logging/VaultDebugLog";

function createVault(): { vault: Vault; files: Map<string, string> } {
  const files = new Map<string, string>();
  const vault = {
    adapter: {
      async exists(path: string) {
        return files.has(path);
      },
      async mkdir() {
        return;
      },
      async write(path: string, data: string) {
        files.set(path, data);
      },
      async append(path: string, data: string) {
        files.set(path, `${files.get(path) ?? ""}${data}`);
      }
    }
  } as unknown as Vault;
  return { vault, files };
}

describe("VaultDebugLog", () => {
  it("flushes all queued events in write order", async () => {
    const { vault, files } = createVault();
    const log = new VaultDebugLog(() => vault, () => "logs/debug.md", () => true);

    log.write("info", "first");
    const firstFlush = log.flush();
    log.write("warn", "second");
    await Promise.all([firstFlush, log.flush()]);

    const events = (files.get("logs/debug.md") ?? "")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string });
    expect(events.map((event) => event.event)).toEqual(["first", "second"]);
  });

  it("persists events accepted before vault logging is disabled", async () => {
    const { vault, files } = createVault();
    let enabled = true;
    const log = new VaultDebugLog(() => vault, () => "debug.md", () => enabled);

    log.write("info", "captured-before-disable");
    enabled = false;
    await log.flush();

    expect(files.get("debug.md")).toContain("captured-before-disable");
  });

  it("merges plugin and Obsidian version context into every event", async () => {
    const { vault, files } = createVault();
    const log = new VaultDebugLog(
      () => vault,
      () => "debug.md",
      () => true,
      () => ({ pluginVersion: "0.1.16", obsidianVersion: "1.8.9" })
    );

    log.write("warn", "session attach failed", { document: "a.pdf" });
    await log.flush();

    const event = JSON.parse((files.get("debug.md") ?? "").trim()) as Record<string, unknown>;
    expect(event).toMatchObject({
      event: "session attach failed",
      pluginVersion: "0.1.16",
      obsidianVersion: "1.8.9",
      document: "a.pdf"
    });
  });

  it("writeUrgent flushes before returning so crash breadcrumbs persist", async () => {
    const { vault, files } = createVault();
    const log = new VaultDebugLog(
      () => vault,
      () => "debug.md",
      () => true,
      () => ({ pluginVersion: "0.1.17" })
    );

    await log.writeUrgent("info", "session attach prepare", { document: "big.pdf" });
    expect(files.get("debug.md")).toContain("session attach prepare");
    expect(files.get("debug.md")).toContain("0.1.17");
  });
});
