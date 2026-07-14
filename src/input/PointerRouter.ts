import { setElementCssProps } from "../dom/typeGuards";
import type { ToolId } from "../model";
import { scrollPdfBy } from "../integration/PdfScrollRoot";
import { PalmRejectionPolicy } from "./PalmRejectionPolicy";
import { PointerCapabilities, type PointerSample } from "./PointerCapabilities";
import { isSelectablePdfTarget } from "./PdfSelectableTarget";

export type PointerRoute = "draw" | "edit" | "touch-pan" | "touch-zoom-pan" | "mouse-pan" | "native" | "ignored";

export function isAnnotationChromeTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".native-pdf-handwriting-selection-toolbar"));
}

/** Primary tip drag: mouse LMB or stylus tip (not barrel / eraser buttons). */
export function isDragPanPointer(event: Pick<PointerEvent, "pointerType" | "button">): boolean {
  if (event.button !== 0) return false;
  return event.pointerType === "mouse" || event.pointerType === "pen";
}

interface PanGesture {
  startX: number;
  startY: number;
  lastY: number;
  active: boolean;
}

export interface PointerRouterCallbacks {
  activeTool(): ToolId;
  drawingEnabled(): boolean;
  scrollRoot?(): HTMLElement | null;
  cursorParent?(): HTMLElement;
  eraserCursorDiameter?(): number;
  drawCursorColor?(): string;
  projectCursor?(clientX: number, clientY: number): { x: number; y: number } | null;
  onStart?(samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void;
  onMove?(samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void;
  onEnd?(samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void;
  onCancel?(route: "draw" | "edit", event: PointerEvent): void;
  onRoute?(route: PointerRoute, event: PointerEvent): void;
  onMousePan?(phase: "start" | "activate" | "move" | "end" | "abort", event: PointerEvent, details: Record<string, unknown>): void;
}

export class PointerRouter {
  private static readonly DRAW_CURSOR_SIZE_PX = 6;

  private readonly routed = new Map<number, "draw" | "edit">();
  private readonly panning = new Map<number, PanGesture>();
  private readonly touches = new Set<number>();
  private readonly palmPolicy: PalmRejectionPolicy;
  private readonly abort = new AbortController();
  private readonly eraserCursor: HTMLElement;
  private readonly drawCursor: HTMLElement;
  private lastCursorClient: { x: number; y: number } | null = null;

  constructor(
    private readonly element: HTMLElement,
    private readonly callbacks: PointerRouterCallbacks,
    palmPolicy = new PalmRejectionPolicy()
  ) {
    this.palmPolicy = palmPolicy;
    this.eraserCursor = element.ownerDocument.createElement("span");
    this.eraserCursor.className = "native-pdf-handwriting-eraser-cursor";
    this.eraserCursor.setAttribute("aria-hidden", "true");
    this.eraserCursor.hidden = true;
    this.drawCursor = element.ownerDocument.createElement("span");
    this.drawCursor.className = "native-pdf-handwriting-draw-cursor";
    this.drawCursor.setAttribute("aria-hidden", "true");
    this.drawCursor.hidden = true;
    element.ownerDocument.body.append(this.eraserCursor, this.drawCursor);
    const options = { signal: this.abort.signal };
    element.addEventListener("pointerdown", this.handleDown, options);
    element.addEventListener("pointermove", this.handleMove, options);
    element.addEventListener("pointerup", this.handleEnd, options);
    element.addEventListener("pointercancel", this.handleCancel, options);
    element.addEventListener("pointerleave", this.hideCustomCursors, options);
  }

  classify(event: PointerEvent): PointerRoute {
    const tool = this.callbacks.activeTool();
    if (event.pointerType === "touch") {
      if (this.palmPolicy.shouldIgnore(event)) return "ignored";
      return this.touches.size + (this.touches.has(event.pointerId) ? 0 : 1) >= 2 ? "touch-zoom-pan" : "touch-pan";
    }
    if (!this.callbacks.drawingEnabled()) {
      if (isDragPanPointer(event) && this.callbacks.scrollRoot?.()) {
        if (!isAnnotationChromeTarget(event.target) && !isSelectablePdfTarget(event.target)) return "mouse-pan";
      }
      return "native";
    }
    const editing = tool === "eraser" || tool === "lasso";
    if (event.pointerType === "pen") return editing ? "edit" : "draw";
    if (event.pointerType === "mouse" && event.button === 0 && (tool === "pen" || tool === "pencil")) return "draw";
    if (event.pointerType === "mouse" && event.button === 0 && editing) return "edit";
    return "native";
  }

  private readonly handleDown = (event: PointerEvent): void => {
    if (isAnnotationChromeTarget(event.target)) return;
    this.updateCustomCursors(event);
    this.palmPolicy.pointerDown(event);
    const route = this.classify(event);
    if (event.pointerType === "touch" && route !== "ignored") this.touches.add(event.pointerId);
    this.callbacks.onRoute?.(route, event);
    if (route === "mouse-pan") {
      this.panning.set(event.pointerId, {
        startX: event.clientX,
        startY: event.clientY,
        lastY: event.clientY,
        active: false
      });
      this.element.setPointerCapture?.(event.pointerId);
      const root = this.callbacks.scrollRoot?.();
      this.callbacks.onMousePan?.("start", event, {
        target: targetLabel(event.target),
        scrollRoot: root ? scrollRootLabel(root) : null
      });
      return;
    }
    if (route !== "draw" && route !== "edit") return;
    this.routed.set(event.pointerId, route);
    event.preventDefault();
    this.element.setPointerCapture?.(event.pointerId);
    this.callbacks.onStart?.(PointerCapabilities.samples(event), route, event);
  };

  private readonly handleMove = (event: PointerEvent): void => {
    this.updateCustomCursors(event);
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      this.callbacks.onMove?.(PointerCapabilities.samples(event), route, event);
      return;
    }
    const pan = this.panning.get(event.pointerId);
    if (pan) this.updateMousePan(event, pan);
  };

  private readonly handleEnd = (event: PointerEvent): void => {
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      this.callbacks.onEnd?.(PointerCapabilities.samples(event), route, event);
      if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
      this.routed.delete(event.pointerId);
    }
    this.finishMousePan(event);
    this.touches.delete(event.pointerId);
    this.palmPolicy.pointerUp(event);
  };

  private readonly handleCancel = (event: PointerEvent): void => {
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      this.callbacks.onCancel?.(route, event);
      if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
      this.routed.delete(event.pointerId);
    }
    this.finishMousePan(event);
    this.touches.delete(event.pointerId);
    this.palmPolicy.pointerUp(event);
    this.hideCustomCursors();
  };

