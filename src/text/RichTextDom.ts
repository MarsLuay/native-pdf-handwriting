import type { PdfTextRun, TextStyle } from "../model";
import { isElementInDocument, setElementCssProps } from "../dom/typeGuards";
import { normalizeTextRuns, plainTextFromRuns, type TextRunStyle } from "./RichTextRuns";

export interface TextSelectionOffsets {
  start: number;
  end: number;
}

const STYLE_DATASET_KEY = "nativePdfHandwritingTextStyle";
const BLOCK_TAGS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "FIGCAPTION", "FIGURE", "FOOTER", "HEADER", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "UL"]);

/**
 * Render canonical runs into DOM spans. This is intentionally only used when
 * opening, formatting, or committing text—not on every input event—so native
 * contenteditable continues to own its caret and IME composition state.
 */
export function renderTextRuns(root: HTMLElement, runs: readonly PdfTextRun[], scale = 1): void {
  const ownerDocument = root.ownerDocument;
  const fragments = normalizeTextRuns(runs).map((run) => {
    const span = ownerDocument.createSpan();
    span.className = "native-pdf-handwriting-text-run";
    span.dataset[STYLE_DATASET_KEY] = JSON.stringify(styleFromRun(run));
    applyRunStyle(span, run, scale);
    span.textContent = run.text;
    return span;
  });
  root.replaceChildren(...fragments);
}

/**
 * Reapply display scale to existing run elements without replacing their DOM.
 * This keeps an active contenteditable's native Selection and IME state intact
 * while the PDF viewport is zooming.
 */
export function rescaleTextRuns(root: HTMLElement, scale = 1): void {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  for (const element of root.querySelectorAll<HTMLElement>(".native-pdf-handwriting-text-run")) {
    if (!element.dataset[STYLE_DATASET_KEY]) continue;
    const style = styleFromElement(element, defaultStyle(root));
    setElementCssProps(element, { fontSize: `${style.fontSize * safeScale}px` });
  }
}

/** Read contenteditable DOM into canonical, UTF-16-addressable style runs. */
export function readTextRuns(root: HTMLElement, fallbackStyle: TextStyle): PdfTextRun[] {
  const pieces: PdfTextRun[] = [];
  const append = (text: string, style: TextRunStyle): void => {
    if (text) pieces.push({ text, ...style });
  };
  const walk = (node: Node, inherited: TextRunStyle): void => {
    if (node.nodeType === node.TEXT_NODE) {
      append(node.textContent ?? "", inherited);
      return;
    }
    if (!isElementInDocument(node, root.ownerDocument)) return;
    const element = node as HTMLElement;
    if (element.tagName === "BR") {
      append("\n", inherited);
      return;
    }
    const style = styleFromElement(element, inherited);
    for (const child of Array.from(element.childNodes)) {
      const previous = pieces.at(-1)?.text;
      if (isBlock(child) && pieces.length > 0 && !previous?.endsWith("\n")) {
        append("\n", style);
      }
      walk(child, style);
    }
  };
  walk(root, fallbackStyle);
  return normalizeTextRuns(pieces);
}

/** Return root-relative UTF-16 offsets for the current native Selection. */
export function selectionOffsets(root: HTMLElement): TextSelectionOffsets | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  return {
    start: boundaryOffset(root, range.startContainer, range.startOffset),
    end: boundaryOffset(root, range.endContainer, range.endOffset)
  };
}

/** Restore a root-relative UTF-16 selection after an explicit DOM re-render. */
export function restoreSelection(root: HTMLElement, offsets: TextSelectionOffsets): void {
  const range = root.ownerDocument.createRange();
  const start = boundaryForOffset(root, offsets.start);
  const end = boundaryForOffset(root, offsets.end);
  range.setStart(start.container, start.offset);
  range.setEnd(end.container, end.offset);
  const selection = root.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Insert text under the chosen style and leave a native caret after it. */
export function insertStyledText(root: HTMLElement, text: string, style: TextStyle, scale = 1): TextSelectionOffsets | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const start = boundaryOffset(root, range.startContainer, range.startOffset);
  range.deleteContents();
  const span = root.ownerDocument.createSpan();
  span.className = "native-pdf-handwriting-text-run";
  span.dataset[STYLE_DATASET_KEY] = JSON.stringify(style);
  applyRunStyle(span, style, scale);
  const textNode = root.ownerDocument.createTextNode(text);
  span.append(textNode);
  range.insertNode(span);
  const caret = root.ownerDocument.createRange();
  caret.setStart(textNode, textNode.length);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  return { start, end: start + text.length };
}

