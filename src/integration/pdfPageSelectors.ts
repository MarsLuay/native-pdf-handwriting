/** Canonical rendered-page selectors shared by attach, locator, and observers. */
export const PDF_PAGE_SELECTOR =
  ".page[data-page-number], .pdf-page-view[data-page-number]";

/** Present before PDF.js stamps `data-page-number` (common on first mobile paint). */
export const PDF_PAGE_CANDIDATE_SELECTOR = ".page, .pdf-page-view";

export function queryPdfPageNodes(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(PDF_PAGE_SELECTOR));
}

export function queryPdfPageCandidates(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(PDF_PAGE_CANDIDATE_SELECTOR));
}

/**
 * Wait until at least one numbered page node exists under `root`.
 * Mobile PDF.js often mounts the viewer shell before page nodes.
 */
export function waitForPdfPageNodes(root: HTMLElement, timeoutMs = 5_000): Promise<boolean> {
  if (queryPdfPageNodes(root).length > 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(ok);
    };

    const observer = new MutationObserver(() => {
      if (queryPdfPageNodes(root).length > 0) finish(true);
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-page-number"]
    });

    const timer = window.setTimeout(() => {
      finish(queryPdfPageNodes(root).length > 0);
    }, timeoutMs);
  });
}

export function describePdfPageDom(root: HTMLElement | undefined): Record<string, unknown> {
  if (!root) {
    return { viewerRoot: false };
  }
  const pages = queryPdfPageNodes(root);
  const candidates = queryPdfPageCandidates(root);
  return {
    viewerRoot: true,
    viewerRootClasses: root.className || null,
    numberedPageCount: pages.length,
    candidatePageCount: candidates.length,
    firstCandidateTag: candidates[0]?.tagName ?? null,
    firstCandidateClasses: candidates[0]?.className || null,
    firstCandidateHasPageNumber: candidates[0]?.hasAttribute("data-page-number") ?? false
  };
}
