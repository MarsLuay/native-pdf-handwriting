import { DEFAULT_SETTINGS, type ToolPreferences } from "../model";

export function defaultToolPreferences(): ToolPreferences {
  return structuredClone(DEFAULT_SETTINGS.toolPreferences);
}

export function mergeToolPreferences(value?: Partial<ToolPreferences>): ToolPreferences {
  const defaults = defaultToolPreferences();
  if (!value) return defaults;
  return {
    ...defaults, ...value,
    pen: { ...defaults.pen, ...value.pen },
    pencil: { ...defaults.pencil, ...value.pencil },
    eraser: { ...defaults.eraser, ...value.eraser },
    lasso: { ...defaults.lasso, ...value.lasso },
    recentColors: value.recentColors ? [...value.recentColors] : defaults.recentColors
  };
}

