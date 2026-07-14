import { LineCapStyle, PDFDocument, rgb } from "pdf-lib";
import { DEFAULT_SETTINGS, type InkStroke, type PdfPoint } from "../model";
import { graphiteStampCircles, seedFromId } from "../tools/PencilTool";
import { penSampleWidth, penSegmentWidths } from "../tools/PenTool";

export interface PdfExportPageMetrics {
  page: number;
  width: number;
  height: number;
}

export interface PdfExportInput {
  sourceBytes: Uint8Array;
  strokes?: readonly InkStroke[];
  getStrokes?: () => readonly InkStroke[];
  /** Sidecar / session page sizes — may differ from MediaBox PDF points (e.g. CSS px @96dpi). */
  pageMetrics?: readonly PdfExportPageMetrics[];
  flush?: () => Promise<void>;
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
    const sourceSnapshot = input.sourceBytes.slice();
    const document = await PDFDocument.load(sourceSnapshot);
    const metricsByPage = new Map(
      (input.pageMetrics ?? []).map((page) => [page.page, page] as const)
    );
    for (const stroke of strokes) {
      const page = document.getPages()[stroke.page - 1];
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

      const pen = DEFAULT_SETTINGS.toolPreferences.pen;
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
    const exported = await document.save();
    await PDFDocument.load(exported);
    if (!input.sourceBytes.every((byte, index) => byte === sourceSnapshot[index])) throw new Error("Source PDF bytes changed during export");
    return exported;
  }

  async validate(bytes: Uint8Array): Promise<void> { await PDFDocument.load(bytes); }
}
