import type { PdfPageInfo } from "../integration/PdfPageLocator";

export interface SelectPagesForInkMountOptions {
  mobile: boolean;
  currentPage: number;
  scrollRoot: HTMLElement | null;
  /** Neighbor pages to keep mounted around the visible/current set. */
  pad?: number;
}

/**
 * On mobile, mounting ink canvases for every DOM page OOMs Obsidian's WebView
 * (large textbooks often keep many `.page` nodes in the tree). Prefer pages that
 * intersect the scroll viewport, else current page ± pad.
 */
export function selectPagesForInkMount(
  pages: PdfPageInfo[],
  options: SelectPagesForInkMountOptions
): PdfPageInfo[] {
  if (!options.mobile || pages.length <= 3) return pages;
  const pad = options.pad ?? 1;
  const root = options.scrollRoot;
  let seeds: PdfPageInfo[] = [];
  if (root) {
    const rootRect = root.getBoundingClientRect();
    seeds = pages.filter((page) => {
      const rect = page.element.getBoundingClientRect();
      return rect.bottom > rootRect.top
        && rect.top < rootRect.bottom
        && rect.width > 0
        && rect.height > 0;
    });
  }
  if (seeds.length === 0) {
    seeds = pages.filter((page) => page.pageNumber === options.currentPage);
  }
  if (seeds.length === 0) {
    seeds = pages.slice(0, 1);
  }
  const keep = new Set<number>();
  for (const page of seeds) {
    for (let delta = -pad; delta <= pad; delta += 1) keep.add(page.pageNumber + delta);
  }
  const selected = pages.filter((page) => keep.has(page.pageNumber));
  if (selected.length > 0) return selected;
  return pages.slice(0, Math.min(3, pages.length));
}
