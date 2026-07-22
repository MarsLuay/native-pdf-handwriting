import { describe, expect, it, vi } from "vitest";
import { ViewerMousePan, type MousePanPhase } from "../src/input/ViewerMousePan";

function pointer(type: string, target: EventTarget, x: number, y: number, pointerId = 4, pointerType: "mouse" | "pen" | "touch" = "mouse"): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    pointerId: { value: pointerId },
    buttons: { value: type === "pointerup" ? 0 : 1 }
  });
  return event as unknown as PointerEvent;
}

describe("viewer mouse pan", () => {
  it("scrolls from the viewer root in capture phase when draw mode is off", () => {
    const viewer = document.createElement("div");
    viewer.className = "pdf-viewer";
    const page = document.createElement("div");
    page.className = "page";
    const canvas = document.createElement("canvas");
    page.append(canvas);
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });

    let scrollTop = 100;
    const scroller = document.createElement("div");
    scroller.className = "pdf-viewer-scroll-container";
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    const pan = new ViewerMousePan(document, {
      enabled: () => true,
      scrollRoot: () => scroller,
      withinTarget: (target) => target instanceof Node && scroller.contains(target),
      captureElement: () => scroller
    });
    Object.assign(scroller, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });

    scroller.append(page);
    document.body.append(scroller);

    canvas.dispatchEvent(pointer("pointerdown", canvas, 40, 100));
    canvas.dispatchEvent(pointer("pointermove", canvas, 40, 140));
    expect(scrollTop).toBe(60);
    pan.destroy();
    scroller.remove();
  });

  it("keeps native text selection when mouse starts on selectable pdf text", () => {
    let scrollTop = 100;
    const phases: MousePanPhase[] = [];
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    const span = document.createElement("span");
    span.textContent = "Hello";
    textLayer.append(span);
    scroller.append(textLayer);
    document.body.append(scroller);
    Object.assign(span, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
    Object.assign(scroller, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });

    const pan = new ViewerMousePan(document, {
      enabled: () => true,
      scrollRoot: () => scroller,
      withinTarget: (target) => target instanceof Node && scroller.contains(target),
      captureElement: () => scroller,
      onPan: (phase) => { phases.push(phase); }
    });

    span.dispatchEvent(pointer("pointerdown", span, 40, 100));
    span.dispatchEvent(pointer("pointermove", span, 40, 140));
    expect(scrollTop).toBe(100);
    expect(phases).toContain("skip");
    expect(phases).not.toContain("start");
    pan.destroy();
    scroller.remove();
  });

  it("still pans with finger when starting on selectable pdf text", () => {
    let scrollTop = 100;
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    const span = document.createElement("span");
    span.textContent = "Hello";
    textLayer.append(span);
    scroller.append(textLayer);
    document.body.append(scroller);
    Object.assign(span, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });

    const pan = new ViewerMousePan(document, {
      enabled: () => false,
      touchPanEnabled: () => true,
      scrollRoot: () => scroller,
      withinTarget: (target) => target instanceof Node && scroller.contains(target),
      captureElement: () => scroller
    });

    span.dispatchEvent(pointer("pointerdown", span, 40, 100, 11, "touch"));
    span.dispatchEvent(pointer("pointermove", span, 40, 140, 11, "touch"));
    expect(scrollTop).toBe(60);
    pan.destroy();
    scroller.remove();
  });

  it("emits probe and cancel phases for click diagnostics", () => {
    const phases: MousePanPhase[] = [];
    let scrollTop = 0;
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    const canvas = document.createElement("canvas");
    scroller.append(canvas);
    document.body.append(scroller);
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });
    Object.assign(scroller, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });

    const pan = new ViewerMousePan(document, {
      enabled: () => true,
      scrollRoot: () => scroller,
      withinTarget: (target) => target instanceof Node && scroller.contains(target),
      captureElement: () => scroller,
      onPan: (phase) => { phases.push(phase); }
    });

    canvas.dispatchEvent(pointer("pointerdown", canvas, 40, 100));
    canvas.dispatchEvent(pointer("pointerup", canvas, 40, 100));
    expect(phases).toContain("probe");
    expect(phases).toContain("start");
    expect(phases).toContain("cancel");
    pan.destroy();
    scroller.remove();
  });

  it("scrolls on stylus tip drag when draw mode is off", () => {
    let scrollTop = 100;
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    const canvas = document.createElement("canvas");
    scroller.append(canvas);
    document.body.append(scroller);
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });

    const pan = new ViewerMousePan(document, {
      enabled: () => true,
      scrollRoot: () => scroller,
      withinTarget: (target) => target instanceof Node && scroller.contains(target),
      captureElement: () => scroller
    });

    canvas.dispatchEvent(pointer("pointerdown", canvas, 40, 100, 7, "pen"));
    canvas.dispatchEvent(pointer("pointermove", canvas, 40, 140, 7, "pen"));
    expect(scrollTop).toBe(60);
    pan.destroy();
    scroller.remove();
  });

  it("defers mouse capture until the drag activates", () => {
    const setPointerCapture = vi.fn();
    let scrollTop = 100;
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    const canvas = document.createElement("canvas");
    scroller.append(canvas);
    document.body.append(scroller);
    Object.assign(canvas, { setPointerCapture, hasPointerCapture: () => true, releasePointerCapture: vi.fn() });

    const pan = new ViewerMousePan(document, {
      enabled: () => true,
      scrollRoot: () => scroller,
      withinTarget: (target) => target instanceof Node && scroller.contains(target),
      captureElement: () => scroller
    });

    canvas.dispatchEvent(pointer("pointerdown", canvas, 40, 100));
    expect(setPointerCapture).not.toHaveBeenCalled();
    canvas.dispatchEvent(pointer("pointermove", canvas, 40, 140));
    expect(setPointerCapture).toHaveBeenCalled();
    expect(scrollTop).toBe(60);
    pan.destroy();
    scroller.remove();
  });

  it("pans mouse horizontally after a vertical drag activates", () => {
    let scrollTop = 100;
    let scrollLeft = 50;
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollWidth", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientWidth", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    Object.defineProperty(scroller, "scrollLeft", {
      get: () => scrollLeft,
      set: (value: number) => { scrollLeft = value; }
    });
    scroller.scrollBy = ((x: number, y: number) => {
      scrollLeft += x;
      scrollTop += y;
    }) as typeof scroller.scrollBy;
    const canvas = document.createElement("canvas");
    scroller.append(canvas);
    document.body.append(scroller);
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });

    const pan = new ViewerMousePan(document, {
      enabled: () => true,
      scrollRoot: () => scroller,
      withinTarget: (target) => target instanceof Node && scroller.contains(target),
      captureElement: () => scroller
    });

    canvas.dispatchEvent(pointer("pointerdown", canvas, 40, 100));
    canvas.dispatchEvent(pointer("pointermove", canvas, 40, 140));
    expect(scrollTop).toBe(60);
    canvas.dispatchEvent(pointer("pointermove", canvas, 10, 140));
    expect(scrollLeft).toBe(80);
    pan.destroy();
    scroller.remove();
  });

  it("pans with one finger when touch pan is enabled even if mouse drag-scroll is off", () => {
    let scrollTop = 100;
    let scrollLeft = 50;
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollWidth", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientWidth", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    Object.defineProperty(scroller, "scrollLeft", {
      get: () => scrollLeft,
      set: (value: number) => { scrollLeft = value; }
    });
    scroller.scrollBy = ((x: number, y: number) => {
      scrollLeft += x;
      scrollTop += y;
    }) as typeof scroller.scrollBy;
    const canvas = document.createElement("canvas");
    scroller.append(canvas);
    document.body.append(scroller);
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });

    const pan = new ViewerMousePan(document, {
      enabled: () => false,
      touchPanEnabled: () => true,
      scrollRoot: () => scroller,
      withinTarget: (target) => target instanceof Node && scroller.contains(target),
      captureElement: () => scroller
    });

    canvas.dispatchEvent(pointer("pointerdown", canvas, 40, 100, 9, "touch"));
    canvas.dispatchEvent(pointer("pointermove", canvas, 10, 140, 9, "touch"));
    // Grab feel: finger down/left → page follows → scrollTop down, scrollLeft up.
    expect(scrollTop).toBe(60);
    expect(scrollLeft).toBe(80);
    pan.destroy();
    scroller.remove();
  });

  it("does not pan with finger when touch pan is disabled (draw mode)", () => {
    let scrollTop = 100;
    const phases: MousePanPhase[] = [];
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    const canvas = document.createElement("canvas");
    scroller.append(canvas);
    document.body.append(scroller);
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });

    const pan = new ViewerMousePan(document, {
      enabled: () => false,
      touchPanEnabled: () => false,
      scrollRoot: () => scroller,
      withinTarget: (target) => target instanceof Node && scroller.contains(target),
      captureElement: () => scroller,
      onPan: (phase) => { phases.push(phase); }
    });

    canvas.dispatchEvent(pointer("pointerdown", canvas, 40, 100, 9, "touch"));
    canvas.dispatchEvent(pointer("pointermove", canvas, 40, 140, 9, "touch"));
    expect(scrollTop).toBe(100);
    expect(phases).toContain("skip");
    expect(phases).not.toContain("activate");
    pan.destroy();
    scroller.remove();
  });

  it("aborts one-finger pan when a second finger lands", () => {
    let scrollTop = 100;
    const phases: MousePanPhase[] = [];
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; }
    });
    const canvas = document.createElement("canvas");
    scroller.append(canvas);
    document.body.append(scroller);
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() });

    const pan = new ViewerMousePan(document, {
      enabled: () => false,
      touchPanEnabled: () => true,
      scrollRoot: () => scroller,
      withinTarget: (target) => target instanceof Node && scroller.contains(target),
      captureElement: () => scroller,
      onPan: (phase) => { phases.push(phase); }
    });

    canvas.dispatchEvent(pointer("pointerdown", canvas, 40, 100, 1, "touch"));
    canvas.dispatchEvent(pointer("pointermove", canvas, 40, 140, 1, "touch"));
    expect(scrollTop).toBe(60);
    canvas.dispatchEvent(pointer("pointerdown", canvas, 80, 100, 2, "touch"));
    expect(phases).toContain("abort");
    const after = scrollTop;
    canvas.dispatchEvent(pointer("pointermove", canvas, 40, 180, 1, "touch"));
    expect(scrollTop).toBe(after);
    pan.destroy();
    scroller.remove();
  });
});
