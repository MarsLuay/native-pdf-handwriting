import type { ViewStateSource } from "../logging/SessionLogger";
import type { ToolbarPlacement } from "../model";
import type { ObsidianPdfAdapter, PdfAdapterCallbacks, PdfViewState } from "./ObsidianPdfAdapter";
import { PdfPageLocator, type PdfPageInfo } from "./PdfPageLocator";
import { resolvePdfScrollRoot } from "./PdfScrollRoot";
import type { CompatibilityResult } from "./PdfViewerCompatibility";
import { installPdfZoomBoost, OBSIDIAN_DEFAULT_MAX_SCALE, type PdfZoomBoostHandle } from "./PdfZoomBoost";

export abstract class BasePdfAdapter implements ObsidianPdfAdapter {
  abstract readonly kind: "direct" | "embedded";
  readonly host: HTMLElement;
  readonly root: HTMLElement;
  protected readonly locator: PdfPageLocator;
  private readonly cleanup: Array<() => void> = [];
  private readonly mounted = new Set<HTMLElement>();
  private readonly callbacks: PdfAdapterCallbacks;
  private readonly zoomBoost: PdfZoomBoostHandle | null;
  private destroyed = false;

  protected constructor(
    protected readonly compatibility: CompatibilityResult,
    host: HTMLElement,
    callbacks: PdfAdapterCallbacks = {}
  ) {
    this.host = host;
    this.root = compatibility.viewerRoot!;
    this.callbacks = callbacks;
    this.locator = new PdfPageLocator(this.root, compatibility.privateViewer);
    this.zoomBoost = installPdfZoomBoost(compatibility.privateViewer);
    if (this.zoomBoost) this.registerCleanup(() => this.zoomBoost?.destroy());
    for (const warning of compatibility.warnings) callbacks.onCompatibilityWarning?.(warning);
    this.listen();
  }

  pages(): PdfPageInfo[] {
    return this.locator.pages();
  }

  getViewState(): PdfViewState {
    const page = this.locator.page(this.locator.currentPage()) ?? this.pages()[0];
    const scroller = this.scrollElement();
    const denominator = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
    return {
      pageNumber: page?.pageNumber ?? 1,
      scrollFraction: Math.max(0, Math.min(1, scroller.scrollTop / denominator)),
      scale: page?.scale ?? 1,
      rotation: page?.rotation ?? 0
    };
  }

  restoreViewState(state: PdfViewState): void {
    const page = this.locator.page(state.pageNumber);
    page?.element.scrollIntoView?.({ block: "start" });
    const scroller = this.scrollElement();
    const denominator = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = denominator * Math.max(0, Math.min(1, state.scrollFraction));
  }

  scrollElement(): HTMLElement {
    return resolvePdfScrollRoot(this.root, this.compatibility.privateViewer, this.host);
  }

  setScale(scale: number): boolean {
    return this.zoomBoost?.setScale(scale) ?? false;
  }

  setScaleValue(value: string | number): boolean {
    return this.zoomBoost?.setScaleValue(value) ?? false;
  }

  zoomBySteps(steps: number): boolean {
    return this.zoomBoost?.zoomBySteps(steps) ?? false;
  }

  maxScale(): number {
    return this.zoomBoost?.maxScale() ?? OBSIDIAN_DEFAULT_MAX_SCALE;
  }

  mountOverlay(pageNumber: number): HTMLElement {
    const page = this.locator.page(pageNumber);
    if (!page) throw new Error(`Cannot mount annotation overlay: PDF page ${pageNumber} is unavailable`);
    const overlay = page.element.ownerDocument.createElement("div");
    overlay.className = "native-pdf-ink-page-overlay";
    overlay.dataset.pageNumber = String(pageNumber);
    overlay.dataset.focusOverlayInternal = "true";
    this.ensureRelative(page.element);
    page.element.append(overlay);
    this.mounted.add(overlay);
    return overlay;
  }

  private ensureRelative(element: HTMLElement): void {
    if (element.ownerDocument.defaultView?.getComputedStyle(element).position === "static") {
      element.style.position = "relative";
    }
  }

