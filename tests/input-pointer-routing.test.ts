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
    let drawingEnabled = false;
    const starts = vi.fn();
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => tool,
      drawingEnabled: () => drawingEnabled,
      onStart: starts,
      onRoute: (route) => routes.push(route)
    });

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
    expect(pen.defaultPrevented).toBe(false);
    expect(routes.at(-1)).toBe("native");

    drawingEnabled = true;
    const sidecarPencil = pointer("mouse", 4, { pressure: 0.8, tiltX: 12 });
    element.dispatchEvent(sidecarPencil);
    expect(sidecarPencil.defaultPrevented).toBe(true);
    expect(captures).toEqual([4]);
    expect(starts.mock.calls[0]?.[0][0]).toMatchObject({ pressure: 0.8, tiltX: 12, pointerType: "mouse" });

    const stylus = pointer("pen", 5, { pressure: 0.7 });
    element.dispatchEvent(stylus);
    expect(stylus.defaultPrevented).toBe(true);
    expect(captures).toEqual([4, 5]);
    router.destroy();
  });

  it("classifies a second finger as zoom/pan without intercepting it", () => {
    const element = document.createElement("div");
    const routes: string[] = [];
    const router = new PointerRouter(element, { activeTool: () => "pen", drawingEnabled: () => false, onRoute: (route) => routes.push(route) });
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
    const router = new PointerRouter(element, { activeTool: () => "pencil", drawingEnabled: () => true, onMove });
    element.dispatchEvent(pointer("pen", 4));
    const a = pointer("pen", 4, { pressure: 0.2 });
    const b = pointer("pen", 4, { pressure: 0.9 });
    const move = pointer("pen", 4, { eventType: "pointermove", getCoalescedEvents: () => [a, b] });
    element.dispatchEvent(move);
    expect(onMove.mock.calls[0]?.[0].map((sample: { pressure: number }) => sample.pressure)).toEqual([0.2, 0.9]);
    router.destroy();
  });

  it("cancels routed gestures without committing them", () => {
    const element = document.createElement("div");
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const onEnd = vi.fn();
    const onCancel = vi.fn();
    const router = new PointerRouter(element, { activeTool: () => "eraser", drawingEnabled: () => true, onEnd, onCancel });
    element.dispatchEvent(pointer("pen", 5));
    element.dispatchEvent(pointer("pen", 5, { eventType: "pointercancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onEnd).not.toHaveBeenCalled();
    router.destroy();
  });

  it("shows a circular, scale-adjusted eraser cursor without intercepting hover", () => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () => ({
      x: 100, y: 50, left: 100, top: 50, right: 500, bottom: 650,
      width: 400, height: 600, toJSON: () => ({})
    });
    document.body.append(element);
    const router = new PointerRouter(element, {
      activeTool: () => "eraser",
      drawingEnabled: () => true,
      eraserCursorDiameter: () => 36
    });

    const hover = pointer("mouse", 8, { eventType: "pointermove", clientX: 130, clientY: 90, buttons: 0 });
    element.dispatchEvent(hover);
    const cursor = document.body.querySelector<HTMLElement>(".native-pdf-handwriting-eraser-cursor");
    expect(hover.defaultPrevented).toBe(false);
    expect(cursor).toMatchObject({ hidden: false });
    expect(cursor?.style.width).toBe("36px");
    expect(cursor?.style.height).toBe("36px");
    expect(cursor?.style.left).toBe("130px");
    expect(cursor?.style.top).toBe("90px");
    expect(element.classList.contains("native-pdf-handwriting-has-eraser-cursor")).toBe(true);

    element.dispatchEvent(pointer("touch", 9, { eventType: "pointermove" }));
    expect(cursor?.hidden).toBe(true);
    router.destroy();
    expect(cursor?.isConnected).toBe(false);
  });

  it("shows a small dot cursor for pen, pencil, highlighter, and laser in draw mode", () => {
    const element = document.createElement("div");
    element.getBoundingClientRect = () => ({
      x: 100, y: 50, left: 100, top: 50, right: 500, bottom: 650,
      width: 400, height: 600, toJSON: () => ({})
    });
    document.body.append(element);
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      drawCursorColor: () => "#ff0000"
    });

    const hover = pointer("mouse", 8, { eventType: "pointermove", clientX: 130, clientY: 90, buttons: 0 });
    element.dispatchEvent(hover);
    const cursor = document.body.querySelector<HTMLElement>(".native-pdf-handwriting-draw-cursor");
    expect(hover.defaultPrevented).toBe(false);
    expect(cursor).toMatchObject({ hidden: false });
    expect(cursor?.style.width).toBe("6px");
    expect(cursor?.style.height).toBe("6px");
    expect(cursor?.style.backgroundColor).toBe("rgb(255, 0, 0)");
    expect(cursor?.style.left).toBe("130px");
    expect(cursor?.style.top).toBe("90px");
    expect(element.classList.contains("native-pdf-handwriting-has-draw-cursor")).toBe(true);

    element.dispatchEvent(pointer("touch", 9, { eventType: "pointermove" }));
    expect(cursor?.hidden).toBe(true);
    router.destroy();
    expect(cursor?.isConnected).toBe(false);
  });

  it("routes laser pointer freehand as draw when Draw is on", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn()
    });
    const starts = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "laser",
      drawingEnabled: () => true,
      onStart: starts
    });
    const mouse = pointer("mouse", 42);
    element.dispatchEvent(mouse);
    expect(mouse.defaultPrevented).toBe(true);
    expect(starts).toHaveBeenCalledOnce();
    expect(starts.mock.calls[0]?.[1]).toBe("draw");
    router.destroy();
  });

  it("keeps the eraser cursor anchored to the pointer when the page layout shifts", () => {
    const element = document.createElement("div");
    let left = 100;
    let top = 50;
    element.getBoundingClientRect = () => ({
      x: left, y: top, left, top, right: left + 400, bottom: top + 600,
      width: 400, height: 600, toJSON: () => ({})
    });
    document.body.append(element);
    let diameter = 36;
    const router = new PointerRouter(element, {
      activeTool: () => "eraser",
      drawingEnabled: () => true,
      eraserCursorDiameter: () => diameter
    });

    element.dispatchEvent(pointer("mouse", 8, { eventType: "pointermove", clientX: 130, clientY: 90, buttons: 0 }));
    const cursor = document.body.querySelector<HTMLElement>(".native-pdf-handwriting-eraser-cursor");
    expect(cursor?.style.left).toBe("130px");
    expect(cursor?.style.top).toBe("90px");

    left = 220;
    top = 140;
    diameter = 48;
    router.refreshCursors();
    expect(cursor?.style.left).toBe("130px");
    expect(cursor?.style.top).toBe("90px");
    expect(cursor?.style.width).toBe("48px");
    expect(cursor?.style.height).toBe("48px");
    router.destroy();
  });

  it("ignores pointer gestures that start on the selection toolbar", () => {
    const element = document.createElement("div");
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-handwriting-selection-toolbar";
    const done = document.createElement("button");
    toolbar.append(done);
    element.append(toolbar);
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const onStart = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "lasso",
      drawingEnabled: () => true,
      onStart
    });
    done.dispatchEvent(pointer("mouse", 6));
    expect(onStart).not.toHaveBeenCalled();
    router.destroy();
  });

  it("scrolls vertically on mouse drag when draw mode is off", () => {
    const element = document.createElement("div");
    const scroller = document.createElement("div");
    let scrollTop = 100;
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => false,
      scrollRoot: () => scroller,
      onRoute: (route) => routes.push(route)
    });

    element.dispatchEvent(pointer("mouse", 12, { clientX: 40, clientY: 100 }));
    expect(routes.at(-1)).toBe("mouse-pan");
    element.dispatchEvent(pointer("mouse", 12, { eventType: "pointermove", clientX: 40, clientY: 140 }));
    expect(scrollTop).toBe(60);
    router.destroy();
  });

  it("scrolls vertically on stylus drag when draw mode is off", () => {
    const element = document.createElement("div");
    const scroller = document.createElement("div");
    let scrollTop = 100;
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => false,
      scrollRoot: () => scroller,
      onRoute: (route) => routes.push(route)
    });

    element.dispatchEvent(pointer("pen", 21, { clientX: 40, clientY: 100 }));
    expect(routes.at(-1)).toBe("mouse-pan");
    element.dispatchEvent(pointer("pen", 21, { eventType: "pointermove", clientX: 40, clientY: 140 }));
    expect(scrollTop).toBe(60);
    router.destroy();
  });

  it("keeps native routing over pdf text so selection still works", () => {
    const element = document.createElement("div");
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    const span = document.createElement("span");
    span.textContent = "Selectable";
    textLayer.append(span);
    element.append(textLayer);
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => false,
      scrollRoot: () => document.createElement("div"),
      onRoute: (route) => routes.push(route)
    });
    span.dispatchEvent(pointer("mouse", 13));
    expect(routes.at(-1)).toBe("native");
    router.destroy();
  });

  it("routes mouse pan through empty text layer padding", () => {
    const element = document.createElement("div");
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    element.append(textLayer);
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => false,
      scrollRoot: () => document.createElement("div"),
      onRoute: (route) => routes.push(route)
    });
    textLayer.dispatchEvent(pointer("mouse", 15));
    expect(routes.at(-1)).toBe("mouse-pan");
    router.destroy();
  });

  it("does not scroll when mouse drag scroll is disabled", () => {
    const element = document.createElement("div");
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => false,
      scrollRoot: () => null,
      onRoute: (route) => routes.push(route)
    });
    element.dispatchEvent(pointer("mouse", 14));
    expect(routes.at(-1)).toBe("native");
    router.destroy();
  });
});
