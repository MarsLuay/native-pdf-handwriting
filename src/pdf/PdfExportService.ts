import { LineCapStyle, PDFDict, PDFDocument, PDFHexString, PDFImage, PDFName, PDFString, rgb } from "pdf-lib";
import { DEFAULT_SETTINGS, type InkStroke, type PdfPoint, type PdfTextAnnotation, type PdfTextRun } from "../model";
import { graphiteStampCircles, seedFromId } from "../tools/PencilTool";
import { penSampleWidth, penSegmentWidths } from "../tools/PenTool";

export interface PdfExportPageMetrics {
  page: number;
  width: number;
  height: number;
}

export interface PdfExportInput {
  sourceBytes: Uint8Array;
  mode?: PdfExportMode;
  strokes?: readonly InkStroke[];
  getStrokes?: () => readonly InkStroke[];
  texts?: readonly PdfTextAnnotation[];
  getTexts?: () => readonly PdfTextAnnotation[];
  /** Sidecar / session page sizes — may differ from MediaBox PDF points (e.g. CSS px @96dpi). */
  pageMetrics?: readonly PdfExportPageMetrics[];
  flush?: () => Promise<void>;
}

export type PdfExportMode = "flattened" | "editable";

interface MappedInkStroke {
  points: Array<{ x: number; y: number }>;
  width: number;
}

interface MappedTextAnnotation {
  annotation: PdfTextAnnotation;
  x: number;
  y: number;
  fontScale: number;
}

function parseColor(value: string): ReturnType<typeof rgb> {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return rgb(0, 0, 0);
  const hex = match[1]!;
  return rgb(Number.parseInt(hex.slice(0, 2), 16) / 255, Number.parseInt(hex.slice(2, 4), 16) / 255, Number.parseInt(hex.slice(4, 6), 16) / 255);
}

export function annotatedFilename(sourceName: string): string {
  const base = sourceName.replace(/\.pdf$/i, "");
  return `${base || "document"}_export.pdf`;
}

export function editableAnnotatedFilename(sourceName: string): string {
  const base = sourceName.replace(/\.pdf$/i, "");
  return `${base || "document"}_editable.pdf`;
}

/** Map ink page-space → actual PDF MediaBox points when those spaces differ. */
export function mapInkPointToPdfPage(
  point: Pick<PdfPoint, "x" | "y">,
  inkPage: { width: number; height: number },
  pdfPage: { width: number; height: number }
): { x: number; y: number } {
  const sx = inkPage.width > 0 ? pdfPage.width / inkPage.width : 1;
  const sy = inkPage.height > 0 ? pdfPage.height / inkPage.height : 1;
  return { x: point.x * sx, y: point.y * sy };
}

export function mapInkWidthToPdfPage(
  width: number,
  inkPage: { width: number; height: number },
  pdfPage: { width: number; height: number }
): number {
  const sx = inkPage.width > 0 ? pdfPage.width / inkPage.width : 1;
  const sy = inkPage.height > 0 ? pdfPage.height / inkPage.height : 1;
  return width * ((sx + sy) / 2);
}

