export function isSelectablePdfTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, button, [contenteditable='true']")) return true;
  if (target.closest(".annotationLayer a, .annotationLayer button, .annotationLayer input, .annotationLayer textarea")) return true;
  // PDF++ backlinks / palette — pass through when Draw is off (mouse-pan skip).
  if (target.closest(".pdf-plus-backlink, .pdf-plus-color-palette, .pdf-plus-backlink-highlight-layer")) return true;
  const glyph = target.closest(".textLayer span, .textLayer br, .text-layer span, .text-layer br");
  if (glyph instanceof HTMLSpanElement) return Boolean(glyph.textContent?.trim());
  if (glyph instanceof HTMLBRElement) return true;
  return false;
}
