import type { DrawingTool, ToolId, ToolPreferences } from "../model";
import { mergeToolPreferences } from "./ToolPreferences";

export class ToolController {
  private preferences: ToolPreferences;
  constructor(initial?: Partial<ToolPreferences>, private readonly changed?: (preferences: ToolPreferences) => void) {
    this.preferences = mergeToolPreferences(initial);
  }
  get(): Readonly<ToolPreferences> { return this.preferences; }
  activate(tool: ToolId): void { this.update({ activeTool: tool }); }
  configureDrawing(tool: DrawingTool, changes: Partial<ToolPreferences[DrawingTool]>): void {
    this.update({ [tool]: { ...this.preferences[tool], ...changes } });
  }
  update(changes: Partial<ToolPreferences>): void {
    this.preferences = mergeToolPreferences({ ...this.preferences, ...changes });
    this.changed?.(this.preferences);
  }
}

