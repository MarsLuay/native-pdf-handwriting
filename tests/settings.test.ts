import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, serializePluginSettings } from "../src/model";

describe("safe defaults", () => {
  it("enables autosave", () => {
    expect(DEFAULT_SETTINGS.autosave).toBe(true);
    expect(DEFAULT_SETTINGS.autosaveDelayMs).toBe(750);
    expect(DEFAULT_SETTINGS.saveWhenClosing).toBe(true);
  });

  it("keeps direct PDF modification off and backups on", () => {
    expect(DEFAULT_SETTINGS.yoloMode).toBe(false);
    expect(DEFAULT_SETTINGS.yoloConfirmed).toBe(false);
    expect(DEFAULT_SETTINGS.createBackupBeforeDirectModification).toBe(true);
    expect(DEFAULT_SETTINGS.retainSidecarAfterDirectModification).toBe(true);
  });

  it("keeps pen and pencil preferences separate", () => {
    expect(DEFAULT_SETTINGS.toolPreferences.pen).not.toEqual(
      DEFAULT_SETTINGS.toolPreferences.pencil
    );
    expect(DEFAULT_SETTINGS.toolPreferences.pencil.textureStrength).toBeGreaterThan(0);
  });

  it("copies every setting as readable JSON", () => {
    const copied = JSON.parse(serializePluginSettings(DEFAULT_SETTINGS));
    expect(copied).toEqual(DEFAULT_SETTINGS);
    expect(serializePluginSettings(DEFAULT_SETTINGS)).toContain("\n  \"autosave\"");
  });
});
