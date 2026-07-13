import { describe, expect, it, vi } from "vitest";
import { PointerRouter } from "../src/input/PointerRouter";
import type { ToolId } from "../src/model";

function pointer(type: string, pointerId: number, extra: Record<string, unknown> = {}): PointerEvent {
  const event = new Event(extra.eventType as string || "pointerdown", { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: type }, pointerId: { value: pointerId }, button: { value: extra.button ?? 0 },
    buttons: { value: extra.buttons ?? 1 }, pressure: { value: extra.pressure ?? 0.5 },
    tiltX: { value: extra.tiltX ?? 0 }, tiltY: { value: extra.tiltY ?? 0 },
    width: { value: extra.width ?? 1 }, height: { value: extra.height ?? 1 },
    clientX: { value: extra.clientX ?? 10 }, clientY: { value: extra.clientY ?? 20 },
    getCoalescedEvents: { value: extra.getCoalescedEvents ?? (() => []) }
  });
  return event;
}

describe("PointerRouter", () => {
  it("preserves native touch/mouse defaults and captures only routed ink", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const captures: number[] = [];
    Object.assign(element, {
      setPointerCapture: (id: number) => captures.push(id),
      hasPointerCapture: (id: number) => captures.includes(id),
      releasePointerCapture: vi.fn()
    });
    let tool: ToolId = "pan";
    const starts = vi.fn();
    const routes: string[] = [];
    const router = new PointerRouter(element, { activeTool: () => tool, onStart: starts, onRoute: (route) => routes.push(route) });

    const touch = pointer("touch", 1);
    element.dispatchEvent(touch);
    expect(touch.defaultPrevented).toBe(false);
    expect(routes.at(-1)).toBe("touch-pan");

    const mouse = pointer("mouse", 2);
    element.dispatchEvent(mouse);
    expect(mouse.defaultPrevented).toBe(false);
    expect(routes.at(-1)).toBe("native");

    tool = "pen";
    const pen = pointer("pen", 3, { pressure: 0.8, tiltX: 12 });
    element.dispatchEvent(pen);
    expect(pen.defaultPrevented).toBe(true);
    expect(captures).toEqual([3]);
    expect(starts.mock.calls[0]?.[0][0]).toMatchObject({ pressure: 0.8, tiltX: 12, pointerType: "pen" });
    router.destroy();
  });

  it("classifies a second finger as zoom/pan without intercepting it", () => {
    const element = document.createElement("div");
    const routes: string[] = [];
    const router = new PointerRouter(element, { activeTool: () => "pen", onRoute: (route) => routes.push(route) });
    const first = pointer("touch", 10);
    const second = pointer("touch", 11);
    element.dispatchEvent(first);
    element.dispatchEvent(second);
    expect(routes).toEqual(["touch-pan", "touch-zoom-pan"]);
    expect(first.defaultPrevented).toBe(false);
    expect(second.defaultPrevented).toBe(false);
    router.destroy();
  });

  it("delivers coalesced samples", () => {
    const element = document.createElement("div");
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const onMove = vi.fn();
    const router = new PointerRouter(element, { activeTool: () => "pencil", onMove });
    element.dispatchEvent(pointer("pen", 4));
    const a = pointer("pen", 4, { pressure: 0.2 });
    const b = pointer("pen", 4, { pressure: 0.9 });
    const move = pointer("pen", 4, { eventType: "pointermove", getCoalescedEvents: () => [a, b] });
    element.dispatchEvent(move);
    expect(onMove.mock.calls[0]?.[0].map((sample: { pressure: number }) => sample.pressure)).toEqual([0.2, 0.9]);
    router.destroy();
  });
});
