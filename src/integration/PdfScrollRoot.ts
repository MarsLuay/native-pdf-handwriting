import type { PdfJsViewerLike } from "./PdfViewerCompatibility";

const OBSIDIAN_SCROLL_SELECTORS = [
  ".pdf-viewer-scroll-container",
  ".pdf-viewer-container",
  "#viewerContainer"
] as const;

const INNER_VIEWER_CLASSES = new Set(["pdfViewer", "pdf-viewer"]);

export interface ScrollPdfResult {
  changed: boolean;
  scrolled: HTMLElement | null;
  scrollBefore?: number;
  scrollAfter?: number;
  via?: "scrollTop" | "wheel" | "scrollBy";
}

export function resolvePdfScrollRoot(
  viewerRoot: HTMLElement,
  privateViewer?: PdfJsViewerLike,
  viewerHost?: HTMLElement
): HTMLElement {
  const obsidian = findObsidianPdfScrollContainer(viewerRoot, viewerHost);
  if (obsidian) return obsidian;

  const walkBases = viewerHost && viewerHost !== viewerRoot
    ? [viewerHost, viewerRoot]
    : [viewerRoot];

  for (const base of walkBases) {
    for (let node: HTMLElement | null = base; node; node = node.parentElement) {
      if (node.id === "viewerContainer" && canEffectivelyScroll(node)) return node;
      if (node.classList.contains("workspace-leaf-content") && canEffectivelyScroll(node)) return node;
      if (node.classList.contains("view-content") && canEffectivelyScroll(node)) return node;
    }
  }

  if (viewerHost && canEffectivelyScroll(viewerHost)) return viewerHost;

  const effective = findEffectiveScrollElement(viewerRoot, viewerHost);
  if (effective) return effective;

  if (privateViewer?.container instanceof HTMLElement && canEffectivelyScroll(privateViewer.container)) {
    return privateViewer.container;
  }

  return viewerHost ?? viewerRoot;
}

export function describeScrollElement(root: HTMLElement): string {
  const id = root.id ? `#${root.id}` : "";
  const classes = [...root.classList].slice(0, 2).join(".");
  const scrollable = root.scrollHeight > root.clientHeight;
  return `${root.tagName.toLowerCase()}${id}${classes ? `.${classes}` : ""} scrollable=${scrollable}`;
}

export function scrollPdfBy(root: HTMLElement, deltaY: number): boolean {
  return scrollPdfByDetailed(root, deltaY).changed;
}

export function scrollPdfByDetailed(
  root: HTMLElement,
  deltaY: number,
  clientX = 0,
  clientY = 0
): ScrollPdfResult {
  if (!deltaY) return { changed: false, scrolled: null };

  let node: HTMLElement | null = root;
  while (node) {
    if (!canScrollVertically(node)) {
      node = node.parentElement;
      continue;
    }

    const before = node.scrollTop;
    const obsidian = isObsidianPdfScrollContainer(node);

    if (obsidian) {
      const wheelResult = dispatchWheelScroll(node, deltaY, clientX, clientY, before);
      if (wheelResult) return wheelResult;
      if (typeof node.scrollBy === "function") {
        node.scrollBy(0, deltaY);
      } else {
        node.scrollTop += deltaY;
      }
      const afterScrollBy = node.scrollTop;
      if (afterScrollBy !== before) {
        return {
          changed: true,
          scrolled: node,
          scrollBefore: before,
          scrollAfter: afterScrollBy,
          via: "scrollBy"
        };
      }
    } else {
      node.scrollTop += deltaY;
      const afterScrollTop = node.scrollTop;
      if (afterScrollTop !== before) {
        return {
          changed: true,
          scrolled: node,
          scrollBefore: before,
          scrollAfter: afterScrollTop,
          via: "scrollTop"
        };
      }
      const wheelResult = dispatchWheelScroll(node, deltaY, clientX, clientY, before);
      if (wheelResult) return wheelResult;
    }

    node = node.parentElement;
  }

  return { changed: false, scrolled: null };
}

function findObsidianPdfScrollContainer(viewerRoot: HTMLElement, viewerHost?: HTMLElement): HTMLElement | null {
  const bases = [...new Set([viewerHost, viewerRoot.closest(".pdf-viewer-container"), viewerRoot].filter(Boolean))] as HTMLElement[];

  for (const base of bases) {
    for (const selector of OBSIDIAN_SCROLL_SELECTORS) {
      const scoped = base.matches(selector) ? base : base.querySelector<HTMLElement>(selector);
      if (scoped) return scoped;
    }

    for (let node: HTMLElement | null = base; node; node = node.parentElement) {
      if (node.classList.contains("pdf-viewer-scroll-container")) return node;
      if (node.classList.contains("pdf-viewer-container")) return node;
      if (node.id === "viewerContainer") return node;
    }
  }

  const pdfView = viewerRoot.closest<HTMLElement>("[data-type='pdf']");
  if (pdfView) {
    for (const selector of OBSIDIAN_SCROLL_SELECTORS) {
      const match = pdfView.querySelector<HTMLElement>(selector);
      if (match) return match;
    }
  }

  return null;
}

function dispatchWheelScroll(
  node: HTMLElement,
  deltaY: number,
  clientX: number,
  clientY: number,
  before: number
): ScrollPdfResult | null {
  node.dispatchEvent(new WheelEvent("wheel", {
    deltaY,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    bubbles: true,
    cancelable: true,
    clientX,
    clientY
  }));
  const after = node.scrollTop;
  if (after !== before) {
    return { changed: true, scrolled: node, scrollBefore: before, scrollAfter: after, via: "wheel" };
  }
  return null;
}

function isObsidianPdfScrollContainer(element: HTMLElement): boolean {
  return element.classList.contains("pdf-viewer-scroll-container")
    || element.classList.contains("pdf-viewer-container")
    || element.id === "viewerContainer";
}

function isInnerPdfViewer(element: HTMLElement): boolean {
  return [...element.classList].some((name) => INNER_VIEWER_CLASSES.has(name));
}

function canScrollVertically(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight + 1;
}

function canEffectivelyScroll(element: HTMLElement): boolean {
  if (!canScrollVertically(element)) return false;
  if (isInnerPdfViewer(element)) return false;
  const before = element.scrollTop;
  element.scrollTop = before + 1;
  const changed = element.scrollTop !== before;
  element.scrollTop = before;
  return changed;
}

function findEffectiveScrollElement(start: HTMLElement, viewerHost?: HTMLElement): HTMLElement | null {
  const insideObsidian = Boolean(findObsidianPdfScrollContainer(start, viewerHost));
  let node: HTMLElement | null = start;
  while (node) {
    if (insideObsidian && isInnerPdfViewer(node)) {
      node = node.parentElement;
      continue;
    }
    if (canEffectivelyScroll(node)) return node;
    node = node.parentElement;
  }
  return null;
}
