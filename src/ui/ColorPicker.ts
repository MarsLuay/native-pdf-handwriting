import { setElementCssProps } from "../dom/typeGuards";
import { resolveDrawingTool, type ToolPreferences } from "../model";
import type { DropdownOption } from "./DropdownController";

export function colorOptions(preferences: ToolPreferences, select: (color: string) => void): DropdownOption[] {
  const tool = resolveDrawingTool(preferences.activeTool);
  return preferences.recentColors.map((color) => ({
    id: color,
    label: color,
    active: preferences[tool].color.toLowerCase() === color.toLowerCase(),
    render: (button) => {
      const swatch = button.ownerDocument.createElement("span");
      swatch.className = "native-pdf-handwriting-color-swatch";
      setElementCssProps(swatch, { "background-color": color });
      button.prepend(swatch);
    },
    onSelect: () => select(color)
  }));
}