export class PdfExportService {
  async export(input: PdfExportInput): Promise<Uint8Array> {
    await input.flush?.();
    const strokes = input.getStrokes?.() ?? input.strokes ?? [];
    const texts = input.getTexts?.() ?? input.texts ?? [];
    const sourceSnapshot = input.sourceBytes.slice();
    const pdfDoc = await PDFDocument.load(sourceSnapshot);
    const metricsByPage = new Map(
      (input.pageMetrics ?? []).map((page) => [page.page, page] as const)
    );
    for (const stroke of strokes) {
      const page = pdfDoc.getPages()[stroke.page - 1];
      if (!page) throw new RangeError(`Stroke ${stroke.id} references missing page ${stroke.page}`);
      const color = parseColor(stroke.color);
      const pdfSize = page.getSize();
      const inkPage = metricsByPage.get(stroke.page);
      const sourceSize = inkPage && inkPage.width > 0 && inkPage.height > 0
        ? { width: inkPage.width, height: inkPage.height }
        : pdfSize;
      // Match on-screen canvas width model; scale into MediaBox points.
      const mapPoint = (point: Pick<PdfPoint, "x" | "y">) => mapInkPointToPdfPage(point, sourceSize, pdfSize);
      const strokeWidth = mapInkWidthToPdfPage(stroke.width, sourceSize, pdfSize);

      if (input.mode === "editable") {
        if (stroke.points.length === 0) continue;
        this.addInkAnnotation(pdfDoc, page, stroke, {
          points: stroke.points.map(mapPoint),
          width: this.editableStrokeWidth(stroke, strokeWidth)
        });
        continue;
      }

      if (stroke.tool === "pencil") {
        const pencil = DEFAULT_SETTINGS.toolPreferences.pencil;
        const stamps = graphiteStampCircles(
          stroke.points.map((point) => {
            const mapped = mapPoint(point);
            return {
              x: mapped.x,
              y: mapped.y,
              pressure: point.pressure,
              tiltX: point.tiltX,
              tiltY: point.tiltY
            };
          }),
          {
            color: stroke.color,
            width: strokeWidth,
            opacity: stroke.opacity,
            textureStrength: pencil.textureStrength,
            pressureSensitivity: pencil.pressureSensitivity,
            tiltSensitivity: pencil.tiltSensitivity,
            thinning: pencil.thinning,
            seed: seedFromId(stroke.id)
          }
        );
        for (const stamp of stamps) {
          page.drawCircle({
            x: stamp.x,
            y: stamp.y,
            size: stamp.radius,
            color,
            opacity: stamp.opacity
          });
        }
        continue;
      }

      const pen = stroke.tool === "highlighter"
        ? DEFAULT_SETTINGS.toolPreferences.highlighter
        : DEFAULT_SETTINGS.toolPreferences.pen;
      const penPrefs = {
        ...pen,
        width: strokeWidth,
        opacity: stroke.opacity,
        color: stroke.color
      };
      if (stroke.points.length === 1) {
        const point = mapPoint(stroke.points[0]!);
        page.drawCircle({
          x: point.x,
          y: point.y,
          size: penSampleWidth(penPrefs, stroke.points[0]!) / 2,
          color,
          opacity: stroke.opacity
        });
        continue;
      }
      const mappedPoints = stroke.points.map((point) => {
        const mapped = mapPoint(point);
        return { x: mapped.x, y: mapped.y, pressure: point.pressure };
      });
      for (const segment of penSegmentWidths(mappedPoints, {
        color: stroke.color,
        width: strokeWidth,
        opacity: stroke.opacity,
        pressureSensitivity: pen.pressureSensitivity,
        thinning: pen.thinning
      })) {
        page.drawLine({
          start: { x: segment.start.x, y: segment.start.y },
          end: { x: segment.end.x, y: segment.end.y },
          thickness: segment.thickness,
          color,
          opacity: stroke.opacity,
          lineCap: LineCapStyle.Round
        });
      }
    }
    for (const text of texts) {
      const page = pdfDoc.getPages()[text.page - 1];
      if (!page) throw new RangeError(`Text annotation ${text.id} references missing page ${text.page}`);
      const pdfSize = page.getSize();
      const inkPage = metricsByPage.get(text.page);
      const sourceSize = inkPage && inkPage.width > 0 && inkPage.height > 0
        ? { width: inkPage.width, height: inkPage.height }
        : pdfSize;
      const mappedPoint = mapInkPointToPdfPage(text, sourceSize, pdfSize);
      const fontScale = mapInkWidthToPdfPage(1, sourceSize, pdfSize);
      if (input.mode === "editable") {
        await this.addFreeTextAnnotation(pdfDoc, page, {
          annotation: text,
          x: mappedPoint.x,
          y: mappedPoint.y,
          fontScale
        });
      } else {
        await this.drawFlattenedText(pdfDoc, page, {
          annotation: text,
          x: mappedPoint.x,
          y: mappedPoint.y,
          fontScale
        });
      }
    }
    const exported = await pdfDoc.save();
    await PDFDocument.load(exported);
    if (!input.sourceBytes.every((byte, index) => byte === sourceSnapshot[index])) throw new Error("Source PDF bytes changed during export");
    return exported;
  }

