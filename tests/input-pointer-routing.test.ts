import { describe, expect, it, vi } from "vitest";
import { isStylusEraserInput, PointerRouter } from "../src/input/PointerRouter";
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
    expect(pen.defaultPrevented).toBe(true);
    expect(routes.at(-1)).toBe("native");

    const penMove = pointer("pen", 3, { eventType: "pointermove" });
    element.dispatchEvent(penMove);
    expect(penMove.defaultPrevented).toBe(true);

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
    expect(second.defaultPrevented).toBe(true);
    router.destroy();
  });

  it("blocks one touch without annotation when the single-touch mode is None", () => {
    const element = document.createElement("div");
    const starts = vi.fn();
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      singleTouchMode: () => "none",
      onStart: starts,
      onRoute: (route) => routes.push(route)
    });
    const touch = pointer("touch", 19);

    element.dispatchEvent(touch);

    expect(routes).toEqual(["touch-stylus"]);
    expect(touch.defaultPrevented).toBe(true);
    expect(starts).not.toHaveBeenCalled();
    router.destroy();
  });

  it("routes one touch as the selected stylus tool and cancels it for a second touch", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const cancels = vi.fn();
    const textInput = vi.fn();
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "text",
      drawingEnabled: () => true,
      singleTouchMode: () => "stylus",
      onCancel: cancels,
      onTextInput: textInput,
      onRoute: (route) => routes.push(route)
    });

    const first = pointer("touch", 20);
    const second = pointer("touch", 21);
    element.dispatchEvent(first);
    element.dispatchEvent(second);

    expect(routes).toEqual(["text", "touch-zoom-pan"]);
    expect(cancels).not.toHaveBeenCalled();
    expect(textInput).toHaveBeenCalledWith(first);
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    router.destroy();
  });

  it("starts a Pen stroke from one touch when stylus touch mode is enabled", () => {
    const element = document.createElement("div");
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const starts = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      singleTouchMode: () => "stylus",
      onStart: starts
    });

    const touch = pointer("touch", 24, { pressure: 0.7 });
    element.dispatchEvent(touch);

    expect(touch.defaultPrevented).toBe(true);
    expect(starts).toHaveBeenCalledWith(expect.any(Array), "draw", touch);
    expect(starts.mock.calls[0]?.[0][0]).toMatchObject({ pointerType: "touch", pressure: 0.7 });
    router.destroy();
  });

  it("keeps the native one-touch stream available for stylus routing", () => {
    const parent = document.createElement("div");
    const element = document.createElement("div");
    parent.append(element);
    document.body.append(parent);
    const parentTouch = vi.fn();
    parent.addEventListener("touchstart", parentTouch);
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      singleTouchMode: () => "stylus"
    }, undefined, element);
    const touchStart = new Event("touchstart", { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(touchStart, "touches", { value: [{ clientX: 10, clientY: 20 }] });

    element.dispatchEvent(touchStart);

    expect(touchStart.defaultPrevented).toBe(false);
    expect(parentTouch).not.toHaveBeenCalled();
    router.destroy();
  });

  it("marks a started touch stroke as multi-touch cancelled when a second finger lands", () => {
    const element = document.createElement("div");
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const cancel = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      singleTouchMode: () => "stylus",
      onCancel: cancel
    });
    const first = pointer("touch", 25);
    const second = pointer("touch", 26);

    element.dispatchEvent(first);
    element.dispatchEvent(second);

    expect(cancel).toHaveBeenCalledWith("draw", second, "multi-touch");
    router.destroy();
  });

  it("treats two-finger distance changes as pinch zoom without scrolling", () => {
    const element = document.createElement("div");
    const pan = vi.fn();
    const pinch = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      singleTouchMode: () => "stylus",
      onPinch: pinch,
      onTwoFingerPan: pan
    }, undefined, element);
    const touch = (type: string, firstX: number, secondX: number, y: number): TouchEvent => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
      Object.defineProperty(event, "touches", { value: [{ clientX: firstX, clientY: y }, { clientX: secondX, clientY: y }] });
      return event;
    };

    element.dispatchEvent(touch("touchstart", 0, 100, 0));
    element.dispatchEvent(touch("touchmove", 10, 130, 20));

    expect(pinch).toHaveBeenCalledWith(1.2, 70, 20);
    expect(pan).not.toHaveBeenCalled();
    router.destroy();
  });

  it("treats a parallel two-finger swipe as scrolling without zooming", () => {
    const element = document.createElement("div");
    const pan = vi.fn();
    const pinch = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      singleTouchMode: () => "stylus",
      onPinch: pinch,
      onTwoFingerPan: pan
    }, undefined, element);
    const touch = (type: string, firstX: number, secondX: number, y: number): TouchEvent => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
      Object.defineProperty(event, "touches", { value: [{ clientX: firstX, clientY: y }, { clientX: secondX, clientY: y }] });
      return event;
    };

    element.dispatchEvent(touch("touchstart", 0, 100, 0));
    element.dispatchEvent(touch("touchmove", 20, 120, 20));

    expect(pan).toHaveBeenCalledWith(20, 20, 70, 20);
    expect(pinch).not.toHaveBeenCalled();
    router.destroy();
  });

  it("respects disabled two-finger zoom and swipe settings", () => {
    const element = document.createElement("div");
    const pan = vi.fn();
    const pinch = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      singleTouchMode: () => "stylus",
      twoFingerPinchZoomEnabled: () => false,
      twoFingerSwipeScrollEnabled: () => false,
      onPinch: pinch,
      onTwoFingerPan: pan
    }, undefined, element);
    const touch = (type: string, firstX: number, secondX: number, y: number): TouchEvent => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
      Object.defineProperty(event, "touches", { value: [{ clientX: firstX, clientY: y }, { clientX: secondX, clientY: y }] });
      return event;
    };

    element.dispatchEvent(touch("touchstart", 0, 100, 0));
    element.dispatchEvent(touch("touchmove", 10, 130, 20));

    expect(pinch).not.toHaveBeenCalled();
    expect(pan).not.toHaveBeenCalled();
    router.destroy();
  });

  it("does not select the eraser or route pen input while drawing is disabled", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const selectEraser = vi.fn();
    const starts = vi.fn();
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => false,
      onStylusEraser: selectEraser,
      onStart: starts,
      onRoute: (route) => routes.push(route)
    });

    const stylus = pointer("pen", 22, { button: 5, buttons: 32 });
    element.dispatchEvent(stylus);

    expect(routes).toEqual(["native"]);
    expect(starts).not.toHaveBeenCalled();
    expect(selectEraser).not.toHaveBeenCalled();
    router.destroy();
  });

  it("routes right mouse input to the eraser only when enabled", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    let rightMouseEraser = false;
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => "pen",
      drawingEnabled: () => true,
      rightMouseEraserEnabled: () => rightMouseEraser,
      onRoute: (route) => routes.push(route)
    });
    const disabled = pointer("mouse", 31, { button: 2, buttons: 2 });
    element.dispatchEvent(disabled);
    expect(routes.at(-1)).toBe("native");
    expect(disabled.defaultPrevented).toBe(false);

    rightMouseEraser = true;
    const enabled = pointer("mouse", 32, { button: 2, buttons: 2 });
    element.dispatchEvent(enabled);
    expect(routes.at(-1)).toBe("edit");
    expect(enabled.defaultPrevented).toBe(true);
    router.destroy();
  });

  it("selects and routes the stylus eraser tip as an edit", () => {
    const element = document.createElement("div");
    document.body.append(element);
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    let tool: ToolId = "pen";
    const selected = vi.fn(() => { tool = "eraser"; });
    const restored = vi.fn(() => { tool = "pencil"; });
    const routes: string[] = [];
    const router = new PointerRouter(element, {
      activeTool: () => tool,
      drawingEnabled: () => true,
      onStylusEraser: selected,
      onStylusEraserEnd: restored,
      onRoute: (route) => routes.push(route)
    });
    const eraser = pointer("pen", 41, { button: 5, buttons: 32 });
    expect(isStylusEraserInput(eraser)).toBe(true);
    element.dispatchEvent(eraser);
    expect(selected).toHaveBeenCalledOnce();
    expect(tool).toBe("eraser");
    expect(routes.at(-1)).toBe("edit");
    expect(eraser.defaultPrevented).toBe(true);
    element.dispatchEvent(pointer("pen", 41, { eventType: "pointerup", button: 5, buttons: 0 }));
    expect(restored).toHaveBeenCalledOnce();
    expect(tool).toBe("pencil");
    router.destroy();
  });

  it("keeps draw-mode stylus events from reaching ancestor swipe handlers", () => {
    const parent = document.createElement("div");
    const element = document.createElement("div");
    const overlay = document.createElement("div");
    element.append(overlay);
    parent.append(element);
    document.body.append(parent);
    Object.assign(element, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    const sidebarSwipe = vi.fn();
    parent.addEventListener("pointerdown", sidebarSwipe);
    parent.addEventListener("pointermove", sidebarSwipe);
    const router = new PointerRouter(element, { activeTool: () => "pen", drawingEnabled: () => true });

    overlay.dispatchEvent(pointer("pen", 22));
    overlay.dispatchEvent(pointer("pen", 22, { eventType: "pointermove" }));

    expect(sidebarSwipe).not.toHaveBeenCalled();
    router.destroy();
    parent.remove();
  });

  it("keeps draw-mode touch events from reaching ancestor gesture handlers", () => {
    const parent = document.createElement("div");
    const element = document.createElement("div");
    const canvas = document.createElement("canvas");
    element.append(canvas);
    parent.append(element);
    document.body.append(parent);
    const quickAction = vi.fn();
    parent.addEventListener("touchstart", quickAction);
    parent.addEventListener("touchmove", quickAction);
    const router = new PointerRouter(element, { activeTool: () => "pen", drawingEnabled: () => true }, undefined, canvas);

    const touchStart = new Event("touchstart", { bubbles: true, cancelable: true });
    const touchMove = new Event("touchmove", { bubbles: true, cancelable: true });
    canvas.dispatchEvent(touchStart);
    canvas.dispatchEvent(touchMove);

    expect(touchStart.defaultPrevented).toBe(true);
    expect(touchMove.defaultPrevented).toBe(true);
    expect(quickAction).not.toHaveBeenCalled();
    router.destroy();
    parent.remove();
  });

  it("reports continuous scale factors and centers from a draw-mode two-finger pinch", () => {
    const element = document.createElement("div");
    const canvas = document.createElement("canvas");
    element.append(canvas);
    document.body.append(element);
    const pinch = vi.fn();
    const router = new PointerRouter(element, { activeTool: () => "pen", drawingEnabled: () => true, onPinch: pinch }, undefined, canvas);
    const touch = (type: string, distance: number): TouchEvent => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
      Object.defineProperty(event, "touches", { value: [{ clientX: 0, clientY: 0 }, { clientX: distance, clientY: 0 }] });
      return event;
    };

    canvas.dispatchEvent(touch("touchstart", 100));
    canvas.dispatchEvent(touch("touchmove", 120));
    canvas.dispatchEvent(touch("touchmove", 90));

    expect(pinch).toHaveBeenNthCalledWith(1, 1.2, 60, 0);
    expect(pinch).toHaveBeenNthCalledWith(2, 0.75, 45, 0);
    router.destroy();
    element.remove();
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

  it("preserves native textarea drag selection while the lasso tool is active", () => {
    const element = document.createElement("div");
    const input = document.createElement("textarea");
    input.className = "native-pdf-handwriting-text-input";
    element.append(input);
    document.body.append(element);
    const onStart = vi.fn();
    const router = new PointerRouter(element, {
      activeTool: () => "lasso",
      drawingEnabled: () => true,
      onStart
    });
    const down = pointer("mouse", 7);
    input.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
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
