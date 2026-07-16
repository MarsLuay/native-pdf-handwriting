export type DrawingTool = "pen" | "pencil" | "highlighter";
export type ToolId = DrawingTool | "text" | "eraser" | "lasso" | "laser" | "pan";
export type LassoType = "freeform" | "rectangle";
export type ToolbarPlacement = "main" | "left" | "right";
export type SaveStatus = "saved" | "saving" | "dirty" | "failed";
export type TextEscapeAction = "save" | "discard";
export type SingleTouchMode = "none" | "touch" | "stylus";

export function isDrawingTool(tool: ToolId): tool is DrawingTool {
  return tool === "pen" || tool === "pencil" || tool === "highlighter";
}

/** Freehand ink routed as draw (persisted tools plus the ephemeral laser). */
export function isInkDrawTool(tool: ToolId): tool is DrawingTool | "laser" {
  return isDrawingTool(tool) || tool === "laser";
}

export function resolveDrawingTool(tool: ToolId): DrawingTool {
  return isDrawingTool(tool) ? tool : "pen";
}

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

export interface PdfTextAnnotation {
  id: string;
  page: number;
  text: string;
  x: number;
  y: number;
  color: string;
  fontSize: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  runs?: PdfTextRun[];
  sourceRuns?: PdfTextRun[];
  createdAt: string;
  updatedAt: string;
}

