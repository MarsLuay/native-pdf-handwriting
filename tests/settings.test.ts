import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, serializePluginSettings } from "../src/model";

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

  it("keeps right mouse erasing disabled until explicitly enabled", () => {
    expect(DEFAULT_SETTINGS.toolPreferences.eraser.eraseWithRightMouseButton).toBe(false);
    expect(mergeSettings({
      toolPreferences: { eraser: { eraseWithRightMouseButton: true } } as never
    }).toolPreferences.eraser.eraseWithRightMouseButton).toBe(true);
  });

  it("defaults touch navigation to one-finger scrolling with two-finger zoom and swipe enabled", () => {
    expect(DEFAULT_SETTINGS.singleTouchMode).toBe("touch");
    expect(DEFAULT_SETTINGS.twoFingerPinchZoom).toBe(true);
    expect(DEFAULT_SETTINGS.twoFingerSwipeScroll).toBe(true);
    expect(mergeSettings({ singleTouchMode: "stylus", twoFingerPinchZoom: false, twoFingerSwipeScroll: false }))
      .toMatchObject({ singleTouchMode: "stylus", twoFingerPinchZoom: false, twoFingerSwipeScroll: false });
    expect(mergeSettings({ singleTouchMode: "invalid" as never }).singleTouchMode).toBe("touch");
  });

  it("enables stroke simplification by default", () => {
    expect(DEFAULT_SETTINGS.simplifyStrokes).toBe(true);
    expect({ ...DEFAULT_SETTINGS, simplifyStrokes: false }.simplifyStrokes).toBe(false);
  });

  it("keeps hold to straighten disabled until explicitly enabled", () => {
    expect(DEFAULT_SETTINGS.holdToStraighten).toBe(false);
    expect(mergeSettings({ holdToStraighten: true }).holdToStraighten).toBe(true);
  });

  it("remembers only a valid Escape text action when confirmation is skipped", () => {
    expect(DEFAULT_SETTINGS.skipTextCancelConfirmation).toBe(false);
    expect(DEFAULT_SETTINGS.textEscapeAction).toBeNull();
    expect(mergeSettings({ skipTextCancelConfirmation: true, textEscapeAction: "save" }).textEscapeAction).toBe("save");
    expect(mergeSettings({ skipTextCancelConfirmation: true, textEscapeAction: "discard" }).textEscapeAction).toBe("discard");
    expect(mergeSettings({ skipTextCancelConfirmation: false, textEscapeAction: "save" }).textEscapeAction).toBeNull();
    expect(mergeSettings({ skipTextCancelConfirmation: true, textEscapeAction: "keep-editing" as never }).textEscapeAction).toBe("discard");
  });

  it("shows the stylus annotation label by default", () => {
    expect(DEFAULT_SETTINGS.hideStylusAnnotationLabel).toBe(false);
    expect(mergeSettings({ hideStylusAnnotationLabel: true }).hideStylusAnnotationLabel).toBe(true);
  });

  it("keeps vault debug log off by default", () => {
    expect(DEFAULT_SETTINGS.vaultDebugLog).toBe(false);
    expect(DEFAULT_SETTINGS.vaultDebugLogPath).toBe(
      "config/plugins/native-pdf-handwriting/debug.log"
    );
  });

  it("keeps a custom vault-relative annotation sidecar folder", () => {
    expect(mergeSettings({ sidecarFolder: "Annotations/PDF ink" }).sidecarFolder).toBe("Annotations/PDF ink");
  });

  it("defaults toolbar placement to the PDF bar", () => {
    expect(DEFAULT_SETTINGS.toolbarPlacement).toBe("main");
    expect(mergeSettings({ toolbarPlacement: "right" }).toolbarPlacement).toBe("right");
    expect(mergeSettings({ toolbarPlacement: "nope" as "main" }).toolbarPlacement).toBe("main");
  });

  it("strips legacy navigation, YOLO Mode, and unused lasso fields from saved settings", () => {
    const merged = mergeSettings({
      autosave: false,
      mouseDragScroll: false,
      showZoomMenu: true,
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
    expect(merged).not.toHaveProperty("mouseDragScroll");
    expect(merged).not.toHaveProperty("showZoomMenu");
    expect(merged.toolPreferences.lasso).toEqual({ type: "rectangle" });
  });

  it("removes the legacy Pan touch preference during migration", () => {
    const merged = mergeSettings({
      toolPreferences: { pan: { treatSingleTouchAsStylus: true } } as never
    });
    expect(merged.toolPreferences).not.toHaveProperty("pan");
  });

  it("copies every setting as readable JSON", () => {
    const copied = JSON.parse(serializePluginSettings(DEFAULT_SETTINGS));
    expect(copied).toEqual(DEFAULT_SETTINGS);
    expect(serializePluginSettings(DEFAULT_SETTINGS)).toContain("\n  \"autosave\"");
    expect(serializePluginSettings(DEFAULT_SETTINGS)).not.toContain("yoloMode");
  });
});