  async validate(bytes: Uint8Array): Promise<void> { await PDFDocument.load(bytes); }

  private editableStrokeWidth(stroke: InkStroke, width: number): number {
    if (stroke.tool === "pencil") return Math.max(0.5, width * 0.75);
    return Math.max(0.5, width);
  }

  private addInkAnnotation(
    pdfDoc: PDFDocument,
    page: ReturnType<PDFDocument["getPages"]>[number],
    stroke: InkStroke,
    mapped: MappedInkStroke
  ): void {
    const points = mapped.points.length === 1
      ? [mapped.points[0]!, { x: mapped.points[0]!.x + 0.01, y: mapped.points[0]!.y + 0.01 }]
      : mapped.points;
    const padding = Math.max(1, mapped.width / 2 + 1);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs) - padding;
    const minY = Math.min(...ys) - padding;
    const maxX = Math.max(...xs) + padding;
    const maxY = Math.max(...ys) + padding;
    const [red, green, blue] = colorComponents(stroke.color);
    const context = pdfDoc.context;
    const opacity = context.register(context.obj({ Type: "ExtGState", CA: stroke.opacity, ca: stroke.opacity }));
    const appearance = context.register(context.flateStream(
      inkAppearanceStream(points, minX, minY, mapped.width, red, green, blue),
      {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, maxX - minX, maxY - minY],
        Resources: { ExtGState: { GS0: opacity } }
      }
    ));
    const annotation = context.register(context.obj({
      Type: "Annot",
      Subtype: "Ink",
      Rect: [minX, minY, maxX, maxY],
      InkList: [points.flatMap((point) => [point.x, point.y])],
      C: [red, green, blue],
      CA: stroke.opacity,
      BS: { Type: "Border", W: mapped.width, S: "S" },
      Border: [0, 0, mapped.width],
      F: 4,
      NM: PDFHexString.fromText(`handwriting-natively-${stroke.id}`),
      AP: { N: appearance }
    }));
    page.node.addAnnot(annotation);
  }

  private addFreeTextAnnotation(
    pdfDoc: PDFDocument,
    page: ReturnType<PDFDocument["getPages"]>[number],
    mapped: MappedTextAnnotation
  ): Promise<void> {
    const { annotation, x, y, fontScale } = mapped;
    const runs = textRuns(annotation);
    const bounds = textBounds(runs, x, y, fontScale);
    const first = runs[0] ?? fallbackTextRun(annotation);
    const [red, green, blue] = colorComponents(first.color);
    const standardAppearance = hasStandardAppearance(runs);
    const annotationBody = pdfDoc.context.obj({
      Type: "Annot",
      Subtype: "FreeText",
      Rect: [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY],
      Contents: PDFHexString.fromText(annotation.text),
      ...(standardAppearance ? {
        RC: PDFHexString.fromText(richTextContents(runs)),
        DS: PDFHexString.fromText(textStyleDeclaration(first))
      } : {}),
      BS: { Type: "Border", W: 0, S: "S" },
      Border: [0, 0, 0],
      F: 4,
      NM: PDFHexString.fromText(`handwriting-natively-text-${annotation.id}`)
    });
    if (standardAppearance) {
      const fonts = new Map<string, string>();
      const appearance = pdfDoc.context.register(pdfDoc.context.flateStream(
        textAppearanceStream(runs, bounds, fontScale, fonts),
        {
          Type: "XObject",
          Subtype: "Form",
          BBox: [0, 0, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY],
          Resources: pdfDoc.context.obj({ Font: pdfDoc.context.obj(fontResources(pdfDoc, fonts)) })
        }
      ));
      annotationBody.set(PDFName.of("DA"), PDFString.of(`/${fontResourceName(first, fonts)} ${formatNumber(first.fontSize * fontScale)} Tf ${formatNumber(red)} ${formatNumber(green)} ${formatNumber(blue)} rg`));
      annotationBody.set(PDFName.of("AP"), pdfDoc.context.obj({ N: appearance }));
    } else {
      return this.addRasterTextAppearance(pdfDoc, annotationBody, runs, bounds, fontScale, page);
    }
    const annotationDict = pdfDoc.context.register(annotationBody);
    page.node.addAnnot(annotationDict);
    return Promise.resolve();
  }

  private async addRasterTextAppearance(
    pdfDoc: PDFDocument,
    annotation: PDFDict,
    runs: readonly PdfTextRun[],
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    fontScale: number,
    page: ReturnType<PDFDocument["getPages"]>[number]
  ): Promise<void> {
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const image = await this.rasterTextImage(pdfDoc, runs, width, height, fontScale);
    if (image) {
      const appearance = pdfDoc.context.register(pdfDoc.context.flateStream(
        `q\n${formatNumber(width)} 0 0 ${formatNumber(height)} 0 0 cm\n/Im0 Do\nQ`,
        {
          Type: "XObject",
          Subtype: "Form",
          BBox: [0, 0, width, height],
          Resources: pdfDoc.context.obj({ XObject: pdfDoc.context.obj({ Im0: image.ref }) })
        }
      ));
      annotation.set(PDFName.of("AP"), pdfDoc.context.obj({ N: appearance }));
    }
    page.node.addAnnot(pdfDoc.context.register(annotation));
  }

  private async drawFlattenedText(
    pdfDoc: PDFDocument,
    page: ReturnType<PDFDocument["getPages"]>[number],
    mapped: MappedTextAnnotation
  ): Promise<void> {
    const runs = textRuns(mapped.annotation);
    const bounds = textBounds(runs, mapped.x, mapped.y, mapped.fontScale);
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const image = await this.rasterTextImage(pdfDoc, runs, width, height, mapped.fontScale);
    if (image) page.drawImage(image, { x: bounds.minX, y: bounds.minY, width, height });
  }

  private async rasterTextImage(
    pdfDoc: PDFDocument,
    runs: readonly PdfTextRun[],
    width: number,
    height: number,
    fontScale: number
  ): Promise<PDFImage | undefined> {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const pixelScale = 2;
    if (!context || typeof canvas.toDataURL !== "function") return undefined;
    canvas.width = Math.ceil(width * pixelScale);
    canvas.height = Math.ceil(height * pixelScale);
    const layout = textLayout(runs, fontScale);
    let x = 0;
    let top = 0;
    let lineFontSize = 1;
    for (const run of runs) {
      const fontSize = Math.max(1, run.fontSize * fontScale);
      const lines = run.text.split("\n");
      const fontPrefix = `${run.italic ? "italic " : ""}${run.bold ? "700" : "400"} ${formatNumber(fontSize * pixelScale)}px`;
      context.font = `${fontPrefix} sans-serif`;
      context.font = `${fontPrefix} ${run.fontFamily}`;
      for (const [index, line] of lines.entries()) {
        if (line) {
          lineFontSize = Math.max(lineFontSize, fontSize);
          const lineWidth = context.measureText(line).width / pixelScale;
          context.fillStyle = run.color;
          const baseline = layout.topPadding + top + fontSize * 0.8;
          context.fillText(line, x * pixelScale, baseline * pixelScale);
          if (run.strikethrough) {
            context.beginPath();
            context.strokeStyle = run.color;
            context.lineWidth = Math.max(0.5, fontSize * 0.06) * pixelScale;
            context.moveTo(x * pixelScale, (baseline - fontSize * 0.3) * pixelScale);
            context.lineTo((x + lineWidth) * pixelScale, (baseline - fontSize * 0.3) * pixelScale);
            context.stroke();
          }
          x += lineWidth;
        }
        if (index < lines.length - 1) {
          x = 0;
          top += lineFontSize * 1.25;
          lineFontSize = 1;
        }
      }
    }
    try { return await pdfDoc.embedPng(canvas.toDataURL("image/png")); }
    catch { return undefined; }
  }
}