  syncToolState(): void {
    if (!this.callbacks.drawingEnabled()) {
      this.hideCustomCursors();
      return;
    }
    const tool = this.callbacks.activeTool();
    if (tool !== "eraser") this.hideEraserCursor();
    if (tool !== "pen" && tool !== "pencil") this.hideDrawCursor();
    this.refreshCursors();
  }

  refreshCursors(): void {
    if (!this.lastCursorClient || !this.callbacks.drawingEnabled()) return;
    const { x, y } = this.lastCursorClient;
    const tool = this.callbacks.activeTool();
    if (tool === "eraser" && !this.eraserCursor.hidden) this.paintEraserCursor(x, y);
    if ((tool === "pen" || tool === "pencil") && !this.drawCursor.hidden) this.paintDrawCursor(x, y);
  }

  private cursorClientPoint(clientX: number, clientY: number): { x: number; y: number } {
    return this.callbacks.projectCursor?.(clientX, clientY) ?? { x: clientX, y: clientY };
  }

  destroy(): void {
    for (const pointerId of this.routed.keys()) {
      if (this.element.hasPointerCapture?.(pointerId)) this.element.releasePointerCapture?.(pointerId);
    }
    this.routed.clear();
    this.panning.clear();
    this.touches.clear();
    this.palmPolicy.reset();
    this.abort.abort();
    this.element.classList.remove("native-pdf-handwriting-has-eraser-cursor", "native-pdf-handwriting-has-draw-cursor", "native-pdf-handwriting-panning");
    this.eraserCursor.remove();
    this.drawCursor.remove();
  }

  private updateMousePan(event: PointerEvent, pan: PanGesture): void {
    const root = this.callbacks.scrollRoot?.();
    if (!root) {
      this.callbacks.onMousePan?.("abort", event, { reason: "missing-scroll-root" });
      this.panning.delete(event.pointerId);
      return;
    }
    if (!pan.active) {
      const dx = event.clientX - pan.startX;
      const dy = event.clientY - pan.startY;
      if (Math.hypot(dx, dy) < 4) return;
      if (Math.abs(dx) > Math.max(4, Math.abs(dy) * 1.25)) {
        this.callbacks.onMousePan?.("abort", event, { reason: "horizontal-dominant", dx, dy });
        this.panning.delete(event.pointerId);
        return;
      }
      pan.active = true;
      this.element.classList.add("native-pdf-handwriting-panning");
      this.callbacks.onMousePan?.("activate", event, {
        scrollRoot: scrollRootLabel(root),
        scrollTop: root.scrollTop
      });
    }
    const deltaY = event.clientY - pan.lastY;
    event.preventDefault();
    const changed = scrollPdfBy(root, -deltaY);
    pan.lastY = event.clientY;
    this.callbacks.onMousePan?.("move", event, {
      deltaY: -deltaY,
      scrollTop: root.scrollTop,
      changed
    });
  }

