export type PageRotation = 0 | 90 | 180 | 270;
export interface ViewportPoint { x: number; y: number }
export interface PdfCoordinateMapperOptions { width: number; height: number; scale: number; rotation?: PageRotation; offsetX?: number; offsetY?: number }

export class PdfCoordinateMapper {
  readonly rotation: PageRotation;
  constructor(private readonly options: PdfCoordinateMapperOptions) {
    if (options.width <= 0 || options.height <= 0 || options.scale <= 0) throw new RangeError("Page dimensions and scale must be positive");
    this.rotation = options.rotation ?? 0;
  }

  toViewport(pdf: ViewportPoint): ViewportPoint {
    const { width: w, height: h, scale: s } = this.options;
    let x: number; let y: number;
    switch (this.rotation) {
      case 0: x = pdf.x * s; y = (h - pdf.y) * s; break;
      case 90: x = pdf.y * s; y = pdf.x * s; break;
      case 180: x = (w - pdf.x) * s; y = pdf.y * s; break;
      case 270: x = (h - pdf.y) * s; y = (w - pdf.x) * s; break;
    }
    return { x: x + (this.options.offsetX ?? 0), y: y + (this.options.offsetY ?? 0) };
  }

  toPdf(viewport: ViewportPoint): ViewportPoint {
    const { width: w, height: h, scale: s } = this.options;
    const vx = (viewport.x - (this.options.offsetX ?? 0)) / s;
    const vy = (viewport.y - (this.options.offsetY ?? 0)) / s;
    switch (this.rotation) {
      case 0: return { x: vx, y: h - vy };
      case 90: return { x: vy, y: vx };
      case 180: return { x: w - vx, y: vy };
      case 270: return { x: w - vy, y: h - vx };
    }
  }
}

