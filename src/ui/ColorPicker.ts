import { setElementCssProps } from "../dom/typeGuards";
import { resolveDrawingTool, type ToolPreferences } from "../model";
import type { DropdownOption } from "./DropdownController";

export const HIGHLIGHTER_COLORS = ["#FFF59D", "#F8BBD0", "#B2DFDB", "#B3E5FC", "#D1C4E9"] as const;

export function colorOptions(preferences: ToolPreferences, select: (color: string) => void): DropdownOption[] {
  const tool = resolveDrawingTool(preferences.activeTool);
  const colors = tool === "highlighter" ? HIGHLIGHTER_COLORS : preferences.recentColors;
  return colors.map((color) => ({
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
