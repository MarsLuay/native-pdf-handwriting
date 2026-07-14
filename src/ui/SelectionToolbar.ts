export interface SelectionToolbarCallbacks {
  onDelete(): void;
  onDuplicate(): void;
  onRecolor(color: string): void;
  onClear(): void;
}

export interface ViewportPoint {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export class SelectionToolbar {
  readonly element: HTMLElement;
  private readonly count: HTMLElement;
  private readonly dragHandle: HTMLElement;
  private readonly abort = new AbortController();
  private viewerRoot: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private anchor: ViewportPoint | null = null;
  private userPositioned = false;
  private drag: { pointerId: number; offsetX: number; offsetY: number } | null = null;

  constructor(callbacks: SelectionToolbarCallbacks, document: Document = window.document) {
    this.element = document.createElement("div");
    this.element.className = "native-pdf-ink-selection-toolbar";
    this.element.dataset.focusOverlayInternal = "true";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", "Selected strokes");
    this.dragHandle = document.createElement("span");
    this.dragHandle.className = "native-pdf-ink-selection-toolbar-drag";
    this.dragHandle.setAttribute("aria-label", "Drag selection toolbar");
    this.count = document.createElement("span");
    this.count.className = "native-pdf-ink-selection-toolbar-count";
    this.dragHandle.append(this.count);
    this.element.append(
      this.dragHandle,
      this.button(document, "Delete", callbacks.onDelete),
      this.button(document, "Duplicate", callbacks.onDuplicate)
    );
    const color = document.createElement("input");
    color.type = "color";
    color.setAttribute("aria-label", "Recolor selected strokes");
    color.addEventListener("input", () => callbacks.onRecolor(color.value), { signal: this.abort.signal });
    this.element.append(color, this.button(document, "Done", callbacks.onClear));
    for (const type of ["pointerup", "click"] as const) {
      this.element.addEventListener(type, (event) => event.stopPropagation(), { signal: this.abort.signal });
    }
    const signal = this.abort.signal;
    this.dragHandle.addEventListener("pointerdown", this.onDragStart, { signal });
    this.dragHandle.addEventListener("pointermove", this.onDragMove, { signal });
    this.dragHandle.addEventListener("pointerup", this.onDragEnd, { signal });
    this.dragHandle.addEventListener("pointercancel", this.onDragEnd, { signal });
    this.hide();
  }

  bindViewport(viewerRoot: HTMLElement): void {
    this.viewerRoot = viewerRoot;
    if (!this.element.isConnected) viewerRoot.ownerDocument.body.append(this.element);
    const signal = this.abort.signal;
    const relayout = () => this.layout();
    // Prefer element targets (AbortSignal) — avoid window/document listeners (plugin unload hygiene).
    viewerRoot.addEventListener("scroll", relayout, { passive: true, capture: true, signal });
    viewerRoot.ownerDocument.body.addEventListener("scroll", relayout, { passive: true, capture: true, signal });
    this.resizeObserver?.disconnect();
    this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(relayout);
    this.resizeObserver?.observe(viewerRoot);
  }

  show(count: number, autoAnchor?: ViewportPoint): void {
    this.count.textContent = `${count} selected`;
    this.element.hidden = count === 0;
    if (count === 0) return;
    if (!this.userPositioned) this.anchor = autoAnchor ?? this.anchor;
    this.layout();
  }

  reposition(autoAnchor: ViewportPoint): void {
    if (!this.element.hidden && !this.userPositioned) this.anchor = autoAnchor;
    this.layout();
  }

  relayout(): void {
    this.layout();
  }

  resetPlacement(): void {
    this.userPositioned = false;
    this.anchor = null;
    this.drag = null;
  }

  hide(): void {
    this.element.hidden = true;
    this.resetPlacement();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.abort.abort();
    this.element.remove();
  }

  private layout(): void {
    if (this.element.hidden || !this.viewerRoot) return;
    const rootRect = this.viewerRoot.getBoundingClientRect();
    if (rootRect.width <= 0 || rootRect.height <= 0) return;
    const width = this.element.offsetWidth || 280;
    const height = this.element.offsetHeight || 48;
    const fallback = {
      x: Math.max(8, (rootRect.width - width) / 2),
      y: 8
    };
    const anchor = this.anchor ?? fallback;
    const x = clamp(anchor.x, 8, Math.max(8, rootRect.width - width - 8));
    const y = clamp(anchor.y, 8, Math.max(8, rootRect.height - height - 8));
    this.anchor = { x, y };
    this.element.style.left = `${rootRect.left + x}px`;
    this.element.style.top = `${rootRect.top + y}px`;
  }

  private readonly onDragStart = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.viewerRoot || this.element.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    const rootRect = this.viewerRoot.getBoundingClientRect();
    const anchor = this.anchor ?? { x: 8, y: 8 };
    this.drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - (rootRect.left + anchor.x),
      offsetY: event.clientY - (rootRect.top + anchor.y)
    };
    this.userPositioned = true;
    this.dragHandle.setPointerCapture?.(event.pointerId);
  };

  private readonly onDragMove = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId || !this.viewerRoot) return;
    event.preventDefault();
    event.stopPropagation();
    const rootRect = this.viewerRoot.getBoundingClientRect();
    this.anchor = {
      x: event.clientX - rootRect.left - this.drag.offsetX,
      y: event.clientY - rootRect.top - this.drag.offsetY
    };
    this.layout();
  };

  private readonly onDragEnd = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    event.stopPropagation();
    this.drag = null;
    if (this.dragHandle.hasPointerCapture?.(event.pointerId)) {
      this.dragHandle.releasePointerCapture?.(event.pointerId);
    }
  };

  private button(document: Document, label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action, { signal: this.abort.signal });
    return button;
  }
}
