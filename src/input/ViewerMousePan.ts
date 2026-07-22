import { isHTMLElement } from "../dom/typeGuards";
import { scrollPdfByDetailed, describeScrollElement } from "../integration/PdfScrollRoot";
import { isSelectablePdfTarget } from "./PdfSelectableTarget";
import { isAnnotationChromeTarget, isDragPanPointer } from "./PointerRouter";

interface PanGesture {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  active: boolean;
  scrollRoot: HTMLElement;
  loggedPending: boolean;
  captureTarget: Element;
  pointerType: string;
  /** True once we claimed the gesture (capture + preventDefault). */
  claimed: boolean;
}

export type MousePanPhase = "probe" | "start" | "pending" | "activate" | "move" | "end" | "cancel" | "abort" | "skip";

export { isDragPanPointer };

export function isFingerPanPointer(event: Pick<PointerEvent, "pointerType" | "button">): boolean {
  return event.pointerType === "touch" && event.button === 0;
}

export interface ViewerMousePanCallbacks {
  /** Mouse/stylus drag-scroll when Draw is off. */
  enabled(): boolean;
  /** Finger drag-scroll. Default off — leave movement to native PDF viewer. */
  touchPanEnabled?(): boolean;
  scrollRoot(): HTMLElement;
  withinTarget?(target: EventTarget | null): boolean;
  captureElement?(): HTMLElement;
  onPan?(phase: MousePanPhase, event: PointerEvent, details: Record<string, unknown>): void;
}

export class ViewerMousePan {
  private readonly panning = new Map<number, PanGesture>();
  private readonly activeTouches = new Set<number>();
  private readonly abort = new AbortController();

  constructor(
    private readonly listenerRoot: Document | HTMLElement,
    private readonly callbacks: ViewerMousePanCallbacks
  ) {
    const options = { capture: true, signal: this.abort.signal };
    const onDown = (event: Event): void => this.onDown(event as PointerEvent);
    const onMove = (event: Event): void => this.onMove(event as PointerEvent);
    const onEnd = (event: Event): void => this.onEnd(event as PointerEvent);
    this.listenerRoot.addEventListener("pointerdown", onDown, options);
    this.listenerRoot.addEventListener("pointermove", onMove, options);
    this.listenerRoot.addEventListener("pointerup", onEnd, options);
    this.listenerRoot.addEventListener("pointercancel", onEnd, options);
  }

  destroy(): void {
    this.panning.clear();
    this.activeTouches.clear();
    this.abort.abort();
    this.captureHost().classList.remove("native-pdf-handwriting-panning");
  }

  private captureHost(): HTMLElement {
    return this.callbacks.captureElement?.()
      ?? (this.listenerRoot instanceof Document ? this.listenerRoot.body : this.listenerRoot);
  }

  private within(event: PointerEvent): boolean {
    return this.callbacks.withinTarget?.(event.target) ?? true;
  }

  private touchPanAllowed(): boolean {
    return this.callbacks.touchPanEnabled?.() ?? false;
  }

  private abortTouchPans(event: PointerEvent, reason: string): void {
    for (const [pointerId, pan] of [...this.panning.entries()]) {
      if (pan.pointerType !== "touch") continue;
      this.callbacks.onPan?.("abort", event, { reason, pointerId });
      this.releaseClaim(pan, pointerId);
      this.panning.delete(pointerId);
    }
    if (!this.panning.size) this.captureHost().classList.remove("native-pdf-handwriting-panning");
  }

  private claimGesture(event: PointerEvent, pan: PanGesture): void {
    if (pan.claimed) return;
    pan.claimed = true;
    event.preventDefault();
    event.stopPropagation();
    pan.captureTarget.setPointerCapture?.(event.pointerId);
  }