  mountToolbar(toolbar: HTMLElement, placement: ToolbarPlacement = "main"): void {
    this.clearToolbarMounts(toolbar);
    toolbar.classList.remove("is-main", "is-sidebar-left", "is-sidebar-right");

    if (placement === "main") {
      this.unwrapSidebarChrome();
      toolbar.classList.add("is-main");
      const host = this.compatibility.toolbarHost ?? this.root.parentElement ?? this.root;
      const palette = host.querySelector(".pdf-plus-color-palette");
      if (palette?.parentElement) {
        palette.parentElement.insertBefore(toolbar, palette.nextSibling);
      } else {
        host.append(toolbar);
      }
      this.mounted.add(toolbar);
      return;
    }

    const chrome = this.ensureSidebarChrome();
    chrome.classList.remove("is-toolbar-left", "is-toolbar-right");
    chrome.classList.add(placement === "left" ? "is-toolbar-left" : "is-toolbar-right");
    const rail = toolbar.ownerDocument.createElement("div");
    rail.className = `native-pdf-ink-rail is-${placement}`;
    toolbar.classList.add(placement === "left" ? "is-sidebar-left" : "is-sidebar-right");
    rail.append(toolbar);
    // DOM order is a fallback; CSS grid columns on chrome pin left vs right.
    if (placement === "left") chrome.insertBefore(rail, chrome.firstChild);
    else chrome.append(rail);
    this.mounted.add(rail);
    this.mounted.add(toolbar);
  }

  private clearToolbarMounts(toolbar: HTMLElement): void {
    for (const existing of this.host.querySelectorAll(".native-pdf-ink-toolbar, .native-pdf-ink-rail")) {
      if (existing === toolbar) continue;
      existing.remove();
      this.mounted.delete(existing as HTMLElement);
    }
    toolbar.remove();
    this.mounted.delete(toolbar);
  }

  private unwrapSidebarChrome(): void {
    const chrome = this.host.querySelector(".native-pdf-ink-chrome");
    if (!(chrome instanceof HTMLElement) || !chrome.contains(this.root)) return;
    const parentNode = chrome.parentElement;
    if (!parentNode) return;
    while (chrome.firstChild) parentNode.insertBefore(chrome.firstChild, chrome);
    chrome.remove();
    this.mounted.delete(chrome);
  }

  /**
   * Wrap the PDF scroll box (not the inner viewer) so the rail is a flex sibling
   * of the scroller and stays on-screen while pages scroll.
   */
  private ensureSidebarChrome(): HTMLElement {
    const existing = this.host.querySelector(".native-pdf-ink-chrome");
    if (existing instanceof HTMLElement) return existing;
    const wrapTarget = this.sidebarWrapTarget();
    const parent = wrapTarget.parentElement ?? this.host;
    const chrome = wrapTarget.ownerDocument.createElement("div");
    chrome.className = "native-pdf-ink-chrome";
    parent.insertBefore(chrome, wrapTarget);
    chrome.append(wrapTarget);
    this.mounted.add(chrome);
    this.registerCleanup(() => this.unwrapSidebarChrome());
    return chrome;
  }

  private sidebarWrapTarget(): HTMLElement {
    const scroller = this.scrollElement();
    if (scroller === this.root) return this.root;
    if (!scroller.contains(this.root)) return this.root;
    // Dedicated Obsidian/PDF.js scroll hosts — wrap these, not .pdf-viewer inside them.
    if (
      scroller.classList.contains("pdf-viewer-scroll-container")
      || scroller.classList.contains("pdf-viewer-container")
      || scroller.id === "viewerContainer"
    ) {
      return scroller;
    }
    // Scroller is the direct parent of the viewer root.
    if (this.root.parentElement === scroller) return scroller;
    return this.root;
  }

  compatibilityReport(): { errors: string[]; warnings: string[] } {
    return {
      errors: [...this.compatibility.errors],
      warnings: [...this.compatibility.warnings]
    };
  }

