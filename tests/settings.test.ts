import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/model";

describe("safe defaults", () => {
  it("enables autosave", () => {
    expect(DEFAULT_SETTINGS.autosave).toBe(true);
    expect(DEFAULT_SETTINGS.autosaveDelayMs).toBe(750);
    expect(DEFAULT_SETTINGS.saveWhenClosing).toBe(true);
  });

  it("keeps pen, pencil, and highlighter preferences separate", () => {
    expect(DEFAULT_SETTINGS.toolPreferences.pen).not.toEqual(
      DEFAULT_SETTINGS.toolPreferences.pencil
    );
    expect(DEFAULT_SETTINGS.toolPreferences.pencil.textureStrength).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.toolPreferences.highlighter.width).toBeGreaterThan(
      DEFAULT_SETTINGS.toolPreferences.pen.width
    );
    expect(DEFAULT_SETTINGS.toolPreferences.highlighter.opacity).toBeLessThan(0.5);
    expect(DEFAULT_SETTINGS.toolPreferences.highlighter.color).toBe("#facc15");
  });

  it("merges highlighter preferences from saved settings", () => {
    const merged = mergeSettings({
      toolPreferences: {
        highlighter: { width: 24, opacity: 0.2 }
      } as never
    });
    expect(merged.toolPreferences.highlighter.width).toBe(24);
    expect(merged.toolPreferences.highlighter.opacity).toBe(0.2);
    expect(merged.toolPreferences.highlighter.color).toBe("#facc15");
  });

  it("merges laser preferences from saved settings", () => {
    const merged = mergeSettings({
      toolPreferences: {
        laser: { color: "#22c55e", holdMs: 500 }
      } as never
    });
    expect(merged.toolPreferences.laser.color).toBe("#22c55e");
    expect(merged.toolPreferences.laser.holdMs).toBe(500);
    expect(merged.toolPreferences.laser.fadeMs).toBe(DEFAULT_SETTINGS.toolPreferences.laser.fadeMs);
    expect(merged.toolPreferences.laser.width).toBe(DEFAULT_SETTINGS.toolPreferences.laser.width);
  });

  it("enables half-second shape recognition by default while allowing an opt-out", () => {
    expect(DEFAULT_SETTINGS.toolPreferences.shape.holdToRecognize).toBe(true);
    expect(mergeSettings({ toolPreferences: { shape: { holdToRecognize: false } } as never }).toolPreferences.shape.holdToRecognize).toBe(false);
    expect(mergeSettings({ toolPreferences: { activeTool: "shape" } as never }).toolPreferences.activeTool).toBe("pen");
  });

  it("enables mouse drag scroll by default", () => {
    expect(DEFAULT_SETTINGS.mouseDragScroll).toBe(true);
    expect({ ...DEFAULT_SETTINGS, mouseDragScroll: false }.mouseDragScroll).toBe(false);
  });

  it("enables stroke simplification by default", () => {
    expect(DEFAULT_SETTINGS.simplifyStrokes).toBe(true);
    expect({ ...DEFAULT_SETTINGS, simplifyStrokes: false }.simplifyStrokes).toBe(false);
  });

  it("keeps vault debug log off by default", () => {
    expect(DEFAULT_SETTINGS.vaultDebugLog).toBe(false);
    expect(DEFAULT_SETTINGS.vaultDebugLogPath).toBe(
      "config/plugins/native-pdf-handwriting/debug.md"
    );
  });

  it("migrates vault debug log path from .log to .md", () => {
    const merged = mergeSettings({
      vaultDebugLogPath: ".obsidian/plugins/native-pdf-handwriting/debug.log"
    }, ".obsidian");
    expect(merged.vaultDebugLogPath).toBe(".obsidian/plugins/native-pdf-handwriting/debug.md");
  });

  it("defaults toolbar placement to the PDF bar", () => {
    expect(DEFAULT_SETTINGS.toolbarPlacement).toBe("main");
    expect(mergeSettings({ toolbarPlacement: "right" }).toolbarPlacement).toBe("right");
    expect(mergeSettings({ toolbarPlacement: "nope" as "main" }).toolbarPlacement).toBe("main");
  });

  it("strips legacy YOLO Mode keys and unused lasso fields from saved settings", () => {
    const merged = mergeSettings({
      autosave: false,
      yoloMode: true,
      yoloConfirmed: true,
      yoloAutosaveDelayMs: 9999,
      createBackupBeforeDirectModification: false,
      backupLocation: "somewhere",
      retainSidecarAfterDirectModification: false,
      toolPreferences: {
        lasso: { type: "rectangle", includeLocked: true, selectionMode: "enclosed" } as never
      }
    } as unknown as Partial<typeof DEFAULT_SETTINGS> & Record<string, unknown>);
    expect(merged.autosave).toBe(false);
    expect(merged).not.toHaveProperty("yoloMode");
    expect(merged).not.toHaveProperty("yoloConfirmed");
    expect(merged).not.toHaveProperty("backupLocation");
    expect(merged.toolPreferences.lasso).toEqual({ type: "rectangle" });
  });

});