  private releaseClaim(pan: PanGesture, pointerId: number): void {
    if (!pan.claimed) return;
    if (isHTMLElement(pan.captureTarget) && pan.captureTarget.hasPointerCapture?.(pointerId)) {
      pan.captureTarget.releasePointerCapture?.(pointerId);
    }
  }

  private readonly onDown = (event: PointerEvent): void => {
    const inBoundary = this.within(event);
    const finger = isFingerPanPointer(event);
    const tip = isDragPanPointer(event);

    if (event.pointerType === "touch") {
      this.activeTouches.add(event.pointerId);
      // Second finger → release one-finger pan so native pinch/zoom can run.
      if (this.activeTouches.size >= 2) {
        this.abortTouchPans(event, "multi-touch");
        this.callbacks.onPan?.("skip", event, {
          reason: "multi-touch",
          touches: this.activeTouches.size,
          target: targetLabel(event.target)
        });
        return;
      }
    }

    if (finger || tip || (inBoundary && (event.pointerType === "mouse" || event.pointerType === "pen" || event.pointerType === "touch"))) {
      this.callbacks.onPan?.("probe", event, {
        inBoundary,
        enabled: finger ? this.touchPanAllowed() : this.callbacks.enabled(),
        target: targetLabel(event.target),
        pointerType: event.pointerType
      });
    }

    if (!finger && !tip) {
      if (inBoundary && (event.pointerType === "mouse" || event.pointerType === "pen")) {
        this.callbacks.onPan?.("skip", event, {
          reason: "button",
          button: event.button,
          pointerType: event.pointerType,
          target: targetLabel(event.target)
        });
      }
      return;
    }
    if (!inBoundary) {
      this.callbacks.onPan?.("skip", event, { reason: "outside-boundary", target: targetLabel(event.target) });
      return;
    }
    if (isAnnotationChromeTarget(event.target)) {
      this.callbacks.onPan?.("skip", event, { reason: "annotation-chrome", target: targetLabel(event.target) });
      return;
    }
    if (event.target instanceof Element && event.target.closest(".native-pdf-handwriting-toolbar, .native-pdf-handwriting-dropdown")) {
      this.callbacks.onPan?.("skip", event, { reason: "toolbar", target: targetLabel(event.target) });
      return;
    }
    // Mouse/stylus on PDF text → native selection. Finger still pans when touch pan is enabled.
    if (!finger && isSelectablePdfTarget(event.target)) {
      this.callbacks.onPan?.("skip", event, { reason: "selectable", target: targetLabel(event.target) });
      return;
    }

    // Finger only if touchPanEnabled. Mouse/stylus only when Draw is off (enabled).
    if (finger) {
      if (!this.touchPanAllowed()) {
        this.callbacks.onPan?.("skip", event, { reason: "touch-disabled", target: targetLabel(event.target) });
        return;
      }
    } else if (!this.callbacks.enabled()) {
      this.callbacks.onPan?.("skip", event, { reason: "disabled", target: targetLabel(event.target) });
      return;
    }

    const scrollRoot = this.callbacks.scrollRoot();
    const captureTarget = event.target instanceof Element ? event.target : this.captureHost();
    this.panning.set(event.pointerId, {
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      scrollRoot,
      loggedPending: false,
      captureTarget,
      pointerType: event.pointerType,
      claimed: false
    });
    // Finger custom pan must claim immediately or native scroll wins.
    // Mouse/stylus: wait for activate so clicks / text / links stay native until a real drag.
    if (finger) {
      const pan = this.panning.get(event.pointerId)!;
      this.claimGesture(event, pan);
    }
    this.callbacks.onPan?.("start", event, {
      target: targetLabel(event.target),
      scrollRoot: describeScrollElement(scrollRoot),
      captureHost: targetLabel(captureTarget),
      pointerType: event.pointerType,
      deferredClaim: !finger
    });
  };

  private readonly onMove = (event: PointerEvent): void => {
    const pan = this.panning.get(event.pointerId);
    if (!pan) return;
    this.updatePan(event, pan);
  };

