import type { InkStroke } from "../model";

export interface StrokeRenderTarget {}

export interface StrokeRenderer<TTarget extends StrokeRenderTarget = StrokeRenderTarget> {
  render(target: TTarget, stroke: InkStroke): void;
  clear(target: TTarget): void;
}