function fallbackTextRun(annotation: PdfTextAnnotation): PdfTextRun {
  return {
    text: annotation.text,
    color: annotation.color,
    fontSize: annotation.fontSize,
    fontFamily: annotation.fontFamily ?? "sans-serif",
    bold: annotation.bold ?? false,
    italic: annotation.italic ?? false,
    strikethrough: false
  };
}

function textRuns(annotation: PdfTextAnnotation): PdfTextRun[] {
  return annotation.runs?.length
    ? annotation.runs.map((run) => ({ ...run, strikethrough: run.strikethrough ?? false }))
    : [fallbackTextRun(annotation)];
}

function textBounds(
  runs: readonly PdfTextRun[],
  x: number,
  y: number,
  fontScale: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  const layout = textLayout(runs, fontScale);
  return {
    minX: x,
    minY: y - layout.contentHeight - layout.bottomPadding,
    maxX: x + layout.maxWidth + layout.maxFontSize * 0.2,
    maxY: y + layout.topPadding
  };
}

function textLayout(runs: readonly PdfTextRun[], fontScale: number): {
  maxWidth: number;
  maxFontSize: number;
  contentHeight: number;
  topPadding: number;
  bottomPadding: number;
} {
  let lineWidth = 0;
  let maxWidth = 1;
  let maxFontSize = 1;
  let lineFontSize = 1;
  let contentHeight = 0;
  for (const run of runs) {
    const fontSize = Math.max(1, run.fontSize * fontScale);
    maxFontSize = Math.max(maxFontSize, fontSize);
    const lines = run.text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      // Reserve enough room for full-width Unicode glyphs and italic overhang.
      lineWidth += lines[index]!.length * fontSize * 1.1;
      if (lines[index]) lineFontSize = Math.max(lineFontSize, fontSize);
      if (index < lines.length - 1) {
        maxWidth = Math.max(maxWidth, lineWidth);
        lineWidth = 0;
        contentHeight += lineFontSize * 1.25;
        lineFontSize = 1;
      }
    }
  }
  maxWidth = Math.max(maxWidth, lineWidth);
  contentHeight += lineFontSize * 1.25;
  return {
    maxWidth,
    maxFontSize,
    contentHeight,
    topPadding: maxFontSize * 0.1,
    bottomPadding: maxFontSize * 0.2
  };
}

