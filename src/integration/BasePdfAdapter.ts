import { createDetachedDiv } from "../vendor/createDetached";
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
import { PDF_PAGE_SELECTOR } from "./pdfPageSelectors";
import { installPdfZoomBoost, type PdfZoomBoostHandle } from "./PdfZoomBoost";

const LOG_PREFIX = "[Handwriting Natively]";

export abstract class BasePdfAdapter implements ObsidianPdfAdapter {
  abstract readonly kind: "direct" | "embedded";
  readonly host: HTMLElement;
  readonly root: HTMLElement;
  protected readonly locator: PdfPageLocator;
  private readonly cleanup: Array<() => void> = [];
  private readonly mounted = new Set<HTMLElement>();
  private readonly callbacks: PdfAdapterCallbacks;
  private zoomBoost: PdfZoomBoostHandle | null = null;
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
  /** Sampled non-left toolbar layout events; these must never start an rAF loop. */
  private ignoredSidebarLayoutTriggers = 0;
  private lastIgnoredSidebarLayoutLogAt = 0;
  /** Sampled count of PDF.js inner-layer mutations that must not remount overlays. */
  private ignoredPageContentMutations = 0;
  private lastIgnoredPageContentLogAt = 0;
  /** Coalesced `.page` structure mutations (can fire hundreds/sec on attach). */
  private pageStructureMutations = 0;
  private lastPageStructureLogAt = 0;
  /** Cover Obsidian PDF sidebar open/close transitions (often ~250–400ms). */
  private static readonly SIDEBAR_FOLLOW_MS = 480;
  private static readonly SIDEBAR_JUMP_WARN_PX = 24;
  private static readonly SIDEBAR_IGNORED_LAYOUT_LOG_INTERVAL_MS = 500;
  /** Keep observer diagnostics useful without writing one entry for every PDF.js paint frame. */
  private static readonly PAGE_CONTENT_MUTATION_LOG_INTERVAL_MS = 250;
  private static readonly PAGE_STRUCTURE_LOG_INTERVAL_MS = 250;

  protected constructor(
    protected readonly compatibility: CompatibilityResult,
    host: HTMLElement,
    callbacks: PdfAdapterCallbacks = {}
  ) {
    this.host = host;
    this.root = compatibility.viewerRoot!;
    this.callbacks = callbacks;
    this.locator = new PdfPageLocator(this.root, compatibility.privateViewer);
    this.registerCleanup(() => this.zoomBoost?.destroy());
    for (const warning of compatibility.warnings) callbacks.onCompatibilityWarning?.(warning);
    this.listen();
  }

  pages(): PdfPageInfo[] {
    return this.locator.pages();
  }

