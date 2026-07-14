import { describe, expect, it, vi } from "vitest";
import { SessionLogger } from "../src/logging/SessionLogger";

describe("SessionLogger", () => {
  it("logs zoom in and zoom out with scale deltas", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.viewState({ pageNumber: 1, scrollFraction: 0, scale: 1, rotation: 0 }, "scalechanging");
    logger.viewState({ pageNumber: 1, scrollFraction: 0, scale: 1.25, rotation: 0 }, "scalechanging");
    logger.viewState({ pageNumber: 1, scrollFraction: 0, scale: 1, rotation: 0 }, "data-scale");

    expect(debug).toHaveBeenCalledTimes(3);
    expect(debug.mock.calls[0]?.[1]).toBe("pdf zoom");
    expect(debug.mock.calls[0]?.[2]).toMatchObject({ action: "view-change", source: "scalechanging", scale: 1 });
    expect(debug.mock.calls[1]?.[2]).toMatchObject({ action: "zoom-in", previousScale: 1, scale: 1.25 });
    expect(debug.mock.calls[2]?.[2]).toMatchObject({ action: "zoom-out", previousScale: 1.25, scale: 1, source: "data-scale" });
    debug.mockRestore();
  });

  it("logs draw positions with bounds", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.draw({
      phase: "end",
      page: 1,
      tool: "pen",
      displayScale: 1.5,
      points: [{ x: 10, y: 20 }, { x: 30, y: 40 }]
    });

    expect(debug).toHaveBeenCalledOnce();
    expect(debug.mock.calls[0]?.[1]).toBe("draw position");
    expect(debug.mock.calls[0]?.[2]).toMatchObject({
      phase: "end",
      page: 1,
      pointCount: 2,
      bounds: { minX: 10, minY: 20, maxX: 30, maxY: 40 }
    });
    debug.mockRestore();
  });

  it("logs zoom tick deferral and repaint timing", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.zoomTick({ reason: "view-scalechanging", tick: 1, scale: 1 });
    logger.zoomTick({ reason: "view-scalechanging", tick: 2, scale: 1.1 });
    logger.zoomRepaint({
      reason: "view-scalechanging",
      durationMs: 4.2,
      pagesRepainted: 2,
      canvasesResized: 2,
      strokesRedrawn: 18,
      skippedDisconnected: 0,
      burstTicks: 2,
      burstDurationMs: 180,
      scaleStart: 1,
      scaleEnd: 1.1,
      scale: 1.1
    });

    expect(debug.mock.calls.some((call) => call[1] === "ink zoom tick")).toBe(true);
    expect(debug.mock.calls.some((call) => call[1] === "ink zoom repaint")).toBe(true);
    const repaint = debug.mock.calls.find((call) => call[1] === "ink zoom repaint");
    expect(repaint?.[2]).toMatchObject({
      burstTicks: 2,
      pagesRepainted: 2,
      canvasesResized: 2,
      strokesRedrawn: 18,
      repaintsPerSec: expect.any(Number)
    });
    debug.mockRestore();
  });

  it("logs refresh bursts and lasso selection", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    for (let index = 0; index < 12; index += 1) logger.refresh("resize");
    logger.lassoSelection(1, 3, 48, "freeform");
    logger.loopBlocked("refresh", 4);

    expect(debug.mock.calls.some((call) => call[1] === "session refresh")).toBe(true);
    expect(debug.mock.calls.some((call) => call[1] === "lasso selection")).toBe(true);
    expect(warn.mock.calls.some((call) => call[1] === "refresh storm")).toBe(true);
    expect(warn.mock.calls.some((call) => call[1] === "loop blocked")).toBe(true);
    debug.mockRestore();
    warn.mockRestore();
  });

  it("logs mouse pan probes and throttles move events", () => {
    const writes: Array<Record<string, unknown>> = [];
    const vaultLog = { write: (_level: string, _event: string, payload: Record<string, unknown>) => { writes.push(payload); } };
    const logger = new SessionLogger("Notes/example.pdf", vaultLog);

    logger.mousePan("probe", { inBoundary: true, enabled: true });
    logger.mousePan("start", { target: "canvas" });
    for (let index = 0; index < 10; index += 1) {
      logger.mousePan("move", { deltaY: 4, changed: true });
    }

    const moves = writes.filter((entry) => entry.phase === "move");
    expect(writes.some((entry) => entry.phase === "probe")).toBe(true);
    expect(moves.length).toBeLessThan(10);
    expect(moves.length).toBeGreaterThan(0);
  });

  it("logs every pointer route and raw pointer seen types", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.pointerRoute("touch-pan", { pointerType: "touch", page: 1 });
    logger.pointerRoute("ignored", { pointerType: "touch", page: 1 });
    logger.pointerSeen({ source: "pointerdown", pointerType: "pen", within: true });
    logger.pointerSeen({ source: "touchstart", pointerType: "touch", within: true });

    expect(debug.mock.calls.some((call) => call[1] === "pointer route" && (call[2] as { route: string }).route === "touch-pan")).toBe(true);
    expect(debug.mock.calls.some((call) => call[1] === "pointer seen" && (call[2] as { pointerType: string }).pointerType === "touch")).toBe(true);
    debug.mockRestore();
  });
});
