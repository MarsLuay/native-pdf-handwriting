export type ToolbarIcon = "pen" | "pencil" | "eraser" | "palette" | "lasso" | "undo" | "redo" | "zoom" | "more" | "save" | "chevron";

const PATHS: Record<ToolbarIcon, readonly string[]> = {
  pen: ["M12 19 19 12 22 15 15 22 11 23 12 19Z", "M18 13 16.5 5.5 2 2 5.5 16.5 13 18", "M2 2 9.5 9.5"],
  pencil: ["M4 20 8.5 19 19 8.5 15.5 5 5 15.5 4 20Z", "M13.5 7 17 10.5"],
  eraser: ["M7 21 3 17 13 7 17 11 7 21Z", "M14 6 17 3 21 7 18 10", "M5 19H21"],
  palette: ["M12 3A9 9 0 0 0 12 21H13.5A2 2 0 0 0 15.5 19 2 2 0 0 0 13.5 17H12A5 5 0 0 1 12 3Z", "M7.5 10H7.51", "M10 6.5H10.01", "M15 7.5H15.01", "M17 12H17.01"],
  lasso: ["M7 17.5C4.5 16.5 3 14.5 3 12 3 7 7 3 12 3S21 6 21 10 17 17 12 17C10.8 17 9.7 16.9 8.7 16.6", "M8 19.5C8 21 6.8 22 5.5 22S3 21 3 19.5 4.2 17 5.5 17 8 18 8 19.5Z"],
  undo: ["M9 14 4 9 9 4", "M4 9H14.5A5.5 5.5 0 0 1 20 14.5 5.5 5.5 0 0 1 14.5 20H12"],
  redo: ["M15 14 20 9 15 4", "M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H12"],
  zoom: ["M11 19A8 8 0 1 0 11 3 8 8 0 0 0 11 19Z", "M21 21 16.7 16.7"],
  more: ["M5 12H5.01", "M12 12H12.01", "M19 12H19.01"],
  save: ["M5 21H19A2 2 0 0 0 21 19V7L17 3H5A2 2 0 0 0 3 5V19A2 2 0 0 0 5 21Z", "M7 3V8H17V3", "M7 21V14H17V21"],
  chevron: ["M7 10 12 15 17 10"]
};

export function setToolbarColorSwatch(element: HTMLElement, color: string): void {
  const swatch = element.ownerDocument.createElement("span");
  swatch.className = "native-pdf-ink-color-icon";
  swatch.style.backgroundColor = color;
  swatch.setAttribute("aria-hidden", "true");
  element.replaceChildren(swatch);
}

export function setToolbarIcon(element: HTMLElement, icon: ToolbarIcon): void {
  const svg = element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("native-pdf-ink-toolbar-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const data of PATHS[icon]) {
    const path = element.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  element.replaceChildren(svg);
}
