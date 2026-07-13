import type { LassoType, SelectionMode, ToolPreferences } from "../model";
import type { DropdownOption } from "./DropdownController";

export function lassoOptions(
  preferences: ToolPreferences,
  selectType: (type: LassoType) => void,
  selectMode: (mode: SelectionMode) => void
): DropdownOption[] {
  const labels: Record<LassoType, string> = {
    freeform: "Freeform Lasso",
    ellipse: "Circle / Ellipse Lasso",
    rectangle: "Square / Rectangle Lasso"
  };
  return [
    ...(["freeform", "ellipse", "rectangle"] as const).map((type) => ({
      id: type,
      label: labels[type],
      active: preferences.lasso.type === type,
      onSelect: () => selectType(type)
    })),
    ...(["enclosed", "intersecting"] as const).map((mode) => ({
      id: mode,
      label: mode === "enclosed" ? "Select fully enclosed strokes" : "Select intersecting strokes",
      active: preferences.lasso.selectionMode === mode,
      onSelect: () => selectMode(mode)
    }))
  ];
}
