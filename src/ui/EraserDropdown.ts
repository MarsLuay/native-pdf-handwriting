import type { ToolPreferences } from "../model";
import type { DropdownOption } from "./DropdownController";

export function eraserOptions(preferences: ToolPreferences, select: (type: "stroke", size?: number) => void): DropdownOption[] {
  return [
    { id: "stroke", label: "Stroke Eraser", active: preferences.eraser.type === "stroke", onSelect: () => select("stroke") },
    { id: "segment", label: "Segment Eraser (coming soon)", disabled: true, onSelect: () => undefined },
    ...([8, 16, 28] as const).map((size) => ({
      id: `eraser-${size}`,
      label: size === 8 ? "Small" : size === 16 ? "Medium" : "Large",
      active: preferences.eraser.size === size,
      onSelect: () => select("stroke", size)
    }))
  ];
}
