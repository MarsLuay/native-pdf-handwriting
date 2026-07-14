import type { DrawingTool, InkStroke, PdfPoint } from "../model";
import { simplifyPoints, stabilizePoints, type StabilizationLevel } from "./StrokeStabilizer";

export interface StrokeBuilderOptions {
  id: string;
  page: number;
  tool: DrawingTool;
  color: string;
  width: number;
  opacity: number;
  inputType: InkStroke["inputType"];
  stabilization?: StabilizationLevel;
  simplifyTolerance?: number;
  now?: () => string;
}

export class StrokeBuilder {
  private readonly points: PdfPoint[] = [];
  constructor(private readonly options: StrokeBuilderOptions) {}

  add(point: PdfPoint): void {
    if (![point.x, point.y, point.pressure, point.time].every(Number.isFinite)) throw new TypeError("Invalid stroke point");
    this.points.push({ ...point, pressure: Math.max(0, Math.min(1, point.pressure)) });
  }

  preview(simplifyEnabled = true): readonly PdfPoint[] {
    if (!simplifyEnabled) return this.points.map((point) => ({ ...point }));
    return stabilizePoints(this.points, this.options.stabilization ?? "off");
  }

  finish(simplifyEnabled = true): InkStroke {
    if (this.points.length === 0) throw new Error("Cannot finish an empty stroke");
    const processed = simplifyEnabled
      ? simplifyPoints(
        stabilizePoints(this.points, this.options.stabilization ?? "off"),
        this.options.simplifyTolerance ?? 0.35
      )
      : this.points.map((point) => ({ ...point }));
    const now = (this.options.now ?? (() => new Date().toISOString()))();
    return {
      id: this.options.id, page: this.options.page, tool: this.options.tool,
      color: this.options.color, width: this.options.width, opacity: this.options.opacity,
      inputType: this.options.inputType, points: processed, createdAt: now, updatedAt: now
    };
  }
}
