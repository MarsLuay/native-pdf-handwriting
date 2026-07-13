export type DrawingTool = "pen" | "pencil";
export type ToolId = DrawingTool | "eraser" | "lasso" | "pan";
export type LassoType = "freeform" | "ellipse" | "rectangle";
export type SelectionMode = "enclosed" | "intersecting";
export type SaveStatus = "saved" | "saving" | "dirty" | "failed";

export interface PdfPoint {
  x: number;
  y: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  time: number;
}

export interface InkStroke {
  id: string;
  page: number;
  tool: DrawingTool;
  color: string;
  width: number;
  opacity: number;
  inputType: "pen" | "mouse" | "touch";
  points: PdfPoint[];
  createdAt: string;
  updatedAt: string;
}

export interface DrawingToolPreferences {
  color: string;
  width: number;
  opacity: number;
  pressureSensitivity: boolean;
  stabilization: "off" | "low" | "medium" | "high";
  thinning: number;
  textureStrength: number;
  tiltSensitivity: boolean;
  simulateMousePressure: boolean;
}

export interface ToolPreferences {
  activeTool: ToolId;
  pen: DrawingToolPreferences;
  pencil: DrawingToolPreferences;
  eraser: { type: "stroke" | "segment"; size: number };
  lasso: { type: LassoType; selectionMode: SelectionMode; includeLocked: boolean };
  recentColors: string[];
}

export interface PluginSettings {
  autosave: boolean;
  autosaveDelayMs: number;
  saveWhenClosing: boolean;
  showSaveStatus: boolean;
  retryFailedAutosaves: boolean;
  sidecarFolder: string;
  yoloMode: boolean;
  yoloConfirmed: boolean;
  yoloAutosaveDelayMs: number;
  createBackupBeforeDirectModification: boolean;
  backupLocation: string;
  retainSidecarAfterDirectModification: boolean;
  toolPreferences: ToolPreferences;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  autosave: true,
  autosaveDelayMs: 750,
  saveWhenClosing: true,
  showSaveStatus: true,
  retryFailedAutosaves: true,
  sidecarFolder: ".obsidian/plugins/obsidian-native-pdf-ink/annotations",
  yoloMode: false,
  yoloConfirmed: false,
  yoloAutosaveDelayMs: 2000,
  createBackupBeforeDirectModification: true,
  backupLocation: ".obsidian/plugins/obsidian-native-pdf-ink/backups",
  retainSidecarAfterDirectModification: true,
  toolPreferences: {
    activeTool: "pen",
    pen: {
      color: "#111827",
      width: 2.5,
      opacity: 1,
      pressureSensitivity: true,
      stabilization: "medium",
      thinning: 0.55,
      textureStrength: 0,
      tiltSensitivity: false,
      simulateMousePressure: true
    },
    pencil: {
      color: "#374151",
      width: 3,
      opacity: 0.65,
      pressureSensitivity: true,
      stabilization: "low",
      thinning: 0.25,
      textureStrength: 0.45,
      tiltSensitivity: true,
      simulateMousePressure: true
    },
    eraser: { type: "stroke", size: 12 },
    lasso: { type: "freeform", selectionMode: "intersecting", includeLocked: false },
    recentColors: ["#111827", "#2563eb", "#dc2626", "#059669", "#f59e0b"]
  }
};

export function serializePluginSettings(settings: PluginSettings): string {
  return JSON.stringify(settings, null, 2);
}
