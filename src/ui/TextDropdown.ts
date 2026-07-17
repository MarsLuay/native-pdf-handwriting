import type { TextStyle } from "../model";

export interface TextStyleChange {
  property: "fontFamily" | "color" | "fontSize" | "bold" | "italic" | "strikethrough";
  value: string | number | boolean;
  source: "change" | "input" | "toggle";
}

export function textMenu(
  ownerDocument: Document,
  style: TextStyle,
  onChange: (change: TextStyleChange) => void,
  signal: AbortSignal,
  onPointerDown?: () => void
): HTMLElement {
  const content = ownerDocument.createDiv();
  content.className = "native-pdf-handwriting-text-menu";
  const field = (labelText: string, input: HTMLInputElement | HTMLSelectElement): void => {
    const label = ownerDocument.createEl('label');
    label.textContent = labelText;
    label.append(input);
    content.append(label);
  };

  const font = ownerDocument.createEl('select');
  font.addEventListener("pointerdown", () => onPointerDown?.(), { signal });
  for (const [label, value] of [["Sans serif", "sans-serif"], ["Serif", "serif"], ["Monospace", "monospace"]] as const) {
    const option = ownerDocument.createEl('option');
    option.value = value;
    option.textContent = label;
    option.selected = style.fontFamily === value;
    font.append(option);
  }
  font.addEventListener("change", () => {
    style.fontFamily = font.value;
    onChange({ property: "fontFamily", value: style.fontFamily, source: "change" });
  }, { signal });
  field("Font", font);

  const color = ownerDocument.createEl('input');
  color.type = "color";
  color.value = style.color;
  color.addEventListener("pointerdown", () => onPointerDown?.(), { signal });
  color.addEventListener("input", () => {
    style.color = color.value;
    onChange({ property: "color", value: style.color, source: "input" });
  }, { signal });
  field("Color", color);

  const size = ownerDocument.createEl('input');
  size.type = "number";
  size.min = "8";
  size.max = "144";
  size.step = "1";
  size.value = String(style.fontSize);
  size.addEventListener("pointerdown", () => onPointerDown?.(), { signal });
  size.addEventListener("change", () => {
    style.fontSize = Math.max(8, Math.min(144, Number(size.value) || 16));
    size.value = String(style.fontSize);
    onChange({ property: "fontSize", value: style.fontSize, source: "change" });
  }, { signal });
  field("Size", size);

  const styles = ownerDocument.createDiv();
  styles.className = "native-pdf-handwriting-text-style-buttons";
  for (const [label, key] of [["Bold", "bold"], ["Italic", "italic"], ["Strike-through", "strikethrough"]] as const) {
    const button = ownerDocument.createEl('button');
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(style[key]));
    button.addEventListener("pointerdown", () => onPointerDown?.(), { signal });
    button.addEventListener("click", () => {
      style[key] = !style[key];
      button.setAttribute("aria-pressed", String(style[key]));
      onChange({ property: key, value: style[key], source: "toggle" });
    }, { signal });
    styles.append(button);
  }
  content.append(styles);
  return content;
}
