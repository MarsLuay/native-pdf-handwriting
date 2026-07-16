import { setElementCssProps } from "../dom/typeGuards";
export type ToolbarIcon = "pan" | "pen" | "pencil" | "highlighter" | "text" | "eraser" | "palette" | "lasso" | "laser" | "undo" | "redo" | "zoom" | "more" | "save" | "chevron";

type IconShape = string | { type: "circle"; cx: string; cy: string; radius: string; fill?: string };

const PATHS: Record<ToolbarIcon, readonly IconShape[]> = {
  pan: ["M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v5", "M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8", "M10 11V5a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v7", "M6 13V9a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8c0 5.5 4.5 10 10 10h1a7 7 0 0 0 7-7v-3"],
  pen: ["M12 19 19 12 22 15 15 22 11 23 12 19Z", "M18 13 16.5 5.5 2 2 5.5 16.5 13 18", "M2 2 9.5 9.5"],
  pencil: ["M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z", "m15 5 4 4", "M17 7 6 18", "m5 17 2 2"],
  highlighter: ["m9 11-6 6v3h9l3-3", "m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"],
  text: ["M4 5V3H20V5", "M12 3V21", "M8 21H16"],
  eraser: ["M7 21 3 17 13 7 17 11 7 21Z", "M14 6 17 3 21 7 18 10", "M5 19H21"],
  palette: ["M12 3A9 9 0 0 0 12 21H13.5A2 2 0 0 0 15.5 19 2 2 0 0 0 13.5 17H12A5 5 0 0 1 12 3Z", "M7.5 10H7.51", "M10 6.5H10.01", "M15 7.5H15.01", "M17 12H17.01"],
  lasso: ["M7 17.5C4.5 16.5 3 14.5 3 12 3 7 7 3 12 3S21 6 21 10 17 17 12 17C10.8 17 9.7 16.9 8.7 16.6", "M8 19.5C8 21 6.8 22 5.5 22S3 21 3 19.5 4.2 17 5.5 17 8 18 8 19.5Z"],
  laser: ["M5 19 12.5 11.5 14.5 13.5 7 21 5 19Z", "M15.5 10 20 5.5", "M18.6 4.1a2 2 0 1 1 2.8 2.8", "M17.2 2.7a4 4 0 0 1 5.6 5.6"],
  undo: ["M9 14 4 9 9 4", "M4 9H14.5A5.5 5.5 0 0 1 20 14.5 5.5 5.5 0 0 1 14.5 20H12"],
  redo: ["M15 14 20 9 15 4", "M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H12"],
  zoom: ["M11 19A8 8 0 1 0 11 3 8 8 0 0 0 11 19Z", "M21 21 16.7 16.7"],
  more: ["M5 12H5.01", "M12 12H12.01", "M19 12H19.01"],
  save: ["M5 21H19A2 2 0 0 0 21 19V7L17 3H5A2 2 0 0 0 3 5V19A2 2 0 0 0 5 21Z", "M7 3V8H17V3", "M7 21V14H17V21"],
  chevron: ["M7 10 12 15 17 10"]
};

export function setToolbarColorSwatch(element: HTMLElement, color: string, transparent = false): void {
  const swatch = element.ownerDocument.createElement("span");
  swatch.className = "native-pdf-handwriting-color-icon";
  if (transparent) swatch.classList.add("is-transparent");
  else setElementCssProps(swatch, { "background-color": color });
  swatch.setAttribute("aria-hidden", "true");
  element.replaceChildren(swatch);
}

export function setToolbarIcon(element: HTMLElement, icon: ToolbarIcon): void {
  element.replaceChildren(createToolbarIcon(element.ownerDocument, icon));
}

export function createToolbarIcon(ownerDocument: Document, icon: ToolbarIcon): SVGSVGElement {
  const svg = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("native-pdf-handwriting-toolbar-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", icon === "highlighter" ? "2.8" : "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const shape of PATHS[icon]) {
    if (typeof shape === "string") {
      const path = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", shape);
      svg.append(path);
    } else {
      const element = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
      element.setAttribute("cx", shape.cx);
      element.setAttribute("cy", shape.cy);
      element.setAttribute("r", shape.radius);
      if (shape.fill) element.setAttribute("fill", shape.fill);
      svg.append(element);
    }
  }
  return svg;
}
