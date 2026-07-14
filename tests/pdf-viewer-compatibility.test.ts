import { describe, expect, it, vi } from "vitest";
import { PdfViewerCompatibility } from "../src/integration/PdfViewerCompatibility";

describe("PdfViewerCompatibility private viewer", () => {
  it("waits view.viewer promise then binds nested pdfViewer", async () => {
    const nested = {
      currentScale: 1.25,
      updateScale: vi.fn(),
      currentPageNumber: 2
    };
    const obsidian = {
      currentScale: 1,
      pdfViewer: nested,
      eventBus: { on: vi.fn(), off: vi.fn() }
    };
    const child = { pdfViewer: obsidian };
    const view = {
      viewer: {
        then(onFulfilled: (c: typeof child) => void) {
          queueMicrotask(() => onFulfilled(child));
        }
      }
    };
    const bound = await PdfViewerCompatibility.resolvePrivateViewerFromPdfView(view);
    expect(bound?.currentScale).toBe(1.25);
    expect(bound?.currentPageNumber).toBe(2);
    expect(bound?.eventBus).toBe(obsidian.eventBus);
  });

  it("uses already-ready child without waiting", async () => {
    const nested = { currentScale: 2, updateScale: vi.fn() };
    const view = {
      viewer: {
        child: { pdfViewer: { pdfViewer: nested, eventBus: {} } }
      }
    };
    const bound = await PdfViewerCompatibility.resolvePrivateViewerFromPdfView(view);
    expect(bound?.currentScale).toBe(2);
  });
});