export interface PdfTextRun {
  text: string;
  color: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
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

export interface TextStyle {
  color: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
}

export interface LaserToolPreferences {
  color: string;
  width: number;
  opacity: number;
  holdMs: number;
  fadeMs: number;
}

export interface ToolPreferences {
  activeTool: ToolId;
  pen: DrawingToolPreferences;
  pencil: DrawingToolPreferences;
  highlighter: DrawingToolPreferences;
  text: TextStyle;
  eraser: { size: number; eraseWholeStrokes: boolean; eraseWithRightMouseButton: boolean };
  lasso: { type: LassoType };
  laser: LaserToolPreferences;
  recentColors: string[];
}

export interface TouchNavigationSettings {
  singleTouchMode: SingleTouchMode;
  twoFingerPinchZoom: boolean;
  twoFingerSwipeScroll: boolean;
}

export interface PluginSettings extends TouchNavigationSettings {
  autosave: boolean;
  autosaveDelayMs: number;
  saveWhenClosing: boolean;
  showSaveStatus: boolean;
  retryFailedAutosaves: boolean;
  skipTextCancelConfirmation: boolean;
  textEscapeAction: TextEscapeAction | null;
  sidecarFolder: string;
  simplifyStrokes: boolean;
  holdToStraighten: boolean;
  hideStylusAnnotationLabel: boolean;
  toolbarPlacement: ToolbarPlacement;
  vaultDebugLog: boolean;
  vaultDebugLogPath: string;
  toolPreferences: ToolPreferences;
}

export const PLUGIN_ID = "native-pdf-handwriting";

/** Build path defaults from Vault#configDir. */
export function createDefaultSettings(configDir: string): PluginSettings {
  const root = configDir.replace(/\\/g, "/").replace(/\/+$/, "");
  return {
  autosave: true,
  autosaveDelayMs: 750,
  saveWhenClosing: true,
  showSaveStatus: true,
  retryFailedAutosaves: true,
  skipTextCancelConfirmation: false,
  textEscapeAction: null,
  sidecarFolder: `${root}/plugins/${PLUGIN_ID}/annotations`,
  singleTouchMode: "touch",
  twoFingerPinchZoom: true,
  twoFingerSwipeScroll: true,
  simplifyStrokes: true,
  holdToStraighten: false,
  hideStylusAnnotationLabel: false,
  toolbarPlacement: "main",
  vaultDebugLog: false,
  vaultDebugLogPath: `${root}/plugins/${PLUGIN_ID}/debug.log`,
  toolPreferences: {
    activeTool: "pen",
    pen: {
      color: "#111827",
      width: 1.5,
      opacity: 1,
      pressureSensitivity: true,
      stabilization: "medium",
      thinning: 0.55,
      textureStrength: 0,
      tiltSensitivity: false,
      simulateMousePressure: true
    },
    pencil: {
      color: "#4b5563",
      width: 3.5,
      opacity: 0.55,
      pressureSensitivity: true,
      stabilization: "low",
      thinning: 0.2,
      textureStrength: 0.85,
      tiltSensitivity: true,
      simulateMousePressure: true
    },
    highlighter: {
      color: "#facc15",
      width: 4.5,
      opacity: 0.3,
      pressureSensitivity: false,
      stabilization: "medium",
      thinning: 0,
      textureStrength: 0,
      tiltSensitivity: false,
      simulateMousePressure: true
    },
    text: { color: "#111827", fontSize: 16, fontFamily: "sans-serif", bold: false, italic: false },
    eraser: { size: 12, eraseWholeStrokes: false, eraseWithRightMouseButton: false },
    lasso: { type: "freeform" },
    laser: { color: "#ff0000", width: 2, opacity: 0.95, holdMs: 900, fadeMs: 1400 },
    recentColors: ["#111827", "#2563eb", "#dc2626", "#059669", "#f59e0b"]
  }
  };
}

/** Test/helper defaults; runtime uses createDefaultSettings(app.vault.configDir). */
export const DEFAULT_SETTINGS: PluginSettings = createDefaultSettings("config");

const LEGACY_SETTING_KEYS = [
  "yoloMode",
  "yoloConfirmed",
  "yoloAutosaveDelayMs",
  "createBackupBeforeDirectModification",
  "backupLocation",
  "retainSidecarAfterDirectModification",
  "mouseDragScroll",
  "showZoomMenu"
] as const;

export function serializePluginSettings(settings: PluginSettings): string {
  return JSON.stringify(settings, null, 2);
}

export function mergeSettings(
  saved: Partial<PluginSettings> | null | undefined,
  configDir = "config"
): PluginSettings {
  const defaults = createDefaultSettings(configDir);
  const raw = { ...(saved ?? {}) } as Record<string, unknown>;
  for (const key of LEGACY_SETTING_KEYS) delete raw[key];
  const cleaned = raw as Partial<PluginSettings>;
  const lassoRaw = { ...defaults.toolPreferences.lasso, ...cleaned.toolPreferences?.lasso } as {
    type: LassoType;
    includeLocked?: unknown;
    selectionMode?: unknown;
  };
  const lasso = {
    type: lassoRaw.type === "freeform" || lassoRaw.type === "rectangle" ? lassoRaw.type : "freeform" as const
  };
  const toolbarPlacement = cleaned.toolbarPlacement;
  const singleTouchMode = cleaned.singleTouchMode;
  const savedToolPreferences = { ...(cleaned.toolPreferences ?? {}) } as Record<string, unknown>;
  delete savedToolPreferences.pan;
  const textEscapeAction = cleaned.textEscapeAction === "save" || cleaned.textEscapeAction === "discard"
    ? cleaned.textEscapeAction
    : "discard";
  const merged = {
    ...defaults,
    ...cleaned,
    skipTextCancelConfirmation: cleaned.skipTextCancelConfirmation === true,
    textEscapeAction: cleaned.skipTextCancelConfirmation === true ? textEscapeAction : null,
    toolbarPlacement: toolbarPlacement === "left" || toolbarPlacement === "right" || toolbarPlacement === "main"
      ? toolbarPlacement
      : defaults.toolbarPlacement,
    singleTouchMode: singleTouchMode === "none" || singleTouchMode === "touch" || singleTouchMode === "stylus"
      ? singleTouchMode
      : defaults.singleTouchMode,
    twoFingerPinchZoom: cleaned.twoFingerPinchZoom !== false,
    twoFingerSwipeScroll: cleaned.twoFingerSwipeScroll !== false,
    toolPreferences: {
      ...defaults.toolPreferences,
      ...savedToolPreferences,
      pen: { ...defaults.toolPreferences.pen, ...cleaned.toolPreferences?.pen },
      pencil: { ...defaults.toolPreferences.pencil, ...cleaned.toolPreferences?.pencil },
      highlighter: { ...defaults.toolPreferences.highlighter, ...cleaned.toolPreferences?.highlighter },
      text: {
        color: cleaned.toolPreferences?.text?.color ?? defaults.toolPreferences.text.color,
        fontSize: cleaned.toolPreferences?.text?.fontSize ?? defaults.toolPreferences.text.fontSize,
        fontFamily: cleaned.toolPreferences?.text?.fontFamily ?? defaults.toolPreferences.text.fontFamily,
        bold: cleaned.toolPreferences?.text?.bold === true,
        italic: cleaned.toolPreferences?.text?.italic === true
      },
      eraser: {
        size: cleaned.toolPreferences?.eraser?.size ?? defaults.toolPreferences.eraser.size,
        eraseWholeStrokes: cleaned.toolPreferences?.eraser?.eraseWholeStrokes === true,
        eraseWithRightMouseButton: cleaned.toolPreferences?.eraser?.eraseWithRightMouseButton === true
      },
      laser: {
        ...defaults.toolPreferences.laser,
        ...cleaned.toolPreferences?.laser,
        holdMs: clampLaserTiming(cleaned.toolPreferences?.laser?.holdMs, 200, 3000, defaults.toolPreferences.laser.holdMs),
        fadeMs: clampLaserTiming(cleaned.toolPreferences?.laser?.fadeMs, 300, 4000, defaults.toolPreferences.laser.fadeMs)
      },
      lasso
    }
  };
  merged.sidecarFolder = remapPluginDataPath(cleaned.sidecarFolder, defaults.sidecarFolder, configDir);
  merged.vaultDebugLogPath = remapPluginDataPath(cleaned.vaultDebugLogPath, defaults.vaultDebugLogPath, configDir);
  return merged;
}

function clampLaserTiming(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function remapPluginDataPath(saved: string | undefined, fallback: string, configDir: string): string {
  if (saved === "") return "";
  if (!saved || !saved.trim()) return fallback;
  const marker = `/plugins/${PLUGIN_ID}`;
  const normalized = saved.replace(/\\/g, "/");
  const index = normalized.indexOf(marker);
  if (index >= 0) {
    const root = configDir.replace(/\\/g, "/").replace(/\/+$/, "");
    return `${root}${normalized.slice(index)}`;
  }
  return saved;
}
