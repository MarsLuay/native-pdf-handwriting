export type DrawingTool = "pen" | "pencil" | "highlighter";
export type ToolId = DrawingTool | "eraser" | "lasso" | "laser" | "pan";
export type LassoType = "freeform" | "rectangle";
export type ToolbarPlacement = "main" | "left" | "right";
export type SaveStatus = "saved" | "saving" | "dirty" | "failed";

export const DRAWING_TOOLS = ["pen", "pencil", "highlighter"] as const;

export function isDrawingTool(tool: string): tool is DrawingTool {
  return tool === "pen" || tool === "pencil" || tool === "highlighter";
}

/** Freehand ink routed as draw (persisted tools + ephemeral laser). */
export function isInkDrawTool(tool: string): tool is DrawingTool | "laser" {
  return isDrawingTool(tool) || tool === "laser";
}

/** Active drawing tool, or pen when a non-drawing tool is selected. */
export function resolveDrawingTool(active: ToolId): DrawingTool {
  return isDrawingTool(active) ? active : "pen";
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

/** Ephemeral laser pointer — never written to sidecar. */
export interface LaserPreferences {
  color: string;
  width: number;
  opacity: number;
  /** Full-opacity linger before fade starts (ms). */
  holdMs: number;
  /** Fade + trail erase duration after hold (ms). */
  fadeMs: number;
}

export interface ToolPreferences {
  activeTool: ToolId;
  pen: DrawingToolPreferences;
  pencil: DrawingToolPreferences;
  highlighter: DrawingToolPreferences;
  eraser: { size: number };
  lasso: { type: LassoType };
  laser: LaserPreferences;
  recentColors: string[];
}

export interface PluginSettings {
  autosave: boolean;
  autosaveDelayMs: number;
  saveWhenClosing: boolean;
  showSaveStatus: boolean;
  retryFailedAutosaves: boolean;
  sidecarFolder: string;
  mouseDragScroll: boolean;
  simplifyStrokes: boolean;
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
  sidecarFolder: `${root}/plugins/${PLUGIN_ID}/annotations`,
  mouseDragScroll: true,
  simplifyStrokes: true,
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
      width: 4,
      opacity: 0.88,
      pressureSensitivity: true,
      stabilization: "low",
      thinning: 0.2,
      textureStrength: 0.85,
      tiltSensitivity: true,
      simulateMousePressure: true
    },
    highlighter: {
      color: "#facc15",
      width: 14,
      opacity: 0.35,
      pressureSensitivity: false,
      stabilization: "low",
      thinning: 0.05,
      textureStrength: 0,
      tiltSensitivity: false,
      simulateMousePressure: false
    },
    eraser: { size: 12 },
    lasso: { type: "freeform" },
    laser: {
      color: "#ff0000",
      width: 2,
      opacity: 0.95,
      holdMs: 900,
      fadeMs: 1400
    },
    recentColors: ["#111827", "#2563eb", "#dc2626", "#059669", "#f59e0b", "#facc15"]
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
  "retainSidecarAfterDirectModification"
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
  const merged = {
    ...defaults,
    ...cleaned,
    toolbarPlacement: toolbarPlacement === "left" || toolbarPlacement === "right" || toolbarPlacement === "main"
      ? toolbarPlacement
      : defaults.toolbarPlacement,
    toolPreferences: {
      ...defaults.toolPreferences,
      ...cleaned.toolPreferences,
      pen: { ...defaults.toolPreferences.pen, ...cleaned.toolPreferences?.pen },
      pencil: { ...defaults.toolPreferences.pencil, ...cleaned.toolPreferences?.pencil },
      highlighter: {
        ...defaults.toolPreferences.highlighter,
        ...cleaned.toolPreferences?.highlighter
      },
      eraser: { size: cleaned.toolPreferences?.eraser?.size ?? defaults.toolPreferences.eraser.size },
      lasso,
      laser: {
        ...defaults.toolPreferences.laser,
        ...cleaned.toolPreferences?.laser,
        holdMs: clampLaserMs(
          cleaned.toolPreferences?.laser?.holdMs ?? defaults.toolPreferences.laser.holdMs,
          200,
          3000,
          defaults.toolPreferences.laser.holdMs
        ),
        fadeMs: clampLaserMs(
          cleaned.toolPreferences?.laser?.fadeMs ?? defaults.toolPreferences.laser.fadeMs,
          300,
          4000,
          defaults.toolPreferences.laser.fadeMs
        )
      }
    }
  };
  merged.sidecarFolder = remapPluginDataPath(cleaned.sidecarFolder, defaults.sidecarFolder, configDir);
  merged.vaultDebugLogPath = remapPluginDataPath(cleaned.vaultDebugLogPath, defaults.vaultDebugLogPath, configDir);
  return merged;
}

function remapPluginDataPath(saved: string | undefined, fallback: string, configDir: string): string {
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

function clampLaserMs(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
