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
  it("persists selected drawing preference, updates icon, and exposes manual save only when needed", () => {
    const preferences = structuredClone(DEFAULT_SETTINGS.toolPreferences);
    const changed = vi.fn();
    const save = vi.fn();
    const toolbar = new AnnotationToolbar({ preferences, autosave: false, callbacks: { onPreferencesChange: changed, onSave: save }, document });
    document.body.append(toolbar.element);
    expect(toolbar.element.querySelector("[data-control='save']")).not.toBeNull();
    toolbar.element.querySelector<HTMLButtonElement>("[data-control='drawing-menu']")?.click();
    document.querySelector<HTMLButtonElement>("[data-option-id='pencil']")?.click();
    expect(preferences.activeTool).toBe("pencil");
    expect(toolbar.element.querySelector("[data-control='drawing']")?.textContent).toBe("Pencil");
    expect(changed).toHaveBeenCalled();
    toolbar.setAutosave(true);
    expect(toolbar.element.querySelector("[data-control='save']")).toBeNull();
    toolbar.setSaveStatus("failed");
    expect(toolbar.saveStatus.element.textContent).toBe("Save failed");
    toolbar.destroy();
  });
});
