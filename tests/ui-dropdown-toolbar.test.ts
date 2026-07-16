import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/model";
import { AnnotationToolbar } from "../src/ui/AnnotationToolbar";
import { DropdownController } from "../src/ui/DropdownController";

afterEach(() => { document.body.replaceChildren(); document.body.removeAttribute("style"); });

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
    expect(document.querySelector<HTMLElement>(".native-pdf-handwriting-dropdown")?.dataset.placement).toBe("top");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dropdown.isOpen()).toBe(false);
    dropdown.open("x", trigger, { label: "X", options: [{ id: "x", label: "X", onSelect: vi.fn() }] });
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(dropdown.isOpen()).toBe(false);
  });
});

describe("AnnotationToolbar", () => {
  it("uses Pan to leave drawing mode and a drawing tool to re-enter it", () => {
    const drawChanged = vi.fn();
    const toolbar = new AnnotationToolbar({
      preferences: structuredClone(DEFAULT_SETTINGS.toolPreferences),
      autosave: true,
      drawEnabled: true,
      callbacks: { onPreferencesChange: vi.fn(), onDrawModeChange: drawChanged },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    const pan = toolbar.element.querySelector<HTMLButtonElement>("[data-control='pan']");
    expect(pan?.getAttribute("aria-label")).toBe("Pan");
    expect(toolbar.element.querySelector("[data-control='draw']")).toBeNull();
    expect(toolbar.element.querySelector(".native-pdf-handwriting-toolbar-controls")?.firstElementChild).toBe(pan);
    pan?.click();
    expect(pan?.getAttribute("aria-pressed")).toBe("true");
    expect(drawChanged).toHaveBeenCalledWith(false);
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    expect(pan?.getAttribute("aria-pressed")).toBe("false");
    expect(drawChanged).toHaveBeenLastCalledWith(true);
    toolbar.destroy();
  });

  it("clears editing selections in Pan mode without a plugin zoom menu", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      drawEnabled: true,
      callbacks: { onPreferencesChange: vi.fn() },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    expect(toolbar.element.querySelector("[data-control='zoom']")).toBeNull();
    expect(toolbar.element.querySelector("[data-control='drawing']")?.getAttribute("aria-pressed")).toBe("true");
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='pan']")?.click();
    expect(toolbar.element.querySelector("[data-control='pan']")?.getAttribute("aria-pressed")).toBe("true");
    expect(toolbar.element.querySelector("[data-control='drawing']")?.getAttribute("aria-pressed")).toBe("false");
    expect(toolbar.element.querySelector("[data-control='eraser']")?.getAttribute("aria-pressed")).toBe("false");
    expect(toolbar.element.querySelector("[data-control='lasso']")?.getAttribute("aria-pressed")).toBe("false");
    toolbar.destroy();
  });

  it("shows the current sidebar placement when reopening More", () => {
    let placement: "main" | "left" | "right" = "main";
    const toolbar = new AnnotationToolbar({
      preferences: structuredClone(DEFAULT_SETTINGS.toolPreferences),
      autosave: true,
      supportedMoreActions: ["export-flattened", "export-editable", "toolbar-main", "toolbar-left", "toolbar-right"],
      callbacks: {
        onPreferencesChange: vi.fn(),
        onMore: vi.fn(),
        toolbarPlacement: () => placement
      },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    const more = toolbar.element.querySelector<HTMLButtonElement>("[data-control='more']")!;
    more.click();
    expect(document.querySelector("[data-option-id='export-flattened']")?.textContent).toBe("Export PDF (flattened)");
    expect(document.querySelector("[data-option-id='export-editable']")?.textContent).toBe("Export PDF (editable annotations)");
    expect(document.querySelector("[data-option-id='toolbar-main']")?.getAttribute("aria-checked")).toBe("true");
    more.click();

    placement = "left";
    more.click();
    expect(document.querySelector("[data-option-id='toolbar-main']")?.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector("[data-option-id='toolbar-left']")?.getAttribute("aria-checked")).toBe("true");
    more.click();

    placement = "right";
    more.click();
    expect(document.querySelector("[data-option-id='toolbar-left']")?.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector("[data-option-id='toolbar-right']")?.getAttribute("aria-checked")).toBe("true");
    toolbar.destroy();
  });

  it("persists selected drawing preference, updates icon, and exposes manual save only when needed", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    const changed = vi.fn();
    const save = vi.fn();
    const toolbar = new AnnotationToolbar({ preferences, autosave: false, callbacks: { onPreferencesChange: changed, onSave: save }, ownerDocument: document });
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
    expect(toolbar.saveStatus.element.querySelector(".native-pdf-handwriting-save-status-dot")).not.toBeNull();
    expect(toolbar.saveStatus.element.parentElement).toBe(toolbar.element);
    expect(toolbar.saveStatus.element.previousElementSibling?.classList.contains("native-pdf-handwriting-toolbar-controls")).toBe(true);
    toolbar.destroy();
  });

  it("opens Text formatting controls when Text is clicked again", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    const changed = vi.fn();
    document.body.style.setProperty("--font-interface", "Interface Font");
    document.body.style.setProperty("--font-text", "Reading Font");
    document.body.style.setProperty("--font-monospace", "Code Font");
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: {
        onPreferencesChange: changed,
        selectedTextFontSize: () => selectedSize
      },
      ownerDocument: document
    });
    let selectedSize: { fontSize: number; mixed: boolean } | undefined = { fontSize: 27.2, mixed: true };
    document.body.append(toolbar.element);
    const text = toolbar.element.querySelector<HTMLButtonElement>("[data-control='text']");
    text?.click();
    expect(preferences.activeTool).toBe("text");
    text?.click();
    const font = document.querySelector<HTMLSelectElement>(".native-pdf-handwriting-text-menu select");
    expect(font?.value).toBe("sans-serif");
    expect([...font!.options].map((option) => option.value)).toEqual(expect.arrayContaining(["Interface Font", "Reading Font", "Code Font", "sans-serif"]));
    expect([...document.querySelectorAll<HTMLButtonElement>(".native-pdf-handwriting-text-menu-button")].map((button) => button.dataset.optionId))
      .toEqual(["text-size-decrease", "text-size-increase", "text-bold", "text-italic"]);
    expect(document.querySelector<HTMLInputElement>(".native-pdf-handwriting-text-menu-size-input")?.value).toBe("27.2");
    expect(document.querySelector(".native-pdf-handwriting-text-menu-size")?.textContent).toBe("px+");
    selectedSize = { fontSize: 16, mixed: false };
    toolbar.refresh();
    expect(document.querySelector<HTMLInputElement>(".native-pdf-handwriting-text-menu-size-input")?.value).toBe("16");
    expect(document.querySelector(".native-pdf-handwriting-text-menu-size")?.textContent).toBe("px");
    expect(document.querySelector<HTMLButtonElement>("[data-option-id='text-italic']")?.classList.contains("native-pdf-handwriting-text-menu-button")).toBe(true);
    document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.click();
    expect(preferences.text.bold).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".native-pdf-handwriting-text-menu")).not.toBeNull();
    document.querySelector<HTMLButtonElement>("[data-option-id='text-size-increase']")?.click();
    expect(preferences.text.fontSize).toBe(28.2);
    expect(document.querySelector<HTMLInputElement>(".native-pdf-handwriting-text-menu-size-input")?.value).toBe("28.2");
    expect(document.querySelector(".native-pdf-handwriting-text-menu-size")?.textContent).toBe("px");
    document.querySelector<HTMLButtonElement>("[data-option-id='text-size-decrease']")?.click();
    expect(preferences.text.fontSize).toBe(27.2);
    expect(document.querySelector<HTMLInputElement>(".native-pdf-handwriting-text-menu-size-input")?.value).toBe("27.2");
    expect(document.querySelector(".native-pdf-handwriting-text-menu-size")?.textContent).toBe("px");
    const sizeInput = document.querySelector<HTMLInputElement>(".native-pdf-handwriting-text-menu-size-input")!;
    sizeInput.value = "18.46";
    sizeInput.dispatchEvent(new Event("change"));
    expect(preferences.text.fontSize).toBe(18.5);
    expect(sizeInput.value).toBe("18.5");
    expect(document.querySelector(".native-pdf-handwriting-text-menu")).not.toBeNull();
    expect(changed).toHaveBeenCalled();
    toolbar.destroy();
  });

  it("updates B/I pressed state when rich text formatting handles the action", () => {
    const toolbar = new AnnotationToolbar({
      preferences: structuredClone(DEFAULT_SETTINGS.toolPreferences),
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn(), onTextMarkdownFormat: () => true },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    const text = toolbar.element.querySelector<HTMLButtonElement>("[data-control='text']")!;
    text.click();
    text.click();
    const bold = document.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")!;
    bold.click();
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    bold.click();
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    toolbar.destroy();
  });

  it("selects Highlight from the drawing menu with independent options", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    preferences.pen.color = "#dc2626";
    preferences.pen.opacity = 0.8;
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    const controls = toolbar.element.querySelector(".native-pdf-handwriting-toolbar-controls");
    const buttons = [...(controls?.querySelectorAll<HTMLButtonElement>("button") ?? [])].map((button) => button.dataset.control);
    expect(buttons.slice(0, 4)).toEqual(["pan", "text", "color", "drawing"]);
    expect(toolbar.element.querySelector("[data-control='highlighter']")).toBeNull();

    toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    const toolOptions = [...document.querySelectorAll<HTMLButtonElement>("[data-option-id='pen'], [data-option-id='pencil'], [data-option-id='highlighter']")];
    expect(toolOptions.map((button) => button.textContent)).toEqual(["Pen", "Pencil", "Highlight"]);
    expect(toolOptions.every((button) => button.querySelector(".native-pdf-handwriting-toolbar-icon"))).toBe(true);
    expect(document.querySelector(".native-pdf-handwriting-drawing-menu-separator")).not.toBeNull();
    document.querySelector<HTMLButtonElement>("[data-option-id='highlighter']")?.click();
    expect(preferences.activeTool).toBe("highlighter");
    expect(preferences.highlighter).toMatchObject({ color: "#facc15", width: 4.5, opacity: 0.3 });
    expect(toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']")?.getAttribute("aria-label")).toBe("Highlight");
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    const highlighterWidths = [...document.querySelectorAll<HTMLButtonElement>("[data-option-id]")].map((button) => button.dataset.optionId);
    expect(highlighterWidths).toEqual(["pen", "pencil", "highlighter", "width-1.5", "width-3", "width-4.5", "width-7", "width-10", "width-14", "width-20"]);
    expect(document.querySelector(".native-pdf-handwriting-drawing-width-option .native-pdf-handwriting-width-preview")).not.toBeNull();
    document.querySelector<HTMLButtonElement>("[data-option-id='width-20']")?.click();
    expect(preferences.highlighter.width).toBe(20);
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    const opacity = document.querySelector<HTMLInputElement>(".native-pdf-handwriting-advanced input[type='range']");
    opacity!.value = "0.45";
    opacity!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(preferences.highlighter.opacity).toBe(0.45);
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='pen']")?.click();
    expect(preferences.activeTool).toBe("pen");
    expect(preferences.pen).toMatchObject({ color: "#dc2626", opacity: 0.8 });
    toolbar.destroy();
  });

  it("shows the active drawing color as the color button icon", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    preferences.pen.color = "#dc2626";
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    const color = toolbar.element.querySelector<HTMLButtonElement>("[data-control='color']");
    const swatch = color?.querySelector<HTMLElement>(".native-pdf-handwriting-color-icon");
    expect(swatch?.style.backgroundColor).toBe("rgb(220, 38, 38)");
    expect(color?.querySelector("svg")).toBeNull();
    toolbar.destroy();
  });

  it("keeps pen and highlighter colors separate and fixes the eraser swatch as transparent", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    preferences.pen.color = "#dc2626";
    const toolbar = new AnnotationToolbar({
      preferences,
      autosave: true,
      callbacks: { onPreferencesChange: vi.fn() },
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='highlighter']")?.click();
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='color']")?.click();
    const palette = ["#FFF59D", "#F8BBD0", "#B2DFDB", "#B3E5FC", "#D1C4E9"];
    expect([...document.querySelectorAll<HTMLButtonElement>("[data-option-id]")].map((button) => button.dataset.optionId)).toEqual(palette);
    document.querySelector<HTMLButtonElement>("[data-option-id='#B3E5FC']")?.click();
    expect(preferences.highlighter.color).toBe("#B3E5FC");
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    expect(preferences.pen.color).toBe("#dc2626");
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='highlighter']")?.click();
    expect(preferences.highlighter.color).toBe("#B3E5FC");

    toolbar.element.querySelector<HTMLButtonElement>("[data-control='eraser']")?.click();
    const color = toolbar.element.querySelector<HTMLButtonElement>("[data-control='color']");
    expect(color?.getAttribute("aria-label")).toBe("Transparent eraser");
    expect(color?.getAttribute("aria-disabled")).toBe("true");
    expect(color?.querySelector(".native-pdf-handwriting-color-icon.is-transparent")).not.toBeNull();
    color?.click();
    expect(document.querySelector(".native-pdf-handwriting-dropdown")).toBeNull();
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
      ownerDocument: document
    });
    document.body.append(toolbar.element);
    const eraser = toolbar.element.querySelector<HTMLButtonElement>("[data-control='eraser']");
    eraser?.click(); // select
    eraser?.click(); // open options when already selected
    const slider = document.querySelector<HTMLInputElement>(".native-pdf-handwriting-eraser-menu input[type='range']");
    const preview = document.querySelector<HTMLElement>(".native-pdf-handwriting-eraser-menu .native-pdf-handwriting-eraser-preview");
    const frame = document.querySelector<HTMLElement>(".native-pdf-handwriting-eraser-preview-frame");
    expect(slider).toMatchObject({ min: "4", max: "100", step: "1", value: "12" });
    expect(frame?.style.getPropertyValue("--ink-eraser-preview-frame-size")).toBe("100px");
    expect(preview?.style.getPropertyValue("--ink-eraser-preview-size")).toBe("12px");
    slider!.value = "20";
    slider!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(preferences.activeTool).toBe("eraser");
    expect(preferences.eraser).toEqual({ size: 20, eraseWholeStrokes: false, eraseWithRightMouseButton: false });
    expect(preview?.style.getPropertyValue("--ink-eraser-preview-size")).toBe("20px");
    expect(previewed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledOnce(); // first click activated eraser
    slider!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(changed).toHaveBeenCalledTimes(2);
    const wholeStroke = document.querySelector<HTMLInputElement>("[data-control='eraser-whole-stroke']");
    expect(wholeStroke).toMatchObject({ checked: false, type: "checkbox" });
    wholeStroke?.click();
    expect(preferences.eraser.eraseWholeStrokes).toBe(true);
    expect(changed).toHaveBeenCalledTimes(3);
    const rightMouse = document.querySelector<HTMLInputElement>("[data-control='eraser-right-mouse']");
    expect(rightMouse).toMatchObject({ checked: false, type: "checkbox" });
    rightMouse?.click();
    expect(preferences.eraser.eraseWithRightMouseButton).toBe(true);
    expect(changed).toHaveBeenCalledTimes(4);
    toolbar.destroy();
  });
});
