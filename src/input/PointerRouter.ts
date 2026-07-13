import type { ToolId } from "../model";
import { PalmRejectionPolicy } from "./PalmRejectionPolicy";
import { PointerCapabilities, type PointerSample } from "./PointerCapabilities";

export type PointerRoute = "draw" | "edit" | "touch-pan" | "touch-zoom-pan" | "native" | "ignored";

export interface PointerRouterCallbacks {
  activeTool(): ToolId;
  onStart?(samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void;
  onMove?(samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void;
  onEnd?(samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void;
  onRoute?(route: PointerRoute, event: PointerEvent): void;
}

export class PointerRouter {
  private readonly routed = new Map<number, "draw" | "edit">();
  private readonly touches = new Set<number>();
  private readonly palmPolicy: PalmRejectionPolicy;
  private readonly abort = new AbortController();

  constructor(
    private readonly element: HTMLElement,
    private readonly callbacks: PointerRouterCallbacks,
    palmPolicy = new PalmRejectionPolicy()
  ) {
    this.palmPolicy = palmPolicy;
    const options = { signal: this.abort.signal };
    element.addEventListener("pointerdown", this.handleDown, options);
    element.addEventListener("pointermove", this.handleMove, options);
    element.addEventListener("pointerup", this.handleEnd, options);
    element.addEventListener("pointercancel", this.handleEnd, options);
  }

  classify(event: PointerEvent): PointerRoute {
    const tool = this.callbacks.activeTool();
    if (event.pointerType === "touch") {
      if (this.palmPolicy.shouldIgnore(event)) return "ignored";
      return this.touches.size + (this.touches.has(event.pointerId) ? 0 : 1) >= 2 ? "touch-zoom-pan" : "touch-pan";
    }
    const editing = tool === "eraser" || tool === "lasso";
    if (event.pointerType === "pen") return editing ? "edit" : "draw";
    if (event.pointerType === "mouse" && event.button === 0 && (tool === "pen" || tool === "pencil")) return "draw";
    if (event.pointerType === "mouse" && event.button === 0 && editing) return "edit";
    return "native";
  }

  private readonly handleDown = (event: PointerEvent): void => {
    this.palmPolicy.pointerDown(event);
    const route = this.classify(event);
    if (event.pointerType === "touch" && route !== "ignored") this.touches.add(event.pointerId);
    this.callbacks.onRoute?.(route, event);
    if (route !== "draw" && route !== "edit") return;
    this.routed.set(event.pointerId, route);
    event.preventDefault();
    this.element.setPointerCapture?.(event.pointerId);
    this.callbacks.onStart?.(PointerCapabilities.samples(event), route, event);
  };

  private readonly handleMove = (event: PointerEvent): void => {
    const route = this.routed.get(event.pointerId);
    if (!route) return;
    event.preventDefault();
    this.callbacks.onMove?.(PointerCapabilities.samples(event), route, event);
  };

  private readonly handleEnd = (event: PointerEvent): void => {
    const route = this.routed.get(event.pointerId);
    if (route) {
      event.preventDefault();
      this.callbacks.onEnd?.(PointerCapabilities.samples(event), route, event);
      if (this.element.hasPointerCapture?.(event.pointerId)) this.element.releasePointerCapture?.(event.pointerId);
      this.routed.delete(event.pointerId);
    }
    this.touches.delete(event.pointerId);
    this.palmPolicy.pointerUp(event);
  };

  destroy(): void {
    for (const pointerId of this.routed.keys()) {
      if (this.element.hasPointerCapture?.(pointerId)) this.element.releasePointerCapture?.(pointerId);
    }
    this.routed.clear();
    this.touches.clear();
    this.palmPolicy.reset();
    this.abort.abort();
  }
}
