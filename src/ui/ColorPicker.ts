import type { DrawingTool, ToolPreferences } from "../model";
import type { DropdownOption } from "./DropdownController";

export function colorOptions(preferences: ToolPreferences, select: (color: string) => void): DropdownOption[] {
  const tool: DrawingTool = preferences.activeTool === "pencil" ? "pencil" : "pen";
  return preferences.recentColors.map((color) => ({
    id: color,
    label: color,
    active: preferences[tool].color.toLowerCase() === color.toLowerCase(),
    render: (button) => {
      const swatch = button.ownerDocument.createElement("span");
      swatch.className = "native-pdf-ink-color-swatch";
      swatch.style.backgroundColor = color;
      button.prepend(swatch);
    },
    onSelect: () => select(color)
  }));
}
