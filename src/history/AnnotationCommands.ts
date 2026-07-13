import type { InkStroke } from "../model";
import type { InkSession } from "../ink/InkSession";
import type { Command } from "./CommandHistory";

export class AddStrokeCommand implements Command {
  readonly label = "Add stroke";
  constructor(private readonly session: InkSession, private readonly stroke: InkStroke) {}
  execute(): void { this.session.add(this.stroke); }
  undo(): void { this.session.remove(this.stroke.id); }
}

export class DeleteStrokesCommand implements Command {
  readonly label = "Delete strokes";
  private readonly strokes: InkStroke[];
  constructor(private readonly session: InkSession, strokes: readonly InkStroke[]) { this.strokes = [...strokes]; }
  execute(): void { this.strokes.forEach((stroke) => this.session.remove(stroke.id)); }
  undo(): void { this.strokes.forEach((stroke) => this.session.add(stroke)); }
}

export class ReplaceStrokesCommand implements Command {
  readonly label = "Transform strokes";
  constructor(private readonly session: InkSession, private readonly before: readonly InkStroke[], private readonly after: readonly InkStroke[]) {
    if (before.length !== after.length) throw new Error("Replacement sets must have equal length");
  }
  execute(): void { this.after.forEach((stroke) => this.session.replace(stroke)); }
  undo(): void { this.before.forEach((stroke) => this.session.replace(stroke)); }
}

export function translateStrokes(strokes: readonly InkStroke[], dx: number, dy: number, now = new Date().toISOString()): InkStroke[] {
  return strokes.map((stroke) => ({ ...stroke, updatedAt: now, points: stroke.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })) }));
}
