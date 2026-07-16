import { setElementCssProps } from "../dom/typeGuards";
import { DEFAULT_SETTINGS, resolveDrawingTool, type DrawingTool, type ToolPreferences } from "../model";
import type { DropdownOption } from "./DropdownController";
import { createToolbarIcon } from "./ToolbarIcon";

export const DRAWING_WIDTHS = [0.35, 0.5, 0.8, 1.5, 2.5, 4.5, 7] as const;
const WIDTH_LABELS = ["Hairline", "Ultra Fine", "Extra Fine", "Fine", "Medium", "Thick", "Extra Thick"] as const;
export const HIGHLIGHTER_WIDTHS = [1.5, 3, 4.5, 7, 10, 14, 20] as const;
const HIGHLIGHTER_WIDTH_LABELS = ["Fine", "Medium", "Thick", "Extra Thick", "Broad", "Very Broad", "Maximum"] as const;

export function drawingOptions(
  preferences: ToolPreferences,
  selectTool: (tool: DrawingTool) => void,
  selectWidth: (width: number) => void,
  selectedTool?: DrawingTool,
  showToolOptions = true
): DropdownOption[] {
  const tool = selectedTool ?? resolveDrawingTool(preferences.activeTool);
  const drawing = preferences[tool];
  const widths = tool === "highlighter" ? HIGHLIGHTER_WIDTHS : DRAWING_WIDTHS;
  const widthLabels = tool === "highlighter" ? HIGHLIGHTER_WIDTH_LABELS : WIDTH_LABELS;
  const tools: DropdownOption[] = (["pen", "pencil", "highlighter"] as const).map((id) => ({
    id,
    label: id === "pen" ? "Pen" : id === "pencil" ? "Pencil" : "Highlight",
    active: tool === id,
    render: (button) => button.prepend(createToolbarIcon(button.ownerDocument, id)),
    onSelect: () => selectTool(id)
  }));
  const widthOptions: DropdownOption[] = widths.map((width, index) => ({
    id: `width-${width}`,
    label: `${widthLabels[index]} (${width})`,
    active: drawing.width === width,
    render: (button) => {
      const preview = button.ownerDocument.createElement("span");
      preview.className = "native-pdf-handwriting-width-preview";
      setElementCssProps(preview, { "--ink-preview-width": `${width}px`, "--ink-preview-color": drawing.color });
      button.prepend(preview);
    },
    onSelect: () => selectWidth(width)
  }));
  return showToolOptions ? [...tools, ...widthOptions] : widthOptions;
}

export function drawingAdvanced(
  ownerDocument: Document,
  preferences: ToolPreferences,
  onChange: () => void,
  signal: AbortSignal,
  selectedTool?: DrawingTool
): HTMLElement {
  const tool = selectedTool ?? resolveDrawingTool(preferences.activeTool);
  const drawing = preferences[tool];
  const details = ownerDocument.createElement("details");
  details.className = "native-pdf-handwriting-advanced";
  const summary = ownerDocument.createElement("summary");
  summary.textContent = "Advanced settings";
  details.append(summary);
  const fields: Array<[string, keyof typeof drawing, number, number, number]> = [
    ["Opacity", "opacity", 0.1, 1, 0.05],
    ["Thinning", "thinning", 0, 1, 0.05],
    ["Texture", "textureStrength", 0, 1, 0.05]
  ];
  for (const [label, key, min, max, step] of fields) {
    const wrapper = ownerDocument.createElement("label");
    wrapper.textContent = label;
    const input = ownerDocument.createElement("input");
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
    const wrapper = ownerDocument.createElement("label");
    const input = ownerDocument.createElement("input");
    input.type = "checkbox";
    input.checked = drawing[key];
    input.addEventListener("change", () => {
      drawing[key] = input.checked;
      onChange();
    }, { signal });
    wrapper.append(input, label);
    details.append(wrapper);
  }
  const stabilization = ownerDocument.createElement("select");
  stabilization.setAttribute("aria-label", "Stabilization");
  for (const value of ["off", "low", "medium", "high"] as const) {
    const option = ownerDocument.createElement("option");
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
  const restore = ownerDocument.createElement("button");
  restore.type = "button";
  restore.textContent = "Restore tool defaults";
  restore.addEventListener("click", () => {
    Object.assign(drawing, DEFAULT_SETTINGS.toolPreferences[tool]);
    onChange();
  }, { signal });
  details.append(restore);
  return details;
}
