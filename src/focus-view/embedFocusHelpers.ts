import type { App, TFile } from "obsidian";

export function resolvePdfFileFromEmbed(app: App, host: HTMLElement, sourcePath: string): TFile | null {
  const raw =
    host.getAttribute("src")
    ?? host.getAttribute("data-path")
    ?? host.getAttribute("alt")
    ?? "";
  const linkpath = raw.split("#")[0]?.trim() ?? "";
  if (!linkpath) return null;
  const file = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
  if (file && file.extension.toLowerCase() === "pdf") return file;
  return null;
}
