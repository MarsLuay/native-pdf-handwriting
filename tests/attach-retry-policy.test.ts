import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachRetryPolicy } from "../src/runtime/AttachRetryPolicy";
import { ScanDebounce } from "../src/runtime/ScanDebounce";

describe("AttachRetryPolicy", () => {
  it("blocks retries until exponential cooldown elapses", () => {
    const policy = new AttachRetryPolicy();
    const path = "Job/demo.pdf";
    const t0 = 1_000_000;

    expect(policy.canAttempt(path, t0)).toBe(true);
    expect(policy.recordFailure(path, t0)).toBe(1_000);
    expect(policy.canAttempt(path, t0 + 999)).toBe(false);
    expect(policy.canAttempt(path, t0 + 1_000)).toBe(true);

    expect(policy.recordFailure(path, t0 + 1_000)).toBe(2_000);
    expect(policy.canAttempt(path, t0 + 2_999)).toBe(false);
    expect(policy.canAttempt(path, t0 + 3_000)).toBe(true);
  });

  it("caps backoff and clears on success / retainOnly", () => {
    const policy = new AttachRetryPolicy();
    const path = "a.pdf";
    let now = 0;
    let delay = 0;
    for (let i = 0; i < 8; i += 1) {
      delay = policy.recordFailure(path, now);
      now += delay;
    }
    expect(delay).toBe(AttachRetryPolicy.MAX_MS);

    policy.clear(path);
    expect(policy.canAttempt(path, now)).toBe(true);
    expect(policy.msUntilNextRetry(new Set([path]), now)).toBeNull();

    policy.recordFailure(path, now);
    policy.recordFailure("other.pdf", now);
    policy.retainOnly(new Set(["other.pdf"]));
    expect(policy.canAttempt(path, now)).toBe(true);
    expect(policy.canAttempt("other.pdf", now)).toBe(false);
  });


  it("recordHardFailure jumps to max cooldown", () => {
    const policy = new AttachRetryPolicy();
    const path = "mobile.pdf";
    const t0 = 10_000;
    expect(policy.recordHardFailure(path, t0)).toBe(AttachRetryPolicy.MAX_MS);
    expect(policy.canAttempt(path, t0 + AttachRetryPolicy.MAX_MS - 1)).toBe(false);
    expect(policy.canAttempt(path, t0 + AttachRetryPolicy.MAX_MS)).toBe(true);
  });

  it("reports soonest live-path wake-up so short rescans cannot skip backoff", () => {
    const policy = new AttachRetryPolicy();
    const t0 = 5_000;
    policy.recordFailure("slow.pdf", t0); // cool until t0+1000
    expect(policy.msUntilNextRetry(new Set(["slow.pdf"]), t0 + 100)).toBe(900);
    // Layout-style rescan while cooling: still blocked
    expect(policy.canAttempt("slow.pdf", t0 + 100)).toBe(false);
    // Unrelated path with no cooldown stays attemptable
    expect(policy.canAttempt("fresh.pdf", t0 + 100)).toBe(true);
    // Closed path ignored for wake scheduling
    expect(policy.msUntilNextRetry(new Set(["fresh.pdf"]), t0 + 100)).toBeNull();
  });
});

describe("ScanDebounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the soonest wake-up when a longer delay is requested later", () => {
    vi.useFakeTimers();
    const debounce = new ScanDebounce();
    const fires: number[] = [];
    debounce.schedule(1_000, () => fires.push(1));
    debounce.schedule(2_000, () => fires.push(2));
    vi.advanceTimersByTime(999);
    expect(fires).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fires).toEqual([1]);
  });

  it("replaces a later wake-up when an earlier delay is requested", () => {
    vi.useFakeTimers();
    const debounce = new ScanDebounce();
    const fires: number[] = [];
    debounce.schedule(2_000, () => fires.push(1));
    debounce.schedule(200, () => fires.push(2));
    vi.advanceTimersByTime(200);
    expect(fires).toEqual([2]);
    vi.advanceTimersByTime(2_000);
    expect(fires).toEqual([2]);
  });
});
