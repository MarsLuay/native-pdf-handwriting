import { isElement, isHTMLElement } from "../dom/typeGuards";
import type { ViewStateSource } from "../logging/SessionLogger";
import type { ToolbarPlacement } from "../model";
import type { ObsidianPdfAdapter, PdfAdapterCallbacks, PdfViewState } from "./ObsidianPdfAdapter";
import { PdfPageLocator, type PdfPageInfo } from "./PdfPageLocator";
import { resolvePdfScrollRoot } from "./PdfScrollRoot";
import {
  findPdfContentContainer,
  findPdfSidebarContainer,
  syncLeftChromeWithPdfSidebar,
  type PdfSidebarOffsetDiag,
  type PdfSidebarOffsetReason
} from "./PdfSidebarRailOffset";
import type { CompatibilityResult } from "./PdfViewerCompatibility";
import { installPdfZoomBoost, OBSIDIAN_DEFAULT_MAX_SCALE, type PdfZoomBoostHandle } from "./PdfZoomBoost";

const LOG_PREFIX = "[Handwriting Natively]";

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
  private sidebarRailFrame: number | null = null;
  private sidebarFollowFrame: number | null = null;
  private sidebarFollowUntil = 0;
  private sidebarWatchInstalled = false;
  private sidebarLastOffset = 0;
  private sidebarLastReason: PdfSidebarOffsetReason | null = null;
  private sidebarFollowFrameCount = 0;
  private sidebarFollowMaxJump = 0;
  private sidebarFollowReasons = new Set<PdfSidebarOffsetReason>();
  private sidebarFollowTrigger = "sync";
  /** Cover Obsidian PDF sidebar open/close transitions (often ~250–400ms). */
  private static readonly SIDEBAR_FOLLOW_MS = 480;
  private static readonly SIDEBAR_JUMP_WARN_PX = 24;

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

  zoomByScaleFactor(factor: number, origin?: [number, number]): boolean {
    return this.zoomBoost?.zoomByScaleFactor(factor, origin) ?? false;
  }

  maxScale(): number {
    return this.zoomBoost?.maxScale() ?? OBSIDIAN_DEFAULT_MAX_SCALE;
  }

  mountOverlay(pageNumber: number): HTMLElement {
    const page = this.locator.page(pageNumber);
    if (!page) throw new Error(`Cannot mount annotation overlay: PDF page ${pageNumber} is unavailable`);
    const overlay = page.element.ownerDocument.createElement("div");
    overlay.className = "native-pdf-handwriting-page-overlay";
    overlay.dataset.pageNumber = String(pageNumber);
    overlay.dataset.focusOverlayInternal = "true";
    this.ensureRelative(page.element);
    page.element.append(overlay);
    this.mounted.add(overlay);
    return overlay;
  }

  private ensureRelative(element: HTMLElement): void {
    if (element.ownerDocument.defaultView?.getComputedStyle(element).position === "static") {
      element.classList.add("native-pdf-handwriting-relative");
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
    rail.className = `native-pdf-handwriting-rail is-${placement}`;
    toolbar.classList.add(placement === "left" ? "is-sidebar-left" : "is-sidebar-right");
    rail.append(toolbar);
    // DOM order is a fallback; CSS grid columns on chrome pin left vs right.
    if (placement === "left") chrome.insertBefore(rail, chrome.firstChild);
    else chrome.append(rail);
    this.mounted.add(rail);
    this.mounted.add(toolbar);
    this.queueSyncLeftRailWithPdfSidebar(false, "mount-toolbar");
  }

  private clearToolbarMounts(toolbar: HTMLElement): void {
    for (const existing of this.host.querySelectorAll(".native-pdf-handwriting-toolbar, .native-pdf-handwriting-rail")) {
      if (existing === toolbar) continue;
      existing.remove();
      this.mounted.delete(existing as HTMLElement);
    }
    toolbar.remove();
    this.mounted.delete(toolbar);
  }

  private unwrapSidebarChrome(): void {
    const chrome = this.host.querySelector(".native-pdf-handwriting-chrome");
    if (!isHTMLElement(chrome) || !chrome.contains(this.root)) return;
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
    const existing = this.host.querySelector(".native-pdf-handwriting-chrome");
    if (isHTMLElement(existing)) return existing;
    const wrapTarget = this.sidebarWrapTarget();
    const parent = wrapTarget.parentElement ?? this.host;
    const chrome = wrapTarget.ownerDocument.createElement("div");
    chrome.className = "native-pdf-handwriting-chrome";
    // Insert at the scroll host's seat so an in-flow PDF sidebar sibling stays left of chrome.
    parent.insertBefore(chrome, wrapTarget);
    chrome.append(wrapTarget);
    this.mounted.add(chrome);
    this.registerCleanup(() => this.unwrapSidebarChrome());
    this.watchPdfSidebarLayout();
    return chrome;
  }

  private sidebarWrapTarget(): HTMLElement {
    const scroller = this.scrollElement();
    // Prefer the scroll host inside Obsidian's content pane (sibling of
    // .pdf-sidebar-container). Never wrap a node that still contains the
    // PDF sidebar — that would put the ink rail under/around the outline.
    const content = findPdfContentContainer(this.host)
      ?? (scroller.parentElement ? findPdfContentContainer(scroller.parentElement) : null);
    if (
      content
      && content.contains(this.root)
      && scroller !== this.root
      && content.contains(scroller)
      && !scroller.querySelector(".pdf-sidebar-container")
      && (
        scroller.classList.contains("pdf-viewer-scroll-container")
        || scroller.classList.contains("pdf-viewer-container")
        || scroller.id === "viewerContainer"
        || this.root.parentElement === scroller
      )
    ) {
      return scroller;
    }
    if (scroller === this.root) return this.root;
    if (!scroller.contains(this.root)) return this.root;
    if (scroller.querySelector(".pdf-sidebar-container")) return this.root;
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

  private pdfLayoutScope(): ParentNode {
    return this.root.closest(".pdf-container, .workspace-leaf-content, .view-content")
      ?? this.host;
  }

  private queueSyncLeftRailWithPdfSidebar(follow = false, trigger = "sync"): void {
    if (this.destroyed) return;
    if (follow) {
      this.sidebarFollowTrigger = trigger;
      const view = this.host.ownerDocument.defaultView;
      const now = view?.performance.now() ?? Date.now();
      this.sidebarFollowUntil = Math.max(
        this.sidebarFollowUntil,
        now + BasePdfAdapter.SIDEBAR_FOLLOW_MS
      );
      this.startSidebarFollowLoop();
      return;
    }
    if (this.sidebarFollowFrame !== null) return;
    if (this.sidebarRailFrame !== null) {
      this.host.ownerDocument.defaultView?.cancelAnimationFrame(this.sidebarRailFrame);
    }
    const view = this.host.ownerDocument.defaultView;
    if (!view) {
      this.syncLeftRailWithPdfSidebar(trigger);
      return;
    }
    this.sidebarRailFrame = view.requestAnimationFrame(() => {
      this.sidebarRailFrame = null;
      this.syncLeftRailWithPdfSidebar(trigger);
    });
  }

  /** Track the PDF sidebar edge every frame while it opens/closes. */
  private startSidebarFollowLoop(): void {
    if (this.destroyed || this.sidebarFollowFrame !== null) return;
    const view = this.host.ownerDocument.defaultView;
    if (!view) {
      this.syncLeftRailWithPdfSidebar(this.sidebarFollowTrigger);
      return;
    }
    if (this.sidebarFollowFrameCount === 0) {
      this.sidebarFollowMaxJump = 0;
      this.sidebarFollowReasons.clear();
      this.logSidebarRail("info", "pdf sidebar rail follow start", {
        trigger: this.sidebarFollowTrigger,
        lastOffset: this.sidebarLastOffset,
        lastReason: this.sidebarLastReason,
        followMs: BasePdfAdapter.SIDEBAR_FOLLOW_MS
      });
    }
    let lastOffset = Number.NaN;
    let stableFrames = 0;
    const tick = (now: number): void => {
      this.sidebarFollowFrame = null;
      if (this.destroyed) return;
      this.sidebarFollowFrameCount += 1;
      const diag = this.syncLeftRailWithPdfSidebar(
        this.sidebarFollowTrigger,
        this.sidebarFollowFrameCount
      );
      const offset = diag?.offset ?? 0;
      if (offset === lastOffset) stableFrames += 1;
      else {
        stableFrames = 0;
        lastOffset = offset;
      }
      if (now < this.sidebarFollowUntil || stableFrames < 4) {
        this.sidebarFollowFrame = view.requestAnimationFrame(tick);
        return;
      }
      this.logSidebarRail("info", "pdf sidebar rail follow end", {
        trigger: this.sidebarFollowTrigger,
        frames: this.sidebarFollowFrameCount,
        maxJump: this.sidebarFollowMaxJump,
        reasons: [...this.sidebarFollowReasons],
        finalOffset: this.sidebarLastOffset,
        finalReason: this.sidebarLastReason
      });
      this.sidebarFollowFrameCount = 0;
      this.sidebarFollowMaxJump = 0;
      this.sidebarFollowReasons.clear();
    };
    this.sidebarFollowFrame = view.requestAnimationFrame(tick);
  }

  private syncLeftRailWithPdfSidebar(
    trigger = "sync",
    followFrame?: number
  ): PdfSidebarOffsetDiag | null {
    const chrome = this.host.querySelector(".native-pdf-handwriting-chrome");
    if (!isHTMLElement(chrome)) return null;
    const diag = syncLeftChromeWithPdfSidebar(chrome, this.pdfLayoutScope());
    this.noteSidebarRailDiag(diag, trigger, followFrame);
    return diag;
  }

  private noteSidebarRailDiag(
    diag: PdfSidebarOffsetDiag,
    trigger: string,
    followFrame?: number
  ): void {
    const previousOffset = this.sidebarLastOffset;
    const previousReason = this.sidebarLastReason;
    const delta = diag.offset - previousOffset;
    const absJump = Math.abs(delta);
    this.sidebarFollowMaxJump = Math.max(this.sidebarFollowMaxJump, absJump);
    this.sidebarFollowReasons.add(diag.reason);

    const reasonChanged = previousReason !== null && previousReason !== diag.reason;
    const jump = absJump >= BasePdfAdapter.SIDEBAR_JUMP_WARN_PX;
    const interesting =
      reasonChanged
      || jump
      || followFrame === 1
      || trigger === "follow-start"
      || (followFrame != null && followFrame % 8 === 0 && absJump >= 2);

    if (interesting) {
      const level = jump || (previousReason === "geometry-clear" && diag.reason === "css-sidebar-width")
        ? "warn"
        : "info";
      this.logSidebarRail(level, "pdf sidebar rail offset", {
        trigger,
        followFrame: followFrame ?? null,
        offset: diag.offset,
        previousOffset,
        delta,
        reason: diag.reason,
        previousReason,
        open: diag.open,
        contentSidebarOpen: diag.contentSidebarOpen,
        sidebarFound: diag.sidebarFound,
        contentFound: diag.contentFound,
        cssSidebarWidth: diag.cssSidebarWidth,
        contentMarginLeft: diag.contentMarginLeft,
        chrome: diag.chrome,
        sidebar: diag.sidebar
      });
    }

    this.sidebarLastOffset = diag.offset;
    this.sidebarLastReason = diag.reason;
  }

  private logSidebarRail(
    level: "info" | "warn",
    event: string,
    payload: Record<string, unknown>
  ): void {
    if (level === "info") console.debug(LOG_PREFIX, event, payload);
    else console.warn(LOG_PREFIX, event, payload);
    this.callbacks.onDebugLog?.(level, event, payload);
  }

  private watchPdfSidebarLayout(): void {
    if (this.sidebarWatchInstalled) return;
    this.sidebarWatchInstalled = true;
    const scope = this.pdfLayoutScope();
    const content = findPdfContentContainer(scope);
    const sidebar = findPdfSidebarContainer(scope);
    const onLayout = (trigger: string): void => this.queueSyncLeftRailWithPdfSidebar(true, trigger);
    // Class / style toggles often land on content, the sidebar, or a parent pdf host.
    const classHosts = [content, sidebar, this.host, isElement(scope) ? scope : null]
      .filter((node): node is HTMLElement => isHTMLElement(node));
    if (classHosts.length > 0) {
      const observer = new MutationObserver(() => onLayout("mutation"));
      for (const host of new Set(classHosts)) {
        observer.observe(host, {
          attributes: true,
          attributeFilter: ["class", "style"],
          subtree: host === this.host || host === scope
        });
      }
      this.registerCleanup(() => observer.disconnect());
    }
    if (typeof ResizeObserver !== "undefined") {
      const resize = new ResizeObserver(() => onLayout("resize"));
      if (sidebar) resize.observe(sidebar);
      const chromeEl = this.host.querySelector(".native-pdf-handwriting-chrome");
      if (isHTMLElement(chromeEl)) resize.observe(chromeEl);
      this.registerCleanup(() => resize.disconnect());
    }
    const eventBus = this.compatibility.privateViewer?.eventBus;
    for (const event of ["sidebarviewchanged", "togglesidebar"] as const) {
      const handler = (): void => onLayout(event);
      eventBus?.on?.(event, handler);
      this.registerCleanup(() => eventBus?.off?.(event, handler));
    }
    // Thumbnail / outline toolbar buttons often toggle layout without eventBus in tests.
    const onClick = (): void => onLayout("click");
    this.host.addEventListener("click", onClick, true);
    this.registerCleanup(() => this.host.removeEventListener("click", onClick, true));
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
    if (this.sidebarRailFrame !== null) {
      this.host.ownerDocument.defaultView?.cancelAnimationFrame(this.sidebarRailFrame);
      this.sidebarRailFrame = null;
    }
    if (this.sidebarFollowFrame !== null) {
      this.host.ownerDocument.defaultView?.cancelAnimationFrame(this.sidebarFollowFrame);
      this.sidebarFollowFrame = null;
    }
    this.sidebarFollowUntil = 0;
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
      return !(isHTMLElement(target)) || !this.isInternalElement(target);
    }
    if (record.type !== "childList") return false;
    return [...record.addedNodes, ...record.removedNodes].some((node) => !this.isInternalNode(node));
  }

  private isInternalNode(node: Node): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      return parent ? this.isInternalElement(parent) : false;
    }
    return isHTMLElement(node) && this.isInternalElement(node);
  }

  private isInternalElement(element: HTMLElement): boolean {
    if (element.dataset.focusOverlayInternal === "true") return true;
    if (this.isPdfPlusElement(element)) return true;
    if (element.classList.contains("native-pdf-handwriting-page-overlay")) return true;
    if (element.classList.contains("native-pdf-handwriting-canvas")) return true;
    if (element.classList.contains("native-pdf-handwriting-selection-toolbar")) return true;
    if (element.classList.contains("native-pdf-handwriting-eraser-cursor")) return true;
    if (element.classList.contains("native-pdf-handwriting-draw-cursor")) return true;
    if (element.classList.contains("native-pdf-handwriting-toolbar")) return true;
    if (element.classList.contains("native-pdf-handwriting-rail")) return true;
    if (element.classList.contains("native-pdf-handwriting-chrome")) return true;
    return Boolean(element.closest(".native-pdf-handwriting-page-overlay, .native-pdf-handwriting-toolbar, .native-pdf-handwriting-selection-toolbar, .native-pdf-handwriting-rail, .native-pdf-handwriting-chrome"));
  }

  /** PDF++ injects backlink layers / palette — do not treat as page rebuilds. */
  private isPdfPlusElement(element: HTMLElement): boolean {
    for (const cls of element.classList) {
      if (cls.startsWith("pdf-plus-")) return true;
    }
    return Boolean(element.closest("[class*='pdf-plus-']"));
  }
}