  setBoostedZoom(enabled: boolean): void {
    if (enabled && !this.zoomBoost) this.zoomBoost = installPdfZoomBoost(this.compatibility.privateViewer);
    if (!enabled && this.zoomBoost) {
      this.zoomBoost.destroy();
      this.zoomBoost = null;
    }
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

  mountOverlay(pageNumber: number): HTMLElement {
    const page = this.locator.page(pageNumber);
    if (!page) throw new Error(`Cannot mount annotation overlay: PDF page ${pageNumber} is unavailable`);
    const overlay = createDetachedDiv(page.element.ownerDocument);
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
      this.stopSidebarFollowLoop();
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
    const rail = createDetachedDiv(toolbar.ownerDocument);
    rail.className = `native-pdf-handwriting-rail is-${placement}`;
    toolbar.classList.add(placement === "left" ? "is-sidebar-left" : "is-sidebar-right");
    rail.append(toolbar);
    // DOM order is a fallback; CSS grid columns on chrome pin left vs right.
    if (placement === "left") chrome.insertBefore(rail, chrome.firstChild);
    else chrome.append(rail);
    this.mounted.add(rail);
    this.mounted.add(toolbar);
    // Catch full-pane rail stretch (missing is-toolbar-* / max-content blowup).
    const railLayout = this.viewportLayout(rail);
    const chromeLayout = this.viewportLayout(chrome);
    const wrapNode = chrome.querySelector(".pdf-viewer-container, .pdf-viewer-scroll-container, #viewerContainer");
    this.logSidebarRail("info", "pdf sidebar rail mounted", {
      placement,
      chromeClasses: [...chrome.classList],
      railClasses: [...rail.classList],
      chrome: chromeLayout,
      rail: railLayout,
      wrapTarget: this.viewportLayout(isHTMLElement(wrapNode) ? wrapNode : this.scrollElement())
    });
    const railWidth = Number((railLayout.rect as { width?: number } | undefined)?.width ?? 0);
    const chromeWidth = Number((chromeLayout.rect as { width?: number } | undefined)?.width ?? 0);
    if (chromeWidth > 0 && railWidth > Math.max(80, chromeWidth * 0.25)) {
      this.logSidebarRail("warn", "pdf sidebar rail oversized", {
        placement,
        chromeClasses: [...chrome.classList],
        railWidth,
        chromeWidth
      });
    }
    if (placement === "left") {
      this.watchPdfSidebarLayout();
      this.queueSyncLeftRailWithPdfSidebar(false, "mount-toolbar");
    } else {
      // A right rail never needs left-sidebar offset tracking. Clear any
      // previous left offset once, then stop a pending left-follow loop.
      this.stopSidebarFollowLoop();
      this.syncLeftRailWithPdfSidebar("toolbar-right");
    }
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
    const chrome = createDetachedDiv(wrapTarget.ownerDocument);
    chrome.className = "native-pdf-handwriting-chrome";
    // Insert at the scroll host's seat so an in-flow PDF sidebar sibling stays left of chrome.
    parent.insertBefore(chrome, wrapTarget);
    chrome.append(wrapTarget);
    this.logSidebarRail("info", "pdf sidebar rail mount", {
      wrapTarget: this.viewportLayout(wrapTarget),
      parent: this.viewportLayout(parent),
      root: this.viewportLayout(this.root)
    });
    this.mounted.add(chrome);
    this.registerCleanup(() => this.unwrapSidebarChrome());
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
    if (!this.isLeftToolbarActive()) {
      this.stopSidebarFollowLoop();
      return;
    }
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
    if (this.destroyed || this.sidebarFollowFrame !== null || !this.isLeftToolbarActive()) return;
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
      if (this.destroyed || !this.isLeftToolbarActive()) {
        this.stopSidebarFollowLoop();
        return;
      }
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

  private stopSidebarFollowLoop(): void {
    if (this.sidebarFollowFrame !== null) {
      this.host.ownerDocument.defaultView?.cancelAnimationFrame(this.sidebarFollowFrame);
      this.sidebarFollowFrame = null;
    }
    this.sidebarFollowUntil = 0;
    this.sidebarFollowFrameCount = 0;
    this.sidebarFollowMaxJump = 0;
    this.sidebarFollowReasons.clear();
  }

  private isLeftToolbarActive(): boolean {
    const chrome = this.host.querySelector(".native-pdf-handwriting-chrome");
    return isHTMLElement(chrome) && chrome.classList.contains("is-toolbar-left");
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
        sidebar: diag.sidebar,
        viewport: this.viewportLayout(this.scrollElement())
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

  /** Native PDF viewport metrics expose width/inset regressions during sidebar transitions. */
  private viewportLayout(element: HTMLElement): Record<string, unknown> {
    const rect = element.getBoundingClientRect();
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return {
      tag: element.tagName.toLowerCase(),
      classes: [...element.classList],
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
      rect: {
        left: Math.round(rect.left * 10) / 10,
        right: Math.round(rect.right * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10
      },
      position: style?.position ?? "",
      width: style?.width ?? "",
      insetInlineStart: style?.insetInlineStart ?? "",
      insetInlineEnd: style?.insetInlineEnd ?? ""
    };
  }

  private watchPdfSidebarLayout(): void {
    if (this.sidebarWatchInstalled) return;
    this.sidebarWatchInstalled = true;
    const scope = this.pdfLayoutScope();
    const content = findPdfContentContainer(scope);
    const sidebar = findPdfSidebarContainer(scope);
    const onLayout = (trigger: string): void => {
      if (!this.isLeftToolbarActive()) {
        this.noteIgnoredSidebarLayoutTrigger(trigger);
        return;
      }
      this.queueSyncLeftRailWithPdfSidebar(true, trigger);
    };
    // Sidebar transitions toggle one of these containers. Never observe the
    // whole descendant tree: PDF.js and annotation style churn would otherwise
    // restart a 480 ms rail-follow loop on every paint frame.
    const classHosts = [content, sidebar, this.host, isElement(scope) ? scope : null]
      .filter((node): node is HTMLElement => isHTMLElement(node));
    if (classHosts.length > 0) {
      const watched = new Set(classHosts);
      const observer = new MutationObserver((records) => {
        if (records.some((record) => isHTMLElement(record.target) && watched.has(record.target))) {
          onLayout("mutation");
        }
      });
      for (const host of new Set(classHosts)) {
        observer.observe(host, {
          attributes: true,
          attributeFilter: ["class", "style"]
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

  private noteIgnoredSidebarLayoutTrigger(trigger: string): void {
    this.ignoredSidebarLayoutTriggers += 1;
    const now = Date.now();
    if (now - this.lastIgnoredSidebarLayoutLogAt < BasePdfAdapter.SIDEBAR_IGNORED_LAYOUT_LOG_INTERVAL_MS) return;
    this.logSidebarRail("info", "pdf sidebar rail ignored layout", {
      trigger,
      ignoredTriggers: this.ignoredSidebarLayoutTriggers,
      reason: "not-left-toolbar"
    });
    this.ignoredSidebarLayoutTriggers = 0;
    this.lastIgnoredSidebarLayoutLogAt = now;
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
      let pageStructureRecords = 0;
      let ignoredPageContentRecords = 0;
      for (const record of records) {
        // A PDF.js page may replace all of its inner children, including our
        // overlay, while keeping the outer `.page` node. The removed overlay
        // is an internal node, so it needs an explicit escape hatch here;
        // otherwise the session never gets a chance to reattach it.
        const annotationOverlayRemoved = record.type === "childList" && this.removesAnnotationOverlay(record);
        if (!annotationOverlayRemoved && !this.isExternalMutation(record)) continue;
        if (record.type === "childList") {
          // PDF.js replaces canvas/text-layer children while zooming. Those
          // updates do not replace a .page node, so remounting our overlay for
          // every one makes all annotations visibly blink at zoom settle.
          if (this.isPdfPageStructureMutation(record)) {
            childListChanged = true;
            pageStructureRecords += 1;
          } else {
            ignoredPageContentRecords += 1;
          }
          continue;
        }
        if (record.type !== "attributes") continue;
        if (record.attributeName === "data-scale") scaleChanged = true;
        else if (record.attributeName === "data-rotation") rotationChanged = true;
        else if (record.attributeName === "data-page-number") childListChanged = true;
      }
      if (ignoredPageContentRecords) {
        this.logIgnoredPageContentMutations(ignoredPageContentRecords);
        this.callbacks.onPageContentMutation?.(ignoredPageContentRecords);
      }
      if (childListChanged) {
        this.logPageStructureMutations(pageStructureRecords, scaleChanged, rotationChanged);
        this.callbacks.onPagesChanged?.("pages-dom");
      }
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

  /** Only a page node (or a wrapper containing one) needs overlay reconciliation. */
  private isPdfPageStructureMutation(record: MutationRecord): boolean {
    return [...record.addedNodes, ...record.removedNodes].some((node) => this.nodeContainsPdfPage(node));
  }

  /** Detect a direct or wrapped removal of one of our page overlays. */
  private removesAnnotationOverlay(record: MutationRecord): boolean {
    return [...record.removedNodes].some((node) => this.nodeContainsAnnotationOverlay(node));
  }

  private nodeContainsAnnotationOverlay(node: Node): boolean {
    if (!isHTMLElement(node)) return false;
    if (node.classList.contains("native-pdf-handwriting-page-overlay")) return true;
    return Boolean(node.querySelector(".native-pdf-handwriting-page-overlay"));
  }

  private nodeContainsPdfPage(node: Node): boolean {
    if (!isHTMLElement(node)) return false;
    if (this.isPdfPageElement(node)) return true;
    return Boolean(node.querySelector(PDF_PAGE_SELECTOR));
  }

  private isPdfPageElement(element: HTMLElement): boolean {
    return element.matches(PDF_PAGE_SELECTOR);
  }

  private logPageStructureMutations(
    records: number,
    scaleChanged: boolean,
    rotationChanged: boolean
  ): void {
    this.pageStructureMutations += records;
    const now = Date.now();
    if (now - this.lastPageStructureLogAt < BasePdfAdapter.PAGE_STRUCTURE_LOG_INTERVAL_MS) return;
    this.logAdapterEvent("info", "pdf page observer", {
      action: "page-structure",
      records: this.pageStructureMutations,
      scaleChanged,
      rotationChanged
    });
    this.pageStructureMutations = 0;
    this.lastPageStructureLogAt = now;
  }

  private logIgnoredPageContentMutations(records: number): void {
    this.ignoredPageContentMutations += records;
    const now = Date.now();
    if (now - this.lastIgnoredPageContentLogAt < BasePdfAdapter.PAGE_CONTENT_MUTATION_LOG_INTERVAL_MS) return;
    this.logAdapterEvent("info", "pdf page observer", {
      action: "ignored-page-content",
      records: this.ignoredPageContentMutations
    });
    this.ignoredPageContentMutations = 0;
    this.lastIgnoredPageContentLogAt = now;
  }

  private logAdapterEvent(level: "info" | "warn", event: string, payload: Record<string, unknown>): void {
    if (level === "info") console.debug(LOG_PREFIX, event, payload);
    else console.warn(LOG_PREFIX, event, payload);
    this.callbacks.onDebugLog?.(level, event, payload);
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
