import { setElementCssProps } from "../dom/typeGuards";
import {
  DEFAULT_SETTINGS,
  DRAWING_TOOLS,
  resolveDrawingTool,
  type DrawingTool,
  type ToolPreferences
} from "../model";
import type { DropdownOption } from "./DropdownController";

export const DRAWING_WIDTHS = [0.35, 0.5, 0.8, 1.5, 2.5, 4.5, 7] as const;
export const HIGHLIGHTER_WIDTHS = [6, 10, 14, 18, 24, 32, 40] as const;
const WIDTH_LABELS = ["Hairline", "Ultra Fine", "Extra Fine", "Fine", "Medium", "Thick", "Extra Thick"] as const;
const HIGHLIGHTER_WIDTH_LABELS = [
  "Narrow",
  "Fine",
  "Medium",
  "Wide",
  "Broad",
  "Extra Broad",
  "Max"
] as const;

const TOOL_LABELS: Record<DrawingTool, string> = {
  pen: "Pen",
  pencil: "Pencil",
  highlighter: "Highlighter"
};

export function drawingOptions(
  preferences: ToolPreferences,
  selectTool: (tool: DrawingTool) => void,
  selectWidth: (width: number) => void
): DropdownOption[] {
  const tool = resolveDrawingTool(preferences.activeTool);
  const drawing = preferences[tool];
  const tools: DropdownOption[] = DRAWING_TOOLS.map((id) => ({
    id,
    label: TOOL_LABELS[id],
    active: tool === id,
    onSelect: () => selectTool(id)
  }));
  const widths = tool === "highlighter" ? HIGHLIGHTER_WIDTHS : DRAWING_WIDTHS;
  const labels = tool === "highlighter" ? HIGHLIGHTER_WIDTH_LABELS : WIDTH_LABELS;
  const widthOptions: DropdownOption[] = widths.map((width, index) => ({
    id: `width-${width}`,
    label: `${labels[index]} (${width})`,
    active: drawing.width === width,
    render: (button) => {
      const preview = button.ownerDocument.createSpan();
      preview.className = "native-pdf-handwriting-width-preview";
      setElementCssProps(preview, {
        "--ink-preview-width": `${Math.min(12, width)}px`,
        "--ink-preview-color": drawing.color
      });
      button.prepend(preview);
    },
    onSelect: () => selectWidth(width)
  }));
  return [...tools, ...widthOptions];
}

export function drawingAdvanced(
  ownerDocument: Document,
  preferences: ToolPreferences,
  onChange: () => void,
  signal: AbortSignal
): HTMLElement {
  const tool = resolveDrawingTool(preferences.activeTool);
  const drawing = preferences[tool];
  const details = ownerDocument.createEl('details');
  details.className = "native-pdf-handwriting-advanced";
  const summary = ownerDocument.createEl('summary');
  summary.textContent = "Advanced settings";
  details.append(summary);
  const shapeRecognition = ownerDocument.createEl('label');
  const shapeRecognitionInput = ownerDocument.createEl('input');
  shapeRecognitionInput.type = "checkbox";
  shapeRecognitionInput.checked = preferences.shape.holdToRecognize;
  shapeRecognitionInput.dataset.setting = "shape-recognition";
  shapeRecognitionInput.addEventListener("change", () => {
    preferences.shape.holdToRecognize = shapeRecognitionInput.checked;
    onChange();
  }, { signal });
  shapeRecognition.append(shapeRecognitionInput, "Recognize shapes after a 0.5-second hold");
  details.append(shapeRecognition);
  const fields: Array<[string, keyof typeof drawing, number, number, number]> = [
    ["Opacity", "opacity", 0.1, 1, 0.05],
    ["Thinning", "thinning", 0, 1, 0.05],
    ["Texture", "textureStrength", 0, 1, 0.05]
  ];
  for (const [label, key, min, max, step] of fields) {
    if (tool === "highlighter" && key === "textureStrength") continue;
    const wrapper = ownerDocument.createEl('label');
    wrapper.textContent = label;
    const input = ownerDocument.createEl('input');
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(drawing[key]);
    input.addEventListener("input", () => {
      (drawing[key] as number) = Number(input.value);
      onChange();
    }, { signal });
    wrapper.append(input);
    details.append(wrapper);
  }
  for (const [label, key] of [
    ["Pressure sensitivity", "pressureSensitivity"],
    ["Tilt sensitivity", "tiltSensitivity"],
    ["Simulate mouse pressure", "simulateMousePressure"]
  ] as const) {
    if (tool === "highlighter" && key === "tiltSensitivity") continue;
    const wrapper = ownerDocument.createEl('label');
    const input = ownerDocument.createEl('input');
    input.type = "checkbox";
    input.checked = drawing[key];
    input.addEventListener("change", () => {
      drawing[key] = input.checked;
      onChange();
    }, { signal });
    wrapper.append(input, label);
    details.append(wrapper);
  }
  const stabilization = ownerDocument.createEl('select');
  stabilization.setAttribute("aria-label", "Stabilization");
  for (const value of ["off", "low", "medium", "high"] as const) {
    const option = ownerDocument.createEl('option');
    option.value = value;
    option.textContent = value[0]?.toUpperCase() + value.slice(1);
    option.selected = drawing.stabilization === value;
    stabilization.append(option);
  }
  stabilization.addEventListener("change", () => {
    drawing.stabilization = stabilization.value as typeof drawing.stabilization;
    onChange();
  }, { signal });
  details.append(stabilization);
  const restore = ownerDocument.createEl('button');
  restore.type = "button";
  restore.textContent = "Restore tool defaults";
  restore.addEventListener("click", () => {
    Object.assign(drawing, DEFAULT_SETTINGS.toolPreferences[tool]);
    onChange();
  }, { signal });
  details.append(restore);
  return details;
}
