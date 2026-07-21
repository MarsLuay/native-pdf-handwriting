import { describe, expect, it, vi } from "vitest";
import {
  emitHnDevProbeDiagnostic,
  HN_DEV_PROBE_ACTIVE_KEY,
  HN_DEV_PROBE_EVENT,
  isHnDevProbeActive,
  type HnDevProbeDiagnostic
} from "../src/runtime/DevProbeDiagnostics";

const diagnostic: HnDevProbeDiagnostic = {
  version: 1,
  source: "handwriting-natively",
  type: "zoom-settled",
  documentId: "pdf-2a339bec1560e409",
  at: 12.5,
  metrics: { ticks: 3, durationMs: 120 }
};

describe("HN Dev Probe diagnostics", () => {
  it("does nothing until the separately installed probe opts in", () => {
    const listener = vi.fn();
    window.addEventListener(HN_DEV_PROBE_EVENT, listener);
    try {
      expect(isHnDevProbeActive(window)).toBe(false);
    } finally {
      window.removeEventListener(HN_DEV_PROBE_EVENT, listener);
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes a small lifecycle payload only when the probe is active", () => {
    const listener = vi.fn();
    window.addEventListener(HN_DEV_PROBE_EVENT, listener);
    try {
      (window as Window & { [HN_DEV_PROBE_ACTIVE_KEY]?: boolean })[HN_DEV_PROBE_ACTIVE_KEY] = true;
      expect(isHnDevProbeActive(window)).toBe(true);
      emitHnDevProbeDiagnostic(window, diagnostic);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0]?.[0]).toMatchObject({ detail: diagnostic });
    } finally {
      delete (window as Window & { [HN_DEV_PROBE_ACTIVE_KEY]?: boolean })[HN_DEV_PROBE_ACTIVE_KEY];
      window.removeEventListener(HN_DEV_PROBE_EVENT, listener);
    }
  });
});
