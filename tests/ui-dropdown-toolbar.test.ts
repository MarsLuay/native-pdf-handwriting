import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import { AnnotationToolbar } from "../src/ui/AnnotationToolbar";
import { DropdownController } from "../src/ui/DropdownController";

afterEach(() => { document.body.replaceChildren(); });

describe("DropdownController", () => {
  it("selects, closes, restores focus, and supports keyboard navigation", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const selected = vi.fn();
    const dropdown = new DropdownController(document);
    dropdown.open("tools", trigger, { label: "Tools", options: [
      { id: "disabled", label: "Disabled", disabled: true, onSelect: vi.fn() },
      { id: "pen", label: "Pen", onSelect: selected },
      { id: "pencil", label: "Pencil", onSelect: vi.fn() }
    ] });
    expect(dropdown.isOpen("tools")).toBe(true);
    expect((document.activeElement as HTMLElement).dataset.optionId).toBe("pen");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect((document.activeElement as HTMLElement).dataset.optionId).toBe("pencil");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    (document.activeElement as HTMLButtonElement).click();
    expect(selected).toHaveBeenCalledOnce();
    expect(dropdown.isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("flips above on collision, closes outside and on Escape", () => {
    const trigger = document.createElement("button");
    trigger.getBoundingClientRect = () => ({ x: 10, y: 700, left: 10, top: 700, right: 54, bottom: 744, width: 44, height: 44, toJSON: () => ({}) });
    document.body.append(trigger);
    const dropdown = new DropdownController(document);
    dropdown.open("x", trigger, { label: "X", options: [{ id: "x", label: "X", onSelect: vi.fn() }] });
    expect(document.querySelector<HTMLElement>(".native-pdf-ink-dropdown")?.dataset.placement).toBe("top");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dropdown.isOpen()).toBe(false);
    dropdown.open("x", trigger, { label: "X", options: [{ id: "x", label: "X", onSelect: vi.fn() }] });
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(dropdown.isOpen()).toBe(false);
  });
});

describe("AnnotationToolbar", () => {
  it("defaults Draw off and reports explicit checkbox changes", () => {
    const drawChanged = vi.fn();
    const toolbar = new AnnotationToolbar({
      preferences: structuredClone(DEFAULT_SETTINGS.toolPreferences),
      autosave: true,
      drawEnabled: false,
      callbacks: { onPreferencesChange: vi.fn(), onDrawModeChange: drawChanged },
      document
    });
    document.body.append(toolbar.element);
    const draw = toolbar.element.querySelector<HTMLInputElement>("[data-control='draw']");
    expect(draw).toMatchObject({ checked: false, type: "checkbox" });
    expect(draw?.labels?.[0]?.querySelector(".native-pdf-ink-draw-toggle-label")?.textContent).toBe("Draw");
    expect(toolbar.element.querySelector(".native-pdf-ink-toolbar-controls")?.firstElementChild).toBe(draw?.labels?.[0]);
    draw?.click();
    expect(draw).toMatchObject({ checked: true });
    expect(drawChanged).toHaveBeenCalledWith(true);
    toolbar.destroy();
  });

  it("keeps Draw label in the DOM for main toolbar and aria title", () => {
    const toolbar = new AnnotationToolbar({
      preferences: structuredClone(DEFAULT_SETTINGS.toolPreferences),
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() },
      document
    });
    document.body.append(toolbar.element);
    expect(toolbar.element.querySelector(".native-pdf-ink-draw-toggle-label")?.textContent).toBe("Draw");
    toolbar.element.classList.add("is-sidebar-left");
    expect(toolbar.element.classList.contains("is-sidebar-left")).toBe(true);
    toolbar.destroy();
  });

  it("persists selected drawing preference, updates icon, and exposes manual save only when needed", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    const changed = vi.fn();
    const save = vi.fn();
    const toolbar = new AnnotationToolbar({ preferences, autosave: false, callbacks: { onPreferencesChange: changed, onSave: save }, document });
    document.body.append(toolbar.element);
    expect(toolbar.element.querySelector("[data-control='save']")).not.toBeNull();
    // Active drawing tool again → open options (no chevron arrow).
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='pencil']")?.click();
    expect(preferences.activeTool).toBe("pencil");
    const drawing = toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']");
    expect(drawing?.getAttribute("aria-label")).toBe("Pencil");
    expect(drawing?.classList.contains("clickable-icon")).toBe(true);
    expect(drawing?.querySelector("svg")).not.toBeNull();
    expect(changed).toHaveBeenCalled();
    toolbar.setAutosave(true);
    expect(toolbar.element.querySelector("[data-control='save']")).toBeNull();
    toolbar.setSaveStatus("failed");
    expect(toolbar.saveStatus.element.textContent).toBe("");
    expect(toolbar.saveStatus.element.getAttribute("aria-label")).toBe("Save failed");
    expect(toolbar.saveStatus.element.dataset.status).toBe("failed");
    expect(toolbar.saveStatus.element.querySelector(".native-pdf-ink-save-status-dot")).not.toBeNull();
    expect(toolbar.saveStatus.element.parentElement).toBe(toolbar.element);
    expect(toolbar.saveStatus.element.previousElementSibling?.classList.contains("native-pdf-ink-toolbar-controls")).toBe(true);
    toolbar.destroy();
  });

  it("shows the active drawing color as the color button icon", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    preferences.pen.color = "#dc2626";
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() },
      document
    });
    document.body.append(toolbar.element);
    const color = toolbar.element.querySelector<HTMLButtonElement>("[data-control='color']");
    const swatch = color?.querySelector<HTMLElement>(".native-pdf-ink-color-icon");
    expect(swatch?.style.backgroundColor).toBe("rgb(220, 38, 38)");
    expect(color?.querySelector("svg")).toBeNull();
    toolbar.destroy();
  });

  it("offers an eraser size slider with live preview", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    const changed = vi.fn();
    const previewed = vi.fn();
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: {
        onPreferencesChange: changed,
        onEraserSizePreview: previewed
      },
      document
    });
    document.body.append(toolbar.element);
    const eraser = toolbar.element.querySelector<HTMLButtonElement>("[data-control='eraser']");
    eraser?.click(); // select
    eraser?.click(); // open options when already selected
    const slider = document.querySelector<HTMLInputElement>(".native-pdf-ink-eraser-menu input[type='range']");
    const preview = document.querySelector<HTMLElement>(".native-pdf-ink-eraser-menu .native-pdf-ink-eraser-preview");
    const frame = document.querySelector<HTMLElement>(".native-pdf-ink-eraser-preview-frame");
    expect(slider).toMatchObject({ min: "4", max: "100", step: "1", value: "12" });
    expect(frame?.style.getPropertyValue("--ink-eraser-preview-frame-size")).toBe("100px");
    expect(preview?.style.getPropertyValue("--ink-eraser-preview-size")).toBe("12px");
    slider!.value = "20";
    slider!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(preferences.activeTool).toBe("eraser");
    expect(preferences.eraser).toEqual({ size: 20 });
    expect(preview?.style.getPropertyValue("--ink-eraser-preview-size")).toBe("20px");
    expect(previewed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce(); // first click activated eraser
    slider!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(changed).toHaveBeenCalledTimes(2);
    toolbar.destroy();
  });
});
