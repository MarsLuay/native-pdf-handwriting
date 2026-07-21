import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describePdfPageDom,
  queryPdfPageNodes,
  waitForPdfPageNodes
} from "../src/integration/pdfPageSelectors";

describe("pdfPageSelectors", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("resolves immediately when numbered pages already exist", async () => {
    const root = document.createElement("div");
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = "1";
    root.append(page);
    await expect(waitForPdfPageNodes(root, 1_000)).resolves.toBe(true);
    expect(queryPdfPageNodes(root)).toHaveLength(1);
  });

  it("waits for data-page-number to appear on mobile-style delayed mount", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    const page = document.createElement("div");
    page.className = "page";
    root.append(page);

    const pending = waitForPdfPageNodes(root, 5_000);
    queueMicrotask(() => {
      page.dataset.pageNumber = "1";
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(true);
  });

  it("times out when pages never appear", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    const pending = waitForPdfPageNodes(root, 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBe(false);
  });

  it("describePdfPageDom reports candidate pages without numbers", () => {
    const root = document.createElement("div");
    root.className = "pdf-viewer";
    const page = document.createElement("div");
    page.className = "page";
    root.append(page);
    expect(describePdfPageDom(root)).toMatchObject({
      viewerRoot: true,
      numberedPageCount: 0,
      candidatePageCount: 1,
      firstCandidateHasPageNumber: false
    });
  });
});
