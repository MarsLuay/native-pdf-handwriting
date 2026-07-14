import type { LassoType, ToolPreferences } from "../model";
import type { DropdownOption } from "./DropdownController";

export function lassoOptions(
  preferences: ToolPreferences,
  selectType: (type: LassoType) => void
): DropdownOption[] {
  const labels: Record<LassoType, string> = {
    freeform: "Freeform Lasso",
    rectangle: "Square / Rectangle Lasso"
  };
  return (["freeform", "rectangle"] as const).map((type) => ({
    id: type,
    label: labels[type],
    active: preferences.lasso.type === type,
    onSelect: () => selectType(type)
  }));
}