function applyRunStyle(element: HTMLElement, style: TextRunStyle, scale = 1): void {
  setElementCssProps(element, {
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: `${style.fontSize * scale}px`,
    fontWeight: style.bold ? "700" : "400",
    fontStyle: style.italic ? "italic" : "normal",
    textDecoration: style.strikethrough ? "line-through" : "none"
  });
}

function styleFromElement(element: HTMLElement, fallback: TextRunStyle): TextRunStyle {
  const encoded = element.dataset[STYLE_DATASET_KEY];
  if (!encoded) return fallback;
  try {
    const parsed = JSON.parse(encoded) as Partial<TextRunStyle>;
    if (typeof parsed.color !== "string" || typeof parsed.fontSize !== "number" || typeof parsed.fontFamily !== "string" ||
      typeof parsed.bold !== "boolean" || typeof parsed.italic !== "boolean" || typeof parsed.strikethrough !== "boolean") return fallback;
    return { color: parsed.color, fontSize: parsed.fontSize, fontFamily: parsed.fontFamily, bold: parsed.bold, italic: parsed.italic, strikethrough: parsed.strikethrough };
  } catch {
    return fallback;
  }
}

function styleFromRun(run: PdfTextRun): TextRunStyle {
  return {
    color: run.color,
    fontSize: run.fontSize,
    fontFamily: run.fontFamily,
    bold: run.bold,
    italic: run.italic,
    strikethrough: run.strikethrough
  };
}

function isBlock(node: Node): boolean {
  return node.nodeType === node.ELEMENT_NODE && BLOCK_TAGS.has((node as HTMLElement).tagName);
}

function boundaryOffset(root: HTMLElement, container: Node, offset: number): number {
  const count = (node: Node): number => {
    if (node.nodeType === node.TEXT_NODE) return node.textContent?.length ?? 0;
    if (node.nodeType !== node.ELEMENT_NODE) return 0;
    const element = node as HTMLElement;
    if (element.tagName === "BR") return 1;
    let length = 0;
    for (const child of Array.from(node.childNodes)) {
      if (isBlock(child) && length > 0) length += 1;
      length += count(child);
    }
    return length;
  };
  const visit = (node: Node): number | null => {
    if (node === container) {
      if (node.nodeType === node.TEXT_NODE) return Math.max(0, Math.min(offset, node.textContent?.length ?? 0));
      let length = 0;
      for (const [index, child] of Array.from(node.childNodes).entries()) {
        if (index >= offset) break;
        if (isBlock(child) && length > 0) length += 1;
        length += count(child);
      }
      return length;
    }
    if (node.nodeType !== node.ELEMENT_NODE) return null;
    let length = 0;
    for (const child of Array.from(node.childNodes)) {
      if (isBlock(child) && length > 0) length += 1;
      const found = visit(child);
      if (found !== null) return length + found;
      length += count(child);
    }
    return null;
  };
  return visit(root) ?? 0;
}

function boundaryForOffset(root: HTMLElement, offset: number): { container: Node; offset: number } {
  const target = Math.max(0, Math.min(offset, plainTextFromRuns(readTextRuns(root, defaultStyle(root))).length));
  const walker = root.ownerDocument.createTreeWalker(root, root.ownerDocument.defaultView!.NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) textNodes.push(current as Text);
  let remaining = target;
  for (const node of textNodes) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { container: node, offset: remaining };
    remaining -= length;
  }
  if (textNodes.length) {
    const last = textNodes.at(-1)!;
    return { container: last, offset: last.textContent?.length ?? 0 };
  }
  return { container: root, offset: root.childNodes.length };
}

function defaultStyle(root: HTMLElement): TextStyle {
  const fontWeight = root.style.getPropertyValue("font-weight");
  const fontStyle = root.style.getPropertyValue("font-style");
  const textDecoration = root.style.getPropertyValue("text-decoration");
  return {
    color: root.style.getPropertyValue("color") || "#000000",
    fontSize: Number.parseFloat(root.style.getPropertyValue("font-size")) || 16,
    fontFamily: root.style.getPropertyValue("font-family") || "sans-serif",
    bold: fontWeight === "700" || fontWeight === "bold",
    italic: fontStyle === "italic",
    strikethrough: textDecoration.includes("line-through")
  };
}
