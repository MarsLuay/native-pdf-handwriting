import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import { AutosaveQueue, DEFAULT_AUTOSAVE_DELAY_MS } from "../src/storage/AutosaveQueue";
import { SaveCoordinator } from "../src/storage/SaveCoordinator";

describe("autosave", () => {
  it("defaults on with a 750ms queue delay", () => {
    expect(DEFAULT_SETTINGS.autosave).toBe(true);
    expect(DEFAULT_SETTINGS.autosaveDelayMs).toBe(750);
    expect(new AutosaveQueue<string>({ write: async () => undefined }).delayMs).toBe(DEFAULT_AUTOSAVE_DELAY_MS);
  });

  it("debounces completed snapshots", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => undefined);
    const queue = new AutosaveQueue({ write, delayMs: 50 });
    queue.schedule("doc", "one"); queue.schedule("doc", "two");
    await vi.advanceTimersByTimeAsync(49); expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledWith("doc", "two");
    vi.useRealTimers();
  });

  it("serializes writes per document and flushes edits arriving during a save", async () => {
    let release: (() => void) | undefined; let active = 0; let maxActive = 0;
    const written: string[] = [];
    const queue = new AutosaveQueue<string>({ delayMs: 1000, write: async (_id, value) => {
      active += 1; maxActive = Math.max(maxActive, active); written.push(value);
      if (value === "one") await new Promise<void>((resolve) => { release = resolve; });
      active -= 1;
    } });
    queue.schedule("doc", "one"); const first = queue.flush("doc");
    await Promise.resolve(); queue.schedule("doc", "two"); release?.();
    await first; await queue.flush("doc");
    expect(written).toEqual(["one", "two"]); expect(maxActive).toBe(1); expect(queue.getStatus("doc")).toBe("saved");
  });

  it("reports failure, remains dirty, and retries explicitly", async () => {
    let attempts = 0;
    const queue = new AutosaveQueue<string>({ retryFailed: false, write: async () => { attempts += 1; if (attempts === 1) throw new Error("disk"); } });
    queue.schedule("doc", "latest");
    await expect(queue.flush("doc")).rejects.toThrow("disk");
    expect(queue.getStatus("doc")).toBe("failed"); expect(queue.isDirty("doc")).toBe(true);
    await queue.retry("doc"); expect(queue.getStatus("doc")).toBe("saved"); expect(attempts).toBe(2);
  });

  it("flushes all documents on close", async () => {
    const write = vi.fn(async () => undefined); const queue = new AutosaveQueue<string>({ write, delayMs: 1000 });
    queue.schedule("a", "A"); queue.schedule("b", "B"); await queue.close();
    expect(write).toHaveBeenCalledTimes(2); expect(() => queue.schedule("a", "new")).toThrow("closed");
  });

  it("abandon cancels timers and never flushes", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => undefined);
    const queue = new AutosaveQueue<string>({ write, delayMs: 100 });
    queue.schedule("doc", "stale");
    queue.abandon();
    await vi.advanceTimersByTimeAsync(200);
    await queue.flush("doc");
    await queue.close();
    expect(write).not.toHaveBeenCalled();
    expect(queue.isDirty("doc")).toBe(false);
    vi.useRealTimers();
  });

  it("abandon drops an in-flight follow-up drain", async () => {
    let release: (() => void) | undefined;
    const written: string[] = [];
    const queue = new AutosaveQueue<string>({
      delayMs: 1000,
      write: async (_id, value) => {
        written.push(value);
        if (value === "one") await new Promise<void>((resolve) => { release = resolve; });
      }
    });
    queue.schedule("doc", "one");
    const first = queue.flush("doc");
    await Promise.resolve();
    queue.schedule("doc", "two");
    queue.abandon();
    release?.();
    await first;
    await queue.flush("doc");
    expect(written).toEqual(["one"]);
  });
});

describe("manual saving and close decisions", () => {
  it("marks completed commands dirty and schedules non-blocking autosave", () => {
    const scheduleAutosave = vi.fn();
    const coordinator = new SaveCoordinator({ autosave: true, saveWhenClosing: true, save: async () => undefined, scheduleAutosave });
    coordinator.completedCommand();
    expect(coordinator.hasUnsavedChanges()).toBe(true); expect(scheduleAutosave).toHaveBeenCalledOnce();
  });

  it("never silently closes autosave-off dirty state", async () => {
    const save = vi.fn(async () => undefined); const discard = vi.fn();
    const coordinator = new SaveCoordinator({ autosave: false, saveWhenClosing: true, save, discard });
    coordinator.markDirty(); expect(coordinator.closeDecision()).toBe("prompt");
    expect(await coordinator.prepareClose()).toBe(false); expect(save).not.toHaveBeenCalled();
    expect(await coordinator.prepareClose("save")).toBe(true); expect(save).toHaveBeenCalledOnce(); expect(coordinator.hasUnsavedChanges()).toBe(false);
  });

  it("supports explicit discard and autosave close flush", async () => {
    const discard = vi.fn(); const manual = new SaveCoordinator({ autosave: false, saveWhenClosing: false, save: async () => undefined, discard });
    manual.markDirty(); expect(await manual.prepareClose("discard")).toBe(true); expect(discard).toHaveBeenCalledOnce();
    const save = vi.fn(async () => undefined); const automatic = new SaveCoordinator({ autosave: true, saveWhenClosing: true, save });
    automatic.markDirty(); expect(await automatic.prepareClose()).toBe(true); expect(save).toHaveBeenCalledOnce();
  });
});
