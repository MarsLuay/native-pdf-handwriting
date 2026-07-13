import type { InkStroke } from "../model";

export class InkSession {
  private readonly byPage = new Map<number, InkStroke[]>();
  constructor(initial: readonly InkStroke[] = []) { initial.forEach((stroke) => this.add(stroke)); }

  add(stroke: InkStroke): void { this.byPage.set(stroke.page, [...(this.byPage.get(stroke.page) ?? []), stroke]); }
  remove(id: string): InkStroke | undefined {
    for (const [page, strokes] of this.byPage) {
      const index = strokes.findIndex((stroke) => stroke.id === id);
      if (index >= 0) { const [removed] = strokes.splice(index, 1); this.byPage.set(page, strokes); return removed; }
    }
    return undefined;
  }
  replace(stroke: InkStroke): void { this.remove(stroke.id); this.add(stroke); }
  page(page: number): readonly InkStroke[] { return this.byPage.get(page) ?? []; }
  all(): InkStroke[] { return [...this.byPage.values()].flat(); }
  clear(): void { this.byPage.clear(); }
}