  private finishMousePan(event: PointerEvent): void {
    const pan = this.panning.get(event.pointerId);
    if (!pan) return;
    if (pan.active) {
      event.preventDefault();
      const root = this.callbacks.scrollRoot?.();
      this.callbacks.onMousePan?.("end", event, {
        scrollTop: root?.scrollTop ?? null,
        scrollRoot: root ? scrollRootLabel(root) : null
      });
    }
    this.panning.delete(event.pointerId);
    if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
    if (!this.panning.size) this.element.classList.remove("native-pdf-handwriting-panning");
  }

  private updateCustomCursors(event: PointerEvent): void {
    this.lastCursorClient = { x: event.clientX, y: event.clientY };
    this.updateDrawCursor(event);
    this.updateEraserCursor(event);
  }

  private updateDrawCursor(event: PointerEvent): void {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
      this.hideDrawCursor();
      return;
    }
    this.paintDrawCursor(event.clientX, event.clientY);
  }

  private paintDrawCursor(clientX: number, clientY: number): void {
    const tool = this.callbacks.activeTool();
    const visible = this.callbacks.drawingEnabled()
      && (tool === "pen" || tool === "pencil");
    if (!visible) {
      this.hideDrawCursor();
      return;
    }
    const size = PointerRouter.DRAW_CURSOR_SIZE_PX;
    const color = this.callbacks.drawCursorColor?.();
    const point = this.cursorClientPoint(clientX, clientY);
    setElementCssProps(this.drawCursor, {
      width: `${size}px`,
      height: `${size}px`,
      left: `${point.x}px`,
      top: `${point.y}px`,
      "background-color": color ?? ""
    });
    this.drawCursor.hidden = false;
    this.element.classList.add("native-pdf-handwriting-has-draw-cursor");
  }

  private updateEraserCursor(event: PointerEvent): void {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") {
      this.hideEraserCursor();
      return;
    }
    this.paintEraserCursor(event.clientX, event.clientY);
  }

  private paintEraserCursor(clientX: number, clientY: number): void {
    const visible = this.callbacks.drawingEnabled()
      && this.callbacks.activeTool() === "eraser";
    if (!visible) {
      this.hideEraserCursor();
      return;
    }
    const diameter = Math.max(1, this.callbacks.eraserCursorDiameter?.() ?? 12);
    const point = this.cursorClientPoint(clientX, clientY);
    setElementCssProps(this.eraserCursor, {
      width: `${diameter}px`,
      height: `${diameter}px`,
      left: `${point.x}px`,
      top: `${point.y}px`
    });
    this.eraserCursor.hidden = false;
    this.element.classList.add("native-pdf-handwriting-has-eraser-cursor");
  }

  private readonly hideDrawCursor = (): void => {
    this.drawCursor.hidden = true;
    this.element.classList.remove("native-pdf-handwriting-has-draw-cursor");
  };

  private readonly hideCustomCursors = (): void => {
    this.hideEraserCursor();
    this.hideDrawCursor();
  };

  private readonly hideEraserCursor = (): void => {
    this.eraserCursor.hidden = true;
    this.element.classList.remove("native-pdf-handwriting-has-eraser-cursor");
  };
}

function targetLabel(target: EventTarget | null): string {
  if (target === null) return "null";
  if (!(target instanceof Element)) return Object.prototype.toString.call(target);
  const tag = target.tagName.toLowerCase();
  const classes = [...target.classList].slice(0, 3).join(".");
  return classes ? `${tag}.${classes}` : tag;
}

function scrollRootLabel(root: HTMLElement): string {
  const id = root.id ? `#${root.id}` : "";
  const classes = [...root.classList].slice(0, 2).join(".");
  const scrollable = root.scrollHeight > root.clientHeight;
  return `${root.tagName.toLowerCase()}${id}${classes ? `.${classes}` : ""} scrollable=${scrollable}`;
}