function textAppearanceStream(
  runs: readonly PdfTextRun[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  fontScale: number,
  fonts: Map<string, string>
): string {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const layout = textLayout(runs, fontScale);
  const text: string[] = ["BT"];
  const strikethroughs: string[] = [];
  let x = 0;
  let top = 0;
  let lineFontSize = 1;
  for (const run of runs) {
    const fontSize = Math.max(1, run.fontSize * fontScale);
    const [red, green, blue] = colorComponents(run.color);
    const lines = run.text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line) {
        lineFontSize = Math.max(lineFontSize, fontSize);
        const lineWidth = line.length * fontSize * 1.1;
        const baseline = height - layout.topPadding - top - fontSize * 0.8;
        text.push(`/${fontResourceName(run, fonts)} ${formatNumber(fontSize)} Tf`);
        text.push(`${formatNumber(red)} ${formatNumber(green)} ${formatNumber(blue)} rg`);
        text.push(`${formatNumber(red)} ${formatNumber(green)} ${formatNumber(blue)} RG`);
        if (run.bold) text.push(`${formatNumber(Math.max(0.2, fontSize * 0.03))} w`, "2 Tr");
        text.push(`1 0 ${run.italic ? "0.2" : "0"} 1 ${formatNumber(x)} ${formatNumber(baseline)} Tm`);
        text.push(`${asciiPdfText(line).toString()} Tj`);
        if (run.bold) text.push("0 Tr");
        if (run.strikethrough) strikethroughs.push(
          "q", `${formatNumber(red)} ${formatNumber(green)} ${formatNumber(blue)} RG`, `${formatNumber(Math.max(0.5, fontSize * 0.06))} w`,
          `${formatNumber(x)} ${formatNumber(baseline + fontSize * 0.3)} m`, `${formatNumber(x + lineWidth)} ${formatNumber(baseline + fontSize * 0.3)} l`, "S", "Q"
        );
        x += lineWidth;
      }
      if (index < lines.length - 1) {
        x = 0;
        top += lineFontSize * 1.25;
        lineFontSize = 1;
      }
    }
  }
  return ["q", ...text, "ET", ...strikethroughs, "Q"].join("\n");
}