  private readonly onEnd = (event: PointerEvent): void => {
    if (event.pointerType === "touch") this.activeTouches.delete(event.pointerId);
    const pan = this.panning.get(event.pointerId);
    if (!pan) return;
    if (pan.active) {
      event.preventDefault();
      this.callbacks.onPan?.("end", event, {
        scrollRoot: describeScrollElement(pan.scrollRoot),
        pointerType: pan.pointerType
      });
    } else {
      this.callbacks.onPan?.("cancel", event, {
        dx: event.clientX - pan.startX,
        dy: event.clientY - pan.startY,
        target: targetLabel(event.target),
        pointerType: pan.pointerType
      });
    }
    this.releaseClaim(pan, event.pointerId);
    this.panning.delete(event.pointerId);
    if (!this.panning.size) this.captureHost().classList.remove("native-pdf-handwriting-panning");
  };

  private updatePan(event: PointerEvent, pan: PanGesture): void {
    const root = this.callbacks.scrollRoot();
    pan.scrollRoot = root;
    if (!pan.active) {
      const dx = event.clientX - pan.startX;
      const dy = event.clientY - pan.startY;
      if (Math.hypot(dx, dy) < 4) {
        if (!pan.loggedPending && Math.hypot(dx, dy) > 0) {
          pan.loggedPending = true;
          this.callbacks.onPan?.("pending", event, { dx, dy });
        }
        return;
      }
      // Mouse/stylus: keep a soft vertical-bias gate so sideways drags stay native (e.g. selection).
      // Fingers (when enabled): free drag.
      if (pan.pointerType !== "touch" && Math.abs(dx) > Math.max(12, Math.abs(dy) * 2)) {
        this.callbacks.onPan?.("abort", event, { reason: "horizontal-dominant", dx, dy });
        this.releaseClaim(pan, event.pointerId);
        this.panning.delete(event.pointerId);
        return;
      }
      this.claimGesture(event, pan);
      pan.active = true;
      this.captureHost().classList.add("native-pdf-handwriting-panning");
      this.callbacks.onPan?.("activate", event, {
        scrollRoot: describeScrollElement(root),
        scrollTop: root.scrollTop,
        pointerType: pan.pointerType
      });
    } else {
      this.claimGesture(event, pan);
    }
    const deltaY = event.clientY - pan.lastY;
    const deltaX = event.clientX - pan.lastX;
    event.preventDefault();
    // Invert: drag down/right pulls the page with the pointer (grab feel).
    const scroll = scrollPdfByDetailed(root, -deltaY, event.clientX, event.clientY);
    // Mouse/stylus also get X when zoomed; fingers already did.
    if (deltaX !== 0) {
      if (typeof root.scrollBy === "function") root.scrollBy(-deltaX, 0);
      else root.scrollLeft -= deltaX;
    }
    pan.lastX = event.clientX;
    pan.lastY = event.clientY;
    this.callbacks.onPan?.("move", event, {
      deltaY: -deltaY,
      deltaX: -deltaX,
      changed: scroll.changed || deltaX !== 0,
      scrollTop: scroll.scrollAfter ?? scroll.scrolled?.scrollTop ?? root.scrollTop,
      scrollLeft: root.scrollLeft,
      scrollBefore: scroll.scrollBefore,
      scrollAfter: scroll.scrollAfter,
      scrolledElement: scroll.scrolled ? describeScrollElement(scroll.scrolled) : describeScrollElement(root),
      via: scroll.via,
      pointerType: pan.pointerType
    });
  }
}

function targetLabel(target: EventTarget | null): string {
  if (target === null) return "null";
  if (!(target instanceof Element)) return Object.prototype.toString.call(target);
  const tag = target.tagName.toLowerCase();
  const classes = [...target.classList].slice(0, 3).join(".");
  return classes ? `${tag}.${classes}` : tag;
}
