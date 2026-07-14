import { describe, expect, it, vi } from "vitest";
import { SessionLogger } from "../src/logging/SessionLogger";

describe("SessionLogger", () => {
  it("logs zoom in and zoom out with scale deltas", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.viewState({ pageNumber: 1, scrollFraction: 0, scale: 1, rotation: 0 }, "scalechanging");
    logger.viewState({ pageNumber: 1, scrollFraction: 0, scale: 1.25, rotation: 0 }, "scalechanging");
    logger.viewState({ pageNumber: 1, scrollFraction: 0, scale: 1, rotation: 0 }, "data-scale");

    expect(info).toHaveBeenCalledTimes(3);
    expect(info.mock.calls[0]?.[1]).toBe("pdf zoom");
    expect(info.mock.calls[0]?.[2]).toMatchObject({ action: "view-change", source: "scalechanging", scale: 1 });
    expect(info.mock.calls[1]?.[2]).toMatchObject({ action: "zoom-in", previousScale: 1, scale: 1.25 });
    expect(info.mock.calls[2]?.[2]).toMatchObject({ action: "zoom-out", previousScale: 1.25, scale: 1, source: "data-scale" });
    info.mockRestore();
  });

  it("logs draw positions with bounds", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.draw({
      phase: "end",
      page: 1,
      tool: "pen",
      displayScale: 1.5,
      points: [{ x: 10, y: 20 }, { x: 30, y: 40 }]
    });

    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]?.[1]).toBe("draw position");
    expect(info.mock.calls[0]?.[2]).toMatchObject({
      phase: "end",
      page: 1,
      pointCount: 2,
      bounds: { minX: 10, minY: 20, maxX: 30, maxY: 40 }
    });
    info.mockRestore();
  });

  it("logs zoom tick deferral and repaint timing", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
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

    expect(info.mock.calls.some((call) => call[1] === "ink zoom tick")).toBe(true);
    expect(info.mock.calls.some((call) => call[1] === "ink zoom repaint")).toBe(true);
    const repaint = info.mock.calls.find((call) => call[1] === "ink zoom repaint");
    expect(repaint?.[2]).toMatchObject({
      burstTicks: 2,
      pagesRepainted: 2,
      canvasesResized: 2,
      strokesRedrawn: 18,
      repaintsPerSec: expect.any(Number)
    });
    info.mockRestore();
  });

  it("logs refresh bursts and lasso selection", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    for (let index = 0; index < 12; index += 1) logger.refresh("resize");
    logger.lassoSelection(1, 3, 48, "freeform");
    logger.loopBlocked("refresh", 4);

    expect(info.mock.calls.some((call) => call[1] === "session refresh")).toBe(true);
    expect(info.mock.calls.some((call) => call[1] === "lasso selection")).toBe(true);
    expect(warn.mock.calls.some((call) => call[1] === "refresh storm")).toBe(true);
    expect(warn.mock.calls.some((call) => call[1] === "loop blocked")).toBe(true);
    info.mockRestore();
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
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const logger = new SessionLogger("Notes/example.pdf");

    logger.pointerRoute("touch-pan", { pointerType: "touch", page: 1 });
    logger.pointerRoute("ignored", { pointerType: "touch", page: 1 });
    logger.pointerSeen({ source: "pointerdown", pointerType: "pen", within: true });
    logger.pointerSeen({ source: "touchstart", pointerType: "touch", within: true });

    expect(info.mock.calls.some((call) => call[1] === "pointer route" && (call[2] as { route: string }).route === "touch-pan")).toBe(true);
    expect(info.mock.calls.some((call) => call[1] === "pointer seen" && (call[2] as { pointerType: string }).pointerType === "touch")).toBe(true);
    info.mockRestore();
  });
});
