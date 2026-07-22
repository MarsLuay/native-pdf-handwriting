export type DrawingTool = "pen" | "pencil" | "highlighter";
/** There is no Pan tool: Draw off restores native PDF navigation. */
export type ToolId = DrawingTool | "text" | "eraser" | "lasso" | "laser";
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

export function isToolId(tool: unknown): tool is ToolId {
  return typeof tool === "string" && (isDrawingTool(tool) || tool === "text" || tool === "eraser" || tool === "lasso" || tool === "laser");
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

/** Editable text placed by the Text tool; source PDF content is never changed. */
export interface PdfTextAnnotation {
  id: string;
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  runs: PdfTextRun[];
  sourceRuns: PdfTextRun[];
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

export interface TextStyle {
  color: string;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
}

export interface EraserPreferences {
  size: number;
  eraseWholeStrokes: boolean;
  eraseWithRightMouseButton: boolean;
}

export interface ShapePreferences {
  /** A half-second stationary hold after drawing asks the recogniser to replace confident shapes. */
  holdToRecognize: boolean;
}

export interface ToolPreferences {
  activeTool: ToolId;
  pen: DrawingToolPreferences;
  pencil: DrawingToolPreferences;
  highlighter: DrawingToolPreferences;
  shape: ShapePreferences;
  text: TextStyle;
  eraser: EraserPreferences;
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
  /** Escape commits an active text annotation, per the selected workflow. */
  textEscapeAction: "save";
  sidecarFolder: string;
  mouseDragScroll: boolean;
  simplifyStrokes: boolean;
  /** Advanced opt-in: raise Obsidian PDF viewer zoom from 10× to 25×. */
  boostedPdfZoom: boolean;
  /** Advanced accessibility opt-out; the page label remains visible by default. */
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
  textEscapeAction: "save",
  sidecarFolder: `${root}/plugins/${PLUGIN_ID}/annotations`,
  mouseDragScroll: true,
  simplifyStrokes: true,
  boostedPdfZoom: false,
  hideStylusAnnotationLabel: false,
  toolbarPlacement: "main",
  vaultDebugLog: false,
  vaultDebugLogPath: `${root}/plugins/${PLUGIN_ID}/debug.md`,
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
      simulateMousePressure: true
    },
    shape: { holdToRecognize: true },
    text: {
      color: "#111827",
      fontSize: 16,
      fontFamily: "sans-serif",
      bold: false,
      italic: false,
      strikethrough: false
    },
    eraser: { size: 12, eraseWholeStrokes: false, eraseWithRightMouseButton: false },
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
  "retainSidecarAfterDirectModification",
  "showZoomMenu"
] as const;

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
  const savedToolPreferences = { ...(cleaned.toolPreferences ?? {}) } as Record<string, unknown>;
  delete savedToolPreferences.pan;
  // Shape recognition used to be a separate active tool. It is now an enabled-by-default
  // option in every drawing tool's Advanced settings, so safely return existing users to pen.
  const savedActiveTool = (cleaned.toolPreferences as { activeTool?: unknown } | undefined)?.activeTool;
  const activeTool = savedActiveTool === "shape"
    ? "pen"
    : isToolId(savedActiveTool)
      ? savedActiveTool
      : defaults.toolPreferences.activeTool;
  const merged = {
    ...defaults,
    ...cleaned,
    toolbarPlacement: toolbarPlacement === "left" || toolbarPlacement === "right" || toolbarPlacement === "main"
      ? toolbarPlacement
      : defaults.toolbarPlacement,
    textEscapeAction: "save" as const,
    boostedPdfZoom: cleaned.boostedPdfZoom === true,
    hideStylusAnnotationLabel: cleaned.hideStylusAnnotationLabel === true,
    toolPreferences: {
      ...defaults.toolPreferences,
      ...savedToolPreferences,
      activeTool,
      pen: { ...defaults.toolPreferences.pen, ...cleaned.toolPreferences?.pen },
      pencil: { ...defaults.toolPreferences.pencil, ...cleaned.toolPreferences?.pencil },
        highlighter: {
          ...defaults.toolPreferences.highlighter,
          ...cleaned.toolPreferences?.highlighter
        },
        shape: {
          holdToRecognize: cleaned.toolPreferences?.shape?.holdToRecognize !== false
        },
      text: {
        color: cleaned.toolPreferences?.text?.color ?? defaults.toolPreferences.text.color,
        fontSize: cleaned.toolPreferences?.text?.fontSize ?? defaults.toolPreferences.text.fontSize,
        fontFamily: cleaned.toolPreferences?.text?.fontFamily ?? defaults.toolPreferences.text.fontFamily,
        bold: cleaned.toolPreferences?.text?.bold === true,
        italic: cleaned.toolPreferences?.text?.italic === true,
        strikethrough: cleaned.toolPreferences?.text?.strikethrough === true
      },
      eraser: {
        size: cleaned.toolPreferences?.eraser?.size ?? defaults.toolPreferences.eraser.size,
        eraseWholeStrokes: cleaned.toolPreferences?.eraser?.eraseWholeStrokes === true,
        eraseWithRightMouseButton: cleaned.toolPreferences?.eraser?.eraseWithRightMouseButton === true
      },
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
  merged.vaultDebugLogPath = migrateVaultDebugLogPath(
    remapPluginDataPath(cleaned.vaultDebugLogPath, defaults.vaultDebugLogPath, configDir)
  );
  return merged;
}

/** Prefer `.md` so the vault log opens as a note in Obsidian. */
function migrateVaultDebugLogPath(path: string): string {
  return path.replace(/\/debug\.log$/i, "/debug.md").replace(/^debug\.log$/i, "debug.md");
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
