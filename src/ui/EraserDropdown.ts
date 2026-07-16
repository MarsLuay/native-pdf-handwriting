import { setElementCssProps } from "../dom/typeGuards";
import type { ToolPreferences } from "../model";

export const ERASER_SIZE_MIN = 4;
export const ERASER_SIZE_MAX = 100;
export const ERASER_SIZE_STEP = 1;

export interface EraserMenuCallbacks {
  onPreview(size: number): void;
  onCommit(size: number): void;
  onWholeStrokeChange(enabled: boolean): void;
  onRightMouseButtonChange(enabled: boolean): void;
}

export function eraserMenu(
  ownerDocument: Document,
  preferences: ToolPreferences,
  callbacks: EraserMenuCallbacks,
  signal: AbortSignal
): HTMLElement {
  const content = ownerDocument.createElement("div");
  content.className = "native-pdf-handwriting-eraser-menu";

  const previewFrame = ownerDocument.createElement("div");
  previewFrame.className = "native-pdf-handwriting-eraser-preview-frame";
  setElementCssProps(previewFrame, { "--ink-eraser-preview-frame-size": `${ERASER_SIZE_MAX}px` });

  const preview = ownerDocument.createElement("span");
  preview.className = "native-pdf-handwriting-eraser-preview";
  preview.setAttribute("aria-hidden", "true");
  previewFrame.append(preview);

  const value = ownerDocument.createElement("span");
  value.className = "native-pdf-handwriting-eraser-size-value";

  const updatePreview = (size: number): void => {
    setElementCssProps(preview, { "--ink-eraser-preview-size": `${size}px` });
    value.textContent = `${size}px`;
  };

  const label = ownerDocument.createElement("label");
  label.className = "native-pdf-handwriting-eraser-size-label";
  label.textContent = "Eraser size";

  const slider = ownerDocument.createElement("input");
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
  const wholeStrokeLabel = ownerDocument.createElement("label");
  wholeStrokeLabel.className = "native-pdf-handwriting-eraser-whole-stroke";
  const wholeStroke = ownerDocument.createElement("input");
  wholeStroke.type = "checkbox";
  wholeStroke.checked = preferences.eraser.eraseWholeStrokes;
  wholeStroke.dataset.control = "eraser-whole-stroke";
  wholeStroke.addEventListener("change", () => callbacks.onWholeStrokeChange(wholeStroke.checked), { signal });
  wholeStrokeLabel.append(wholeStroke, ownerDocument.createTextNode("Erase whole strokes"));
  const rightMouseLabel = ownerDocument.createElement("label");
  rightMouseLabel.className = "native-pdf-handwriting-eraser-right-mouse";
  const rightMouse = ownerDocument.createElement("input");
  rightMouse.type = "checkbox";
  rightMouse.checked = preferences.eraser.eraseWithRightMouseButton;
  rightMouse.dataset.control = "eraser-right-mouse";
  rightMouse.addEventListener("change", () => callbacks.onRightMouseButtonChange(rightMouse.checked), { signal });
  rightMouseLabel.append(rightMouse, ownerDocument.createTextNode("Use right mouse button as eraser"));
  content.append(previewFrame, label, wholeStrokeLabel, rightMouseLabel);
  return content;
}

export function clampEraserSize(size: number): number {
  if (!Number.isFinite(size)) return 12;
  return Math.min(ERASER_SIZE_MAX, Math.max(ERASER_SIZE_MIN, Math.round(size)));
}
