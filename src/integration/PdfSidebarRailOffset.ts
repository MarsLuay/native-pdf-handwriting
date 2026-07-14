import { isHTMLElement } from "../dom/typeGuards";

export const INK_PDF_SIDEBAR_OFFSET_VAR = "--ink-pdf-sidebar-offset";

export type PdfSidebarOffsetReason =
  | "geometry-overlap"
  | "geometry-clear"
  | "css-sidebar-width"
  | "content-margin-clear"
  | "closed"
  | "not-left-toolbar";

export interface PdfSidebarOffsetDiag {
  offset: number;
  reason: PdfSidebarOffsetReason;
  open: boolean;
  sidebarFound: boolean;
  contentFound: boolean;
  contentSidebarOpen: boolean;
  cssSidebarWidth: number;
  contentMarginLeft: number;
  chrome: { left: number; right: number; width: number };
  sidebar: { left: number; right: number; width: number; height: number } | null;
}

/** Obsidian outline/thumbnail host inside a PDF leaf. */
export function findPdfSidebarContainer(scope: ParentNode): HTMLElement | null {
  const direct = scope.querySelector(".pdf-sidebar-container");
  if (isHTMLElement(direct)) return direct;

  // Fall back when the container class changes but view panes still exist.
  const pane = scope.querySelector(".pdf-thumbnail-view, .pdf-outline-view");
  if (!isHTMLElement(pane)) return null;
  let node: HTMLElement | null = pane.parentElement;
  while (node) {
    if (
      node.classList.contains("pdf-sidebar-container")
      || node.classList.contains("pdf-sidebar")
      || (node.className.includes("sidebar") && node !== pane)
    ) {
      return node;
    }
    // Prefer the nearest ancestor that is a sibling of the scroll/content pane.
    const parent = node.parentElement;
    if (
      parent
      && (
        parent.classList.contains("pdf-content-container")
        || parent.classList.contains("pdf-container")
        || parent.querySelector(":scope > .pdf-viewer-scroll-container, :scope > .pdf-viewer-container")
      )
    ) {
      return node;
    }
    node = parent;
  }
  return pane.parentElement;
}

export function findPdfContentContainer(scope: ParentNode): HTMLElement | null {
  const found = scope.querySelector(".pdf-content-container");
  return isHTMLElement(found) ? found : null;
}