  protected registerCleanup(cleanup: () => void): void {
    this.cleanup.push(cleanup);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanup.splice(0).reverse()) cleanup();
    for (const element of this.mounted) element.remove();
    this.mounted.clear();
  }

  private listen(): void {
    const notify = (source: ViewStateSource): void => this.callbacks.onViewStateChange?.(this.getViewState(), source);
    const onScroll = (): void => notify("scroll");
    const scroller = this.scrollElement();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    this.registerCleanup(() => scroller.removeEventListener("scroll", onScroll));

    const observer = new MutationObserver((records) => {
      let childListChanged = false;
      let scaleChanged = false;
      let rotationChanged = false;
      for (const record of records) {
        if (!this.isExternalMutation(record)) continue;
        if (record.type === "childList") {
          childListChanged = true;
          continue;
        }
        if (record.type !== "attributes") continue;
        if (record.attributeName === "data-scale") scaleChanged = true;
        else if (record.attributeName === "data-rotation") rotationChanged = true;
        else if (record.attributeName === "data-page-number") childListChanged = true;
      }
      if (childListChanged) this.callbacks.onPagesChanged?.("pages-dom");
      else if (scaleChanged) notify("data-scale");
      else if (rotationChanged) notify("rotationchanging");
    });
    observer.observe(this.root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-page-number", "data-rotation", "data-scale"] });
    this.registerCleanup(() => observer.disconnect());

    // PDF++ may replace the whole viewer under the leaf host — root observer dies with the old node.
    const hostObserver = new MutationObserver(() => {
      if (this.destroyed) return;
      if (!this.root.isConnected) this.callbacks.onPagesChanged?.("host-dom");
    });
    hostObserver.observe(this.host, { childList: true, subtree: true });
    this.registerCleanup(() => hostObserver.disconnect());

    const eventBus = this.compatibility.privateViewer?.eventBus;
    for (const [event, source] of [
      ["pagechanging", "pagechanging"],
      ["scalechanging", "scalechanging"],
      ["rotationchanging", "rotationchanging"]
    ] as const) {
      const handler = (): void => notify(source);
      eventBus?.on?.(event, handler);
      this.registerCleanup(() => eventBus?.off?.(event, handler));
    }
  }

  private isExternalMutation(record: MutationRecord): boolean {
    if (record.type === "attributes") {
      const target = record.target;
      return !(target instanceof HTMLElement) || !this.isInternalElement(target);
    }
    if (record.type !== "childList") return false;
    return [...record.addedNodes, ...record.removedNodes].some((node) => !this.isInternalNode(node));
  }

  private isInternalNode(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      return parent ? this.isInternalElement(parent) : false;
    }
    return node instanceof HTMLElement && this.isInternalElement(node);
  }

  private isInternalElement(element: HTMLElement): boolean {
    if (element.dataset.focusOverlayInternal === "true") return true;
    if (this.isPdfPlusElement(element)) return true;
    if (element.classList.contains("native-pdf-ink-page-overlay")) return true;
    if (element.classList.contains("native-pdf-ink-canvas")) return true;
    if (element.classList.contains("native-pdf-ink-selection-toolbar")) return true;
    if (element.classList.contains("native-pdf-ink-eraser-cursor")) return true;
    if (element.classList.contains("native-pdf-ink-draw-cursor")) return true;
    if (element.classList.contains("native-pdf-ink-toolbar")) return true;
    if (element.classList.contains("native-pdf-ink-rail")) return true;
    if (element.classList.contains("native-pdf-ink-chrome")) return true;
    return Boolean(element.closest(".native-pdf-ink-page-overlay, .native-pdf-ink-toolbar, .native-pdf-ink-selection-toolbar, .native-pdf-ink-rail, .native-pdf-ink-chrome"));
  }

  /** PDF++ injects backlink layers / palette — do not treat as page rebuilds. */
  private isPdfPlusElement(element: HTMLElement): boolean {
    for (const cls of element.classList) {
      if (cls.startsWith("pdf-plus-")) return true;
    }
    return Boolean(element.closest("[class*='pdf-plus-']"));
  }
}
