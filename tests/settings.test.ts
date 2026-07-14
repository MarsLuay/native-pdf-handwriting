import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, serializePluginSettings } from "../src/model";

describe("safe defaults", () => {
  it("enables autosave", () => {
    expect(DEFAULT_SETTINGS.autosave).toBe(true);
    expect(DEFAULT_SETTINGS.autosaveDelayMs).toBe(750);
    expect(DEFAULT_SETTINGS.saveWhenClosing).toBe(true);
  });

  it("keeps pen and pencil preferences separate", () => {
    expect(DEFAULT_SETTINGS.toolPreferences.pen).not.toEqual(
      DEFAULT_SETTINGS.toolPreferences.pencil
    );
    expect(DEFAULT_SETTINGS.toolPreferences.pencil.textureStrength).toBeGreaterThan(0);
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
      "config/plugins/native-pdf-handwriting/debug.log"
    );
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

  it("copies every setting as readable JSON", () => {
    const copied = JSON.parse(serializePluginSettings(DEFAULT_SETTINGS));
    expect(copied).toEqual(DEFAULT_SETTINGS);
    expect(serializePluginSettings(DEFAULT_SETTINGS)).toContain("\n  \"autosave\"");
    expect(serializePluginSettings(DEFAULT_SETTINGS)).not.toContain("yoloMode");
  });
});
