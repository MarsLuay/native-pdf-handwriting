/**
 * Cap ink canvas backing-store size.
 * Overlay CSS grows with PDF zoom; full css×dpr at 6–10× allocates multi‑million-pixel
 * buffers (×2 pages × inkLayer) — logs showed 0.5–3s settles with strokesRedrawn=0.
 */
export const MAX_INK_EDGE_PX = 2048;
export const MAX_INK_PIXELS = 2048 * 1536;

export interface InkBackingSize {
  pixelWidth: number;
  pixelHeight: number;
  /** Context transform scale: CSS layout px → backing pixels. */
  backingScale: number;
}

export function inkBackingSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
  maxEdge = MAX_INK_EDGE_PX,
  maxPixels = MAX_INK_PIXELS
): InkBackingSize {
  const cssW = Math.max(1, cssWidth);
  const cssH = Math.max(1, cssHeight);
  const dpr = Math.max(0.5, devicePixelRatio || 1);
  let pixelWidth = cssW * dpr;
  let pixelHeight = cssH * dpr;
  const edge = Math.max(pixelWidth, pixelHeight);
  let shrink = 1;
  if (edge > maxEdge) shrink = Math.min(shrink, maxEdge / edge);
  const area = pixelWidth * pixelHeight * shrink * shrink;
  if (area > maxPixels) shrink = Math.min(shrink, Math.sqrt(maxPixels / (pixelWidth * pixelHeight)));
  pixelWidth = Math.max(1, Math.round(pixelWidth * shrink));
  pixelHeight = Math.max(1, Math.round(pixelHeight * shrink));
  return {
    pixelWidth,
    pixelHeight,
    backingScale: pixelWidth / cssW
  };
}
