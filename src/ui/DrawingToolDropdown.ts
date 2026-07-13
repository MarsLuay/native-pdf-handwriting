import { DEFAULT_SETTINGS, type DrawingTool, type ToolPreferences } from "../model";
import type { DropdownOption } from "./DropdownController";

export const DRAWING_WIDTHS = [0.8, 1.5, 2.5, 4.5, 7] as const;
const WIDTH_LABELS = ["Extra Fine", "Fine", "Medium", "Thick", "Extra Thick"] as const;

export function drawingOptions(
  preferences: ToolPreferences,
  selectTool: (tool: DrawingTool) => void,
  selectWidth: (width: number) => void
): DropdownOption[] {
  const tool = preferences.activeTool === "pencil" ? "pencil" : "pen";
  const drawing = preferences[tool];
  const tools: DropdownOption[] = (["pen", "pencil"] as const).map((id) => ({
    id,
    label: id === "pen" ? "Pen" : "Pencil",
    active: tool === id,
    onSelect: () => selectTool(id)
  }));
  const widths: DropdownOption[] = DRAWING_WIDTHS.map((width, index) => ({
    id: `width-${width}`,
    label: `${WIDTH_LABELS[index]} (${width})`,
    active: drawing.width === width,
    render: (button) => {
      const preview = button.ownerDocument.createElement("span");
      preview.className = "native-pdf-ink-width-preview";
      preview.style.setProperty("--ink-preview-width", `${width}px`);
      preview.style.setProperty("--ink-preview-color", drawing.color);
      button.prepend(preview);
    },
    onSelect: () => selectWidth(width)
  }));
  return [...tools, ...widths];
}

export function drawingAdvanced(
  document: Document,
  preferences: ToolPreferences,
  onChange: () => void,
  signal: AbortSignal
): HTMLElement {
  const tool = preferences.activeTool === "pencil" ? "pencil" : "pen";
  const drawing = preferences[tool];
  const details = document.createElement("details");
  details.className = "native-pdf-ink-advanced";
  const summary = document.createElement("summary");
  summary.textContent = "Advanced settings";
  details.append(summary);
  const fields: Array<[string, keyof typeof drawing, number, number, number]> = [
    ["Opacity", "opacity", 0.1, 1, 0.05],
    ["Thinning", "thinning", 0, 1, 0.05],
    ["Texture", "textureStrength", 0, 1, 0.05]
  ];
  for (const [label, key, min, max, step] of fields) {
    const wrapper = document.createElement("label");
    wrapper.textContent = label;
    const input = document.createElement("input");
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
    const wrapper = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = drawing[key];
    input.addEventListener("change", () => {
      drawing[key] = input.checked;
      onChange();
    }, { signal });
    wrapper.append(input, label);
    details.append(wrapper);
  }
  const stabilization = document.createElement("select");
  stabilization.setAttribute("aria-label", "Stabilization");
  for (const value of ["off", "low", "medium", "high"] as const) {
    const option = document.createElement("option");
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
  const restore = document.createElement("button");
  restore.type = "button";
  restore.textContent = "Restore tool defaults";
  restore.addEventListener("click", () => {
    Object.assign(drawing, DEFAULT_SETTINGS.toolPreferences[tool]);
    onChange();
  }, { signal });
  details.append(restore);
  return details;
}
