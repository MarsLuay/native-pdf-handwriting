export interface EmbedAnnotateChromeOptions {
  onAnnotate: () => void;
  label?: string;
}

const TOOLBAR_SELECTORS = ".pdf-toolbar, .pdf-toolbar-container";

function findEmbedToolbar(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(TOOLBAR_SELECTORS);
}

/** Obsidian embed overflow ("…") lives in `.pdf-toolbar-right` as lucide-more-vertical. */
function findMoreOptionsControl(scope: HTMLElement): HTMLElement | null {
  const icon = scope.querySelector(".lucide-more-vertical, .lucide-ellipsis-vertical, .lucide-ellipsis");
  if (!(icon instanceof Element)) return null;
  return icon.closest<HTMLElement>(".clickable-icon") ?? (icon.parentElement instanceof HTMLElement ? icon.parentElement : null);
}

function resolveToolbarMount(host: HTMLElement): { parent: HTMLElement; before: Node | null } | null {
  const toolbar = findEmbedToolbar(host);
  if (!toolbar) return null;

  const right = toolbar.querySelector<HTMLElement>(".pdf-toolbar-right");
  if (right) {
    return { parent: right, before: findMoreOptionsControl(right) };
  }

  const more = findMoreOptionsControl(toolbar);
  if (more?.parentElement) {
    return { parent: more.parentElement, before: more };
  }

  return { parent: toolbar, before: null };
}

/** Annotate control mounted into the embed PDF toolbar (does not cover native buttons). */
export class EmbedAnnotateChrome {
  readonly element: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly abort = new AbortController();
  private destroyed = false;
  private observer: MutationObserver | null = null;

  constructor(
    readonly host: HTMLElement,
    private readonly options: EmbedAnnotateChromeOptions
  ) {
    host.classList.add("native-pdf-ink-embed-host");

    this.element = host.ownerDocument.createElement("div");
    this.element.className = "native-pdf-ink-embed-chrome";
    this.element.dataset.nativePdfInkEmbedChrome = "true";

    this.button = host.ownerDocument.createElement("button");
    this.button.type = "button";
    this.button.className = "native-pdf-ink-embed-annotate clickable-icon";
    this.button.textContent = options.label ?? "Annotate";
    this.button.setAttribute("aria-label", "Annotate PDF");
    this.button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.options.onAnnotate();
    }, { signal: this.abort.signal });

    this.element.append(this.button);
    this.mountIntoToolbarOrWatch();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    this.observer?.disconnect();
    this.observer = null;
    this.element.remove();
    this.host.classList.remove("native-pdf-ink-embed-host");
  }

  private mountIntoToolbarOrWatch(): void {
    if (this.tryMountIntoToolbar() && this.isToolbarMountSettled()) return;

    // Toolbar / "…" often appear after the embed finishes loading — wait, then join left of "…".
    this.observer = new MutationObserver(() => {
      if (this.destroyed) return;
      if (this.tryMountIntoToolbar() && this.isToolbarMountSettled()) {
        this.observer?.disconnect();
        this.observer = null;
      }
    });
    this.observer.observe(this.host, { childList: true, subtree: true });
    if (!findEmbedToolbar(this.host)) this.mountFloatingFallback();
  }

  private isToolbarMountSettled(): boolean {
    return findMoreOptionsControl(this.host) !== null
      || this.host.querySelector(".pdf-toolbar-right") !== null;
  }

  private tryMountIntoToolbar(): boolean {
    const mount = resolveToolbarMount(this.host);
    if (!mount) return false;
    this.removeDuplicateChromeNodes();
    this.element.classList.remove("is-floating");
    const { parent, before } = mount;
    if (this.element.parentElement !== parent || this.element.nextSibling !== before) {
      parent.insertBefore(this.element, before);
    }
    return true;
  }

  private mountFloatingFallback(): void {
    // Bottom-left so we do not cover Obsidian's native top embed/PDF controls.
    this.removeDuplicateChromeNodes();
    this.element.classList.add("is-floating");
    if (getComputedStyle(this.host).position === "static") {
      this.host.style.position = "relative";
    }
    if (this.element.parentElement !== this.host) {
      this.host.append(this.element);
    }
  }

  /** Idempotent: MutationObserver + host re-renders must not leave duplicate Annotate chips. */
  private removeDuplicateChromeNodes(): void {
    for (const node of this.host.querySelectorAll("[data-native-pdf-ink-embed-chrome='true']")) {
      if (node !== this.element) node.remove();
    }
  }
}

export function findExistingEmbedChrome(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>("[data-native-pdf-ink-embed-chrome='true']");
}

export { findEmbedToolbar, findMoreOptionsControl };
