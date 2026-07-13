import type { ObsidianPdfAdapter, PdfAdapterCallbacks, PdfViewState } from "./ObsidianPdfAdapter";
import { PdfPageLocator, type PdfPageInfo } from "./PdfPageLocator";
import type { CompatibilityResult } from "./PdfViewerCompatibility";

export abstract class BasePdfAdapter implements ObsidianPdfAdapter {
  abstract readonly kind: "direct" | "embedded";
  readonly root: HTMLElement;
  protected readonly locator: PdfPageLocator;
  private readonly cleanup: Array<() => void> = [];
  private readonly mounted = new Set<HTMLElement>();
  private readonly callbacks: PdfAdapterCallbacks;
  private destroyed = false;

  protected constructor(protected readonly compatibility: CompatibilityResult, callbacks: PdfAdapterCallbacks = {}) {
    this.root = compatibility.viewerRoot!;
    this.callbacks = callbacks;
    this.locator = new PdfPageLocator(this.root, compatibility.privateViewer);
    for (const warning of compatibility.warnings) callbacks.onCompatibilityWarning?.(warning);
    this.listen();
  }

  pages(): PdfPageInfo[] {
    return this.locator.pages();
  }

  getViewState(): PdfViewState {
    const page = this.locator.page(this.locator.currentPage()) ?? this.pages()[0];
    const denominator = Math.max(1, this.root.scrollHeight - this.root.clientHeight);
    return {
      pageNumber: page?.pageNumber ?? 1,
      scrollFraction: Math.max(0, Math.min(1, this.root.scrollTop / denominator)),
      scale: page?.scale ?? 1,
      rotation: page?.rotation ?? 0
    };
  }

  restoreViewState(state: PdfViewState): void {
    const page = this.locator.page(state.pageNumber);
    page?.element.scrollIntoView?.({ block: "start" });
    const denominator = Math.max(0, this.root.scrollHeight - this.root.clientHeight);
    this.root.scrollTop = denominator * Math.max(0, Math.min(1, state.scrollFraction));
  }

  mountOverlay(pageNumber: number): HTMLElement {
    const page = this.locator.page(pageNumber);
    if (!page) throw new Error(`Cannot mount annotation overlay: PDF page ${pageNumber} is unavailable`);
    const overlay = page.element.ownerDocument.createElement("div");
    overlay.className = "native-pdf-ink-page-overlay";
    overlay.dataset.pageNumber = String(pageNumber);
    overlay.dataset.focusOverlayInternal = "true";
    page.element.append(overlay);
    this.mounted.add(overlay);
    return overlay;
  }

  mountToolbar(toolbar: HTMLElement): void {
    const host = this.compatibility.toolbarHost ?? this.root.parentElement ?? this.root;
    host.append(toolbar);
    this.mounted.add(toolbar);
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
    const notify = (): void => this.callbacks.onViewStateChange?.(this.getViewState());
    this.root.addEventListener("scroll", notify, { passive: true });
    this.registerCleanup(() => this.root.removeEventListener("scroll", notify));

    const observer = new MutationObserver(() => this.callbacks.onPagesChanged?.());
    observer.observe(this.root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-page-number", "data-rotation", "data-scale"] });
    this.registerCleanup(() => observer.disconnect());

    const eventBus = this.compatibility.privateViewer?.eventBus;
    for (const event of ["pagechanging", "scalechanging", "rotationchanging"]) {
      eventBus?.on?.(event, notify);
      this.registerCleanup(() => eventBus?.off?.(event, notify));
    }
  }
}
