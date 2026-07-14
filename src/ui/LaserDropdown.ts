import { setElementCssProps } from "../dom/typeGuards";
import type { ToolPreferences } from "../model";
import type { DropdownOption } from "./DropdownController";

export const LASER_WIDTHS = [1, 1.5, 2, 2.5, 4, 6] as const;
const LASER_WIDTH_LABELS = ["Fine", "Medium", "Standard", "Bold", "Heavy", "Beam"] as const;

export const LASER_HOLD_MIN = 200;
export const LASER_HOLD_MAX = 3000;
export const LASER_FADE_MIN = 300;
export const LASER_FADE_MAX = 4000;

/** Bound laser timing from UI range input to finite milliseconds. */
export function clampLaserTimingMs(raw: number, min: number, max: number): number {
  if (!Number.isFinite(raw)) return min;
  return Math.min(max, Math.max(min, Math.round(raw)));
}

export function laserWidthOptions(
  preferences: ToolPreferences,
  selectWidth: (width: number) => void
): DropdownOption[] {
  const width = preferences.laser.width;
  return LASER_WIDTHS.map((value, index) => ({
    id: `laser-width-${value}`,
    label: `${LASER_WIDTH_LABELS[index]} (${value})`,
    active: width === value,
    render: (button) => {
      const preview = button.ownerDocument.createElement("span");
      preview.className = "native-pdf-handwriting-width-preview";
      setElementCssProps(preview, {
        "--ink-preview-width": `${Math.min(12, value)}px`,
        "--ink-preview-color": preferences.laser.color
      });
      button.prepend(preview);
    },
    onSelect: () => selectWidth(value)
  }));
}

export function laserMenu(
  ownerDocument: Document,
  preferences: ToolPreferences,
  onChange: () => void,
  signal: AbortSignal
): HTMLElement {
  const content = ownerDocument.createElement("div");
  content.className = "native-pdf-handwriting-laser-menu";

  const note = ownerDocument.createElement("p");
  note.className = "native-pdf-handwriting-laser-note";
  note.textContent = "Laser strokes fade away and are never saved.";
  content.append(note);

  const widthButtons: HTMLButtonElement[] = [];

  const syncWidthChecks = (): void => {
    const selected = preferences.laser.width;
    for (const button of widthButtons) {
      const id = button.dataset.optionId ?? "";
      const value = Number(id.replace("laser-width-", ""));
      const active = value === selected;
      button.setAttribute("aria-checked", String(active));
    }
  };

  for (const option of laserWidthOptions(preferences, (width) => {
    preferences.laser.width = width;
    preferences.activeTool = "laser";
    syncWidthChecks();
    onChange();
  })) {
    const button = ownerDocument.createElement("button");
    button.type = "button";
    button.className = "native-pdf-handwriting-dropdown-option";
    button.dataset.optionId = option.id;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(option.active ?? false));
    button.textContent = option.label;
    option.render?.(button);
    button.addEventListener("click", () => {
      option.onSelect();
    }, { signal });
    widthButtons.push(button);
    content.append(button);
  }

  const addRange = (
    labelText: string,
    key: "holdMs" | "fadeMs",
    min: number,
    max: number
  ): void => {
    const label = ownerDocument.createElement("label");
    label.className = "native-pdf-handwriting-laser-range";
    label.textContent = labelText;
    const value = ownerDocument.createElement("span");
    value.className = "native-pdf-handwriting-laser-range-value";
    const input = ownerDocument.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = "50";
    input.value = String(clampLaserTimingMs(preferences.laser[key], min, max));
    const sync = (): void => {
      const next = clampLaserTimingMs(Number(input.value), min, max);
      input.value = String(next);
      preferences.laser[key] = next;
      preferences.activeTool = "laser";
      value.textContent = `${(next / 1000).toFixed(1)}s`;
      onChange();
    };
    value.textContent = `${(clampLaserTimingMs(preferences.laser[key], min, max) / 1000).toFixed(1)}s`;
    input.addEventListener("input", sync, { signal });
    label.appendChild(input);
    label.appendChild(value);
    content.appendChild(label);
  };

  addRange("Hold before fade", "holdMs", LASER_HOLD_MIN, LASER_HOLD_MAX);
  addRange("Fade duration", "fadeMs", LASER_FADE_MIN, LASER_FADE_MAX);
  return content;
}
