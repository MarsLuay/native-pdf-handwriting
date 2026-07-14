import { describe, expect, it, vi } from "vitest";
import { EmbedAnnotateChrome, findExistingEmbedChrome } from "../src/focus-view/EmbedAnnotateChrome";
import { EmbeddedPdfAdapter } from "../src/integration/EmbeddedPdfAdapter";
import { resolvePdfFileFromEmbed } from "../src/focus-view/embedFocusHelpers";

function pdfEmbedHost(withToolbar = false): HTMLElement {
  const host = document.createElement("div");
  host.className = "internal-embed";
  host.setAttribute("src", "folder/paper.pdf");
  if (withToolbar) {
    const toolbar = document.createElement("div");
    toolbar.className = "pdf-toolbar";
    const right = document.createElement("div");
    right.className = "pdf-toolbar-right";
    const spacer = document.createElement("div");
    spacer.className = "pdf-toolbar-spacer";
    const more = document.createElement("div");
    more.className = "clickable-icon";
    more.setAttribute("aria-label", "Open");
    const icon = document.createElement("svg");
    icon.classList.add("lucide-more-vertical");
    more.append(icon);
    right.append(spacer, more);
    toolbar.append(right);
    host.append(toolbar);
  }
  const viewer = document.createElement("div");
  viewer.className = "pdf-viewer";
  const page = document.createElement("div");
  page.className = "page";
  page.dataset.pageNumber = "1";
  viewer.append(page);
  host.append(viewer);
  return host;
}

describe("embed annotate chrome", () => {
  it("mounts Annotate left of the embed … (more) control", () => {
    const host = pdfEmbedHost(true);
    document.body.append(host);
    const right = host.querySelector(".pdf-toolbar-right")!;
    const more = right.querySelector(".lucide-more-vertical")!.closest(".clickable-icon");
    const onAnnotate = vi.fn();
    const chrome = new EmbedAnnotateChrome(host, { onAnnotate });

    expect(chrome.element.parentElement).toBe(right);
    expect(chrome.element.nextSibling).toBe(more);
    expect(chrome.element.classList.contains("is-floating")).toBe(false);
    expect(host.querySelectorAll(".native-pdf-ink-embed-annotate")).toHaveLength(1);

    host.querySelector<HTMLButtonElement>(".native-pdf-ink-embed-annotate")?.click();
    expect(onAnnotate).toHaveBeenCalledOnce();

    chrome.destroy();
    expect(findExistingEmbedChrome(host)).toBeNull();
    expect(right.querySelector(".lucide-more-vertical")).toBeTruthy();
    host.remove();
  });

  it("removes duplicate chrome nodes left from host re-renders", () => {
    const host = pdfEmbedHost(true);
    document.body.append(host);
    const chrome = new EmbedAnnotateChrome(host, { onAnnotate: () => undefined });
    const orphan = document.createElement("div");
    orphan.className = "native-pdf-ink-embed-chrome";
    orphan.dataset.nativePdfInkEmbedChrome = "true";
    orphan.textContent = "orphan";
    host.querySelector(".pdf-toolbar-right")!.append(orphan);

    expect(host.querySelectorAll("[data-native-pdf-ink-embed-chrome='true']")).toHaveLength(2);
    // Force remount path used by MutationObserver.
    (chrome as unknown as { tryMountIntoToolbar: () => boolean }).tryMountIntoToolbar();
    expect(host.querySelectorAll("[data-native-pdf-ink-embed-chrome='true']")).toHaveLength(1);
    expect(findExistingEmbedChrome(host)).toBe(chrome.element);

    chrome.destroy();
    host.remove();
  });

  it("moves from floating fallback into toolbar when it appears later", async () => {
    const host = pdfEmbedHost(false);
    document.body.append(host);
    const chrome = new EmbedAnnotateChrome(host, { onAnnotate: () => undefined });
    expect(chrome.element.classList.contains("is-floating")).toBe(true);

    const toolbar = document.createElement("div");
    toolbar.className = "pdf-toolbar";
    const right = document.createElement("div");
    right.className = "pdf-toolbar-right";
    const more = document.createElement("div");
    more.className = "clickable-icon";
    const icon = document.createElement("svg");
    icon.classList.add("lucide-more-vertical");
    more.append(icon);
    right.append(more);
    toolbar.append(right);
    host.insertBefore(toolbar, host.firstChild);
    await Promise.resolve();
    await Promise.resolve();

    expect(chrome.element.parentElement).toBe(right);
    expect(chrome.element.nextSibling).toBe(more);
    expect(chrome.element.classList.contains("is-floating")).toBe(false);
    chrome.destroy();
    host.remove();
  });

  it("discovers note PDF embeds for chrome mounting", () => {
    const note = document.createElement("div");
    note.append(pdfEmbedHost());
    expect(EmbeddedPdfAdapter.discover(note)).toHaveLength(1);
  });

  it("resolves PDF file from embed src via metadata cache", () => {
    const file = { path: "folder/paper.pdf", extension: "pdf" };
    const app = {
      metadataCache: {
        getFirstLinkpathDest: vi.fn(() => file)
      }
    };
    const host = pdfEmbedHost();
    expect(resolvePdfFileFromEmbed(app as never, host, "Notes/a.md")).toBe(file);
    expect(app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith("folder/paper.pdf", "Notes/a.md");
  });
});