function richTextContents(runs: readonly PdfTextRun[]): string {
  const spans = runs.map((run) => {
    const decorations = run.strikethrough ? "line-through" : "";
    return `<span style="${escapeXml(textStyleDeclaration(run, decorations))}">${escapeXml(run.text).replace(/\n/g, "<br/>")}</span>`;
  }).join("");
  return `<body xmlns="http://www.w3.org/1999/xhtml"><p>${spans}</p></body>`;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]!);
}

function textStyleDeclaration(run: Pick<PdfTextRun, "fontFamily" | "fontSize" | "color" | "bold" | "italic">, decorations = ""): string {
  return [
    `font-family:${run.fontFamily}`,
    `font-size:${formatNumber(run.fontSize)}pt`,
    `color:${run.color}`,
    run.bold ? "font-weight:bold" : "",
    run.italic ? "font-style:italic" : "",
    decorations
  ].filter(Boolean).join(";");
}

function hasStandardAppearance(runs: readonly PdfTextRun[]): boolean {
  return runs.every((run) => /^[\x20-\x7e\n]*$/.test(run.text));
}

function asciiPdfText(text: string): PDFHexString {
  return PDFHexString.of([...text].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
}

function fontResourceName(run: Pick<PdfTextRun, "fontFamily" | "bold" | "italic">, fonts: Map<string, string>): string {
  const family = run.fontFamily.toLowerCase();
  const base = family.includes("mono") || family.includes("code")
    ? run.bold && run.italic ? "Courier-BoldOblique" : run.bold ? "Courier-Bold" : run.italic ? "Courier-Oblique" : "Courier"
    : family.includes("serif")
      ? run.bold && run.italic ? "Times-BoldItalic" : run.bold ? "Times-Bold" : run.italic ? "Times-Italic" : "Times-Roman"
      : run.bold && run.italic ? "Helvetica-BoldOblique" : run.bold ? "Helvetica-Bold" : run.italic ? "Helvetica-Oblique" : "Helvetica";
  if (!fonts.has(base)) fonts.set(base, `F${fonts.size}`);
  return fonts.get(base)!;
}

function fontResources(pdfDoc: PDFDocument, fonts: ReadonlyMap<string, string>): Record<string, PDFDict> {
  return Object.fromEntries([...fonts.entries()].map(([base, resource]) => [resource, pdfDoc.context.obj({
    Type: PDFName.of("Font"),
    Subtype: PDFName.of("Type1"),
    BaseFont: PDFName.of(base)
  })]));
}

function formatNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function colorComponents(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return [0, 0, 0];
  const hex = match[1]!;
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255
  ];
}

function inkAppearanceStream(
  points: readonly { x: number; y: number }[],
  minX: number,
  minY: number,
  width: number,
  red: number,
  green: number,
  blue: number
): string {
  const format = (value: number) => Number(value.toFixed(4)).toString();
  const [first, ...rest] = points;
  return [
    "q",
    `${format(red)} ${format(green)} ${format(blue)} RG`,
    "/GS0 gs",
    `${format(width)} w`,
    "1 J",
    "1 j",
    `${format(first!.x - minX)} ${format(first!.y - minY)} m`,
    ...rest.map((point) => `${format(point.x - minX)} ${format(point.y - minY)} l`),
    "S",
    "Q"
  ].join("\n");
}
