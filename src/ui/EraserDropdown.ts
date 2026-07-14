import type { ToolPreferences } from "../model";

export const ERASER_SIZE_MIN = 4;
export const ERASER_SIZE_MAX = 100;
export const ERASER_SIZE_STEP = 1;

export interface EraserMenuCallbacks {
  onPreview(size: number): void;
  onCommit(size: number): void;
}

export function eraserMenu(
  document: Document,
  preferences: ToolPreferences,
  callbacks: EraserMenuCallbacks,
  signal: AbortSignal
): HTMLElement {
  const content = document.createElement("div");
  content.className = "native-pdf-ink-eraser-menu";

  const previewFrame = document.createElement("div");
  previewFrame.className = "native-pdf-ink-eraser-preview-frame";
  previewFrame.style.setProperty("--ink-eraser-preview-frame-size", `${ERASER_SIZE_MAX}px`);

  const preview = document.createElement("span");
  preview.className = "native-pdf-ink-eraser-preview";
  preview.setAttribute("aria-hidden", "true");
  previewFrame.append(preview);

  const value = document.createElement("span");
  value.className = "native-pdf-ink-eraser-size-value";

  const updatePreview = (size: number): void => {
    preview.style.setProperty("--ink-eraser-preview-size", `${size}px`);
    value.textContent = `${size}px`;
  };

  const label = document.createElement("label");
  label.className = "native-pdf-ink-eraser-size-label";
  label.textContent = "Eraser size";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = String(ERASER_SIZE_MIN);
  slider.max = String(ERASER_SIZE_MAX);
  slider.step = String(ERASER_SIZE_STEP);
  slider.value = String(clampEraserSize(preferences.eraser.size));
  slider.setAttribute("aria-label", "Eraser size");

  updatePreview(Number(slider.value));

  slider.addEventListener("input", () => {
    const size = clampEraserSize(Number(slider.value));
    updatePreview(size);
    callbacks.onPreview(size);
  }, { signal });

  slider.addEventListener("change", () => {
    callbacks.onCommit(clampEraserSize(Number(slider.value)));
  }, { signal });

  label.append(slider, value);
  content.append(previewFrame, label);
  return content;
}

export function clampEraserSize(size: number): number {
  if (!Number.isFinite(size)) return 12;
  return Math.min(ERASER_SIZE_MAX, Math.max(ERASER_SIZE_MIN, Math.round(size)));
}