function readCssLengthPx(element: HTMLElement, property: string): number {
  const view = element.ownerDocument.defaultView;
  if (!view) return 0;
  const raw = view.getComputedStyle(element).getPropertyValue(property).trim();
  if (!raw) return 0;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundRect(left: number, right: number, width: number, height = 0): {
  left: number;
  right: number;
  width: number;
  height: number;
} {
  return {
    left: Math.round(left * 10) / 10,
    right: Math.round(right * 10) / 10,
    width: Math.round(width * 10) / 10,
    height: Math.round(height * 10) / 10
  };
}

export function isPdfSidebarOpen(
  content: HTMLElement | null,
  sidebar: HTMLElement | null,
  scope?: ParentNode | null
): boolean {
  if (content?.classList.contains("sidebarOpen")) return true;
  if (scope instanceof Element && scope.classList.contains("sidebarOpen")) return true;
  if (scope) {
    const openHost = scope.querySelector(
      ".pdf-content-container.sidebarOpen, .pdf-container.sidebarOpen, .sidebarOpen"
    );
    if (openHost) return true;
    const pane = scope.querySelector(".pdf-thumbnail-view, .pdf-outline-view");
    if (isHTMLElement(pane) && pane.offsetWidth >= 8 && pane.offsetHeight >= 8) {
      const style = pane.ownerDocument.defaultView?.getComputedStyle(pane);
      if (!style || (style.display !== "none" && style.visibility !== "hidden")) return true;
    }
  }
  if (!sidebar?.isConnected) return false;
  if (sidebar.offsetWidth < 8 || sidebar.offsetHeight < 8) return false;
  const style = sidebar.ownerDocument.defaultView?.getComputedStyle(sidebar);
  if (!style) return sidebar.offsetWidth >= 8;
  if (style.display === "none" || style.visibility === "hidden") return false;
  return true;
}

/**
 * Explain live overlap of the PDF sidebar over the chrome's left edge.
 * Geometry wins so open/close animations track frame-by-frame. Once the
 * sidebar rect is clear of the chrome, return 0 immediately — never snap
 * back to `--sidebar-width` (that glitches on close when `sidebarOpen`
 * flips before the transform finishes).
 */
export function diagnosePdfSidebarOverlap(
  chrome: HTMLElement,
  sidebar: HTMLElement | null,
  content: HTMLElement | null = findPdfContentContainer(chrome.ownerDocument),
  scope: ParentNode | null = chrome.parentElement
): PdfSidebarOffsetDiag {
  const chromeRect = chrome.getBoundingClientRect();
  const cssHost = content ?? sidebar ?? chrome;
  const cssSidebarWidth = readCssLengthPx(cssHost, "--sidebar-width");
  const contentMarginLeft = content ? readCssLengthPx(content, "margin-left") : 0;
  const open = isPdfSidebarOpen(content, sidebar, scope);
  const base = {
    open,
    sidebarFound: Boolean(sidebar),
    contentFound: Boolean(content),
    contentSidebarOpen: Boolean(content?.classList.contains("sidebarOpen")),
    cssSidebarWidth: Math.round(cssSidebarWidth * 10) / 10,
    contentMarginLeft: Math.round(contentMarginLeft * 10) / 10,
    chrome: roundRect(chromeRect.left, chromeRect.right, chromeRect.width)
  };

  if (sidebar) {
    const side = sidebar.getBoundingClientRect();
    const sidebarBox = roundRect(side.left, side.right, side.width, side.height);
    if (side.height >= 8) {
      if (side.width >= 0.5 && side.right > chromeRect.left + 0.5 && side.left < chromeRect.right) {
        const overlap = side.right - chromeRect.left;
        if (overlap > 0) {
          return {
            ...base,
            offset: Math.max(0, Math.round(overlap)),
            reason: "geometry-overlap",
            sidebar: sidebarBox
          };
        }
      }
      // Measured and clearly clear of the rail — do not use CSS fallback.
      if (side.width >= 0.5 && side.right <= chromeRect.left + 0.5) {
        return {
          ...base,
          offset: 0,
          reason: "geometry-clear",
          sidebar: sidebarBox
        };
      }
    }
    if (!open) {
      return { ...base, offset: 0, reason: "closed", sidebar: sidebarBox };
    }
  } else if (!open) {
    return { ...base, offset: 0, reason: "closed", sidebar: null };
  }

  if (cssSidebarWidth < 8) {
    return { ...base, offset: 0, reason: "closed", sidebar: null };
  }
  // Content already reserved the sidebar strip — do not double-pad.
  if (contentMarginLeft >= cssSidebarWidth - 1) {
    return {
      ...base,
      offset: 0,
      reason: "content-margin-clear",
      sidebar: sidebar
        ? roundRect(
          sidebar.getBoundingClientRect().left,
          sidebar.getBoundingClientRect().right,
          sidebar.getBoundingClientRect().width,
          sidebar.getBoundingClientRect().height
        )
        : null
    };
  }
  return {
    ...base,
    offset: Math.round(cssSidebarWidth),
    reason: "css-sidebar-width",
    sidebar: sidebar
      ? roundRect(
        sidebar.getBoundingClientRect().left,
        sidebar.getBoundingClientRect().right,
        sidebar.getBoundingClientRect().width,
        sidebar.getBoundingClientRect().height
      )
      : null
  };
}

export function pdfSidebarOverlapOffset(
  chrome: HTMLElement,
  sidebar: HTMLElement | null,
  content: HTMLElement | null = findPdfContentContainer(chrome.ownerDocument),
  scope: ParentNode | null = chrome.parentElement
): number {
  return diagnosePdfSidebarOverlap(chrome, sidebar, content, scope).offset;
}

export function applyPdfSidebarRailOffset(chrome: HTMLElement, offsetPx: number): void {
  const rounded = Math.max(0, Math.round(offsetPx));
  if (rounded > 0) {
    chrome.style.setProperty(INK_PDF_SIDEBAR_OFFSET_VAR, `${rounded}px`);
    chrome.dataset.pdfSidebarOffset = String(rounded);
  } else {
    chrome.style.removeProperty(INK_PDF_SIDEBAR_OFFSET_VAR);
    delete chrome.dataset.pdfSidebarOffset;
  }
}

export function syncLeftChromeWithPdfSidebar(
  chrome: HTMLElement,
  scope: ParentNode
): PdfSidebarOffsetDiag {
  if (!chrome.classList.contains("is-toolbar-left")) {
    applyPdfSidebarRailOffset(chrome, 0);
    const chromeRect = chrome.getBoundingClientRect();
    return {
      offset: 0,
      reason: "not-left-toolbar",
      open: false,
      sidebarFound: false,
      contentFound: false,
      contentSidebarOpen: false,
      cssSidebarWidth: 0,
      contentMarginLeft: 0,
      chrome: roundRect(chromeRect.left, chromeRect.right, chromeRect.width),
      sidebar: null
    };
  }
  const sidebar = findPdfSidebarContainer(scope);
  const content = findPdfContentContainer(scope);
  const diag = diagnosePdfSidebarOverlap(chrome, sidebar, content, scope);
  applyPdfSidebarRailOffset(chrome, diag.offset);
  return diag;
}
