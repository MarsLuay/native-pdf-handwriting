import type { DrawingTool, SaveStatus, ToolId, ToolPreferences } from "../model";
import { colorOptions } from "./ColorPicker";
import { DropdownController, type DropdownOpenOptions, type DropdownOption } from "./DropdownController";
import { drawingAdvanced, drawingOptions } from "./DrawingToolDropdown";
import { eraserOptions } from "./EraserDropdown";
import { lassoOptions } from "./LassoDropdown";
import { SaveStatusIndicator } from "./SaveStatusIndicator";

export type ZoomAction = "out" | "in" | "fit-width" | "fit-page" | "actual" | "reset";
export type MoreAction = "export" | "visibility" | "settings" | "autosave" | "debug" | "compatibility";

export interface AnnotationToolbarCallbacks {
  onPreferencesChange(preferences: ToolPreferences): void;
  onUndo?(): void;
  onRedo?(): void;
  onSave?(): void | Promise<void>;
  onZoom?(action: ZoomAction): void;
  onOutline?(): void;
  onMore?(action: MoreAction): void;
}

export interface AnnotationToolbarOptions {
  preferences: ToolPreferences;
  autosave: boolean;
  callbacks: AnnotationToolbarCallbacks;
  supportedMoreActions?: MoreAction[];
  document?: Document;
}

export class AnnotationToolbar {
  readonly element: HTMLElement;
  readonly dropdown: DropdownController;
  readonly saveStatus: SaveStatusIndicator;
  private readonly document: Document;
  private readonly callbacks: AnnotationToolbarCallbacks;
  private readonly preferences: ToolPreferences;
  private readonly abort = new AbortController();
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private lastDrawingTool: DrawingTool;
  private autosave: boolean;

  constructor(options: AnnotationToolbarOptions) {
    this.document = options.document ?? window.document;
    this.callbacks = options.callbacks;
    this.preferences = options.preferences;
    this.autosave = options.autosave;
    this.lastDrawingTool = options.preferences.activeTool === "pencil" ? "pencil" : "pen";
    this.dropdown = new DropdownController(this.document);
    this.saveStatus = new SaveStatusIndicator(this.document);
    this.element = this.document.createElement("div");
    this.element.className = "native-pdf-ink-toolbar";
    this.element.dataset.focusOverlayInternal = "true";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", "PDF annotation tools");

    this.element.append(this.groupedTool("drawing", () => this.drawingMenu()));
    this.element.append(this.groupedTool("eraser", () => ({ label: "Eraser options", options: this.eraserMenu() })));
    this.element.append(this.colorButton());
    this.element.append(this.groupedTool("lasso", () => ({ label: "Lasso options", options: this.lassoMenu() })));
    this.element.append(this.actionButton("undo", "Undo", () => this.callbacks.onUndo?.(), !this.callbacks.onUndo));
    this.element.append(this.actionButton("redo", "Redo", () => this.callbacks.onRedo?.(), !this.callbacks.onRedo));
    if (this.callbacks.onZoom) this.element.append(this.menuButton("zoom", "Zoom", this.zoomMenu()));
    if (this.callbacks.onOutline) this.element.append(this.actionButton("outline", "Outline", () => this.callbacks.onOutline?.()));
    const supportedMore = options.supportedMoreActions ?? [];
    if (this.callbacks.onMore && supportedMore.length > 0) this.element.append(this.menuButton("more", "More", this.moreMenu(supportedMore)));
    this.element.append(this.saveStatus.element);
    if (!this.autosave && this.callbacks.onSave) this.element.append(this.actionButton("save", "Save", () => void this.callbacks.onSave?.()));
    this.updateButtons();
  }

  setAutosave(enabled: boolean): void {
    this.autosave = enabled;
    const existing = this.buttons.get("save");
    if (enabled) {
      existing?.remove();
      this.buttons.delete("save");
    } else if (!existing && this.callbacks.onSave) {
      this.element.append(this.actionButton("save", "Save", () => void this.callbacks.onSave?.()));
    }
  }

  setSaveStatus(status: SaveStatus, lastSavedAt?: Date): void {
    this.saveStatus.update(status, lastSavedAt);
  }

  destroy(): void {
    this.abort.abort();
    this.dropdown.destroy();
    this.element.remove();
  }

  private groupedTool(id: "drawing" | "eraser" | "lasso", menu: () => DropdownOpenOptions): HTMLElement {
    const group = this.document.createElement("div");
    group.className = "native-pdf-ink-tool-group";
    const main = this.actionButton(id, id, () => {
      const active = id === "drawing"
        ? this.preferences.activeTool === "pen" || this.preferences.activeTool === "pencil"
        : this.preferences.activeTool === id;
      if (active) this.dropdown.toggle(id, main, menu());
      else this.activate(id === "drawing" ? this.lastDrawingTool : id);
    });
    main.setAttribute("aria-haspopup", "menu");
    main.setAttribute("aria-expanded", "false");
    const arrow = this.actionButton(`${id}-menu`, "▾", () => this.dropdown.toggle(id, main, menu()));
    arrow.classList.add("native-pdf-ink-menu-arrow");
    arrow.setAttribute("aria-label", `${id} options`);
    group.append(main, arrow);
    return group;
  }

  private actionButton(id: string, label: string, action: () => void, disabled = false): HTMLButtonElement {
    const button = this.document.createElement("button");
    button.type = "button";
    button.className = "native-pdf-ink-toolbar-button";
    button.dataset.control = id;
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", action, { signal: this.abort.signal });
    this.buttons.set(id, button);
    return button;
  }

  private menuButton(id: string, label: string, options: DropdownOption[]): HTMLButtonElement {
    const button = this.actionButton(id, label, () => this.dropdown.toggle(id, button, { label: `${label} options`, options }));
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    return button;
  }

  private drawingMenu(): DropdownOpenOptions {
    const content = this.document.createElement("div");
    for (const option of drawingOptions(this.preferences, (tool) => {
      this.preferences.activeTool = tool;
      this.lastDrawingTool = tool;
      this.changed();
    }, (width) => {
      this.preferences[this.lastDrawingTool].width = width;
      this.preferences.activeTool = this.lastDrawingTool;
      this.changed();
    })) content.append(this.inlineOption(option));
    content.append(drawingAdvanced(this.document, this.preferences, () => this.changed(), this.abort.signal));
    return { label: "Drawing options", content };
  }

  private eraserMenu(): DropdownOption[] {
    return eraserOptions(this.preferences, (type, size) => {
      this.preferences.activeTool = "eraser";
      this.preferences.eraser.type = type;
      if (size !== undefined) this.preferences.eraser.size = size;
      this.changed();
    });
  }

  private lassoMenu(): DropdownOption[] {
    return lassoOptions(this.preferences, (type) => {
      this.preferences.activeTool = "lasso";
      this.preferences.lasso.type = type;
      this.changed();
    }, (mode) => {
      this.preferences.activeTool = "lasso";
      this.preferences.lasso.selectionMode = mode;
      this.changed();
    });
  }

  private colorButton(): HTMLButtonElement {
    const button = this.actionButton("color", "Color", () => this.dropdown.toggle("color", button, { label: "Color options", content: this.colorMenu() }));
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    return button;
  }

  private colorMenu(): HTMLElement {
    const content = this.document.createElement("div");
    const drawingTool = this.preferences.activeTool === "pencil" ? "pencil" : "pen";
    for (const option of colorOptions(this.preferences, (color) => {
      this.preferences[drawingTool].color = color;
      this.changed();
    })) content.append(this.inlineOption(option));
    const colorLabel = this.document.createElement("label");
    colorLabel.textContent = "Custom color";
    const colorInput = this.document.createElement("input");
    colorInput.type = "color";
    colorInput.value = this.preferences[drawingTool].color;
    colorInput.addEventListener("input", () => {
      this.preferences[drawingTool].color = colorInput.value;
      this.changed();
    }, { signal: this.abort.signal });
    colorLabel.append(colorInput);
    const opacityLabel = this.document.createElement("label");
    opacityLabel.textContent = "Opacity";
    const opacity = this.document.createElement("input");
    opacity.type = "range";
    opacity.min = "0.1";
    opacity.max = "1";
    opacity.step = "0.05";
    opacity.value = String(this.preferences[drawingTool].opacity);
    opacity.addEventListener("input", () => {
      this.preferences[drawingTool].opacity = Number(opacity.value);
      this.changed();
    }, { signal: this.abort.signal });
    opacityLabel.append(opacity);
    content.append(colorLabel, opacityLabel);
    return content;
  }

  private zoomMenu(): DropdownOption[] {
    const labels: Array<[ZoomAction, string]> = [
      ["out", "Zoom out"], ["in", "Zoom in"], ["fit-width", "Fit width"],
      ["fit-page", "Fit page"], ["actual", "Actual size"], ["reset", "Reset zoom"]
    ];
    return labels.map(([id, label]) => ({ id, label, onSelect: () => this.callbacks.onZoom?.(id) }));
  }

  private moreMenu(supported: MoreAction[]): DropdownOption[] {
    const labels: Record<MoreAction, string> = {
      export: "Export PDF", visibility: "Toggle annotation visibility", settings: "Annotation settings",
      autosave: "Autosave settings", debug: "Debug information", compatibility: "Compatibility information"
    };
    return supported.map((id) => ({ id, label: labels[id], onSelect: () => this.callbacks.onMore?.(id) }));
  }

  private inlineOption(option: DropdownOption): HTMLButtonElement {
    const button = this.document.createElement("button");
    button.type = "button";
    button.className = "native-pdf-ink-dropdown-option";
    button.dataset.optionId = option.id;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(option.active ?? false));
    button.disabled = option.disabled ?? false;
    button.textContent = option.label;
    option.render?.(button);
    button.addEventListener("click", () => {
      option.onSelect();
      this.dropdown.close(true);
    }, { signal: this.abort.signal });
    return button;
  }

  private activate(tool: ToolId): void {
    this.preferences.activeTool = tool;
    if (tool === "pen" || tool === "pencil") this.lastDrawingTool = tool;
    this.changed();
  }

  private changed(): void {
    this.updateButtons();
    this.callbacks.onPreferencesChange(this.preferences);
  }

  private updateButtons(): void {
    const active = this.preferences.activeTool;
    this.buttons.get("drawing")!.textContent = this.lastDrawingTool === "pen" ? "Pen" : "Pencil";
    this.buttons.get("eraser")!.textContent = "Eraser";
    this.buttons.get("lasso")!.textContent = this.preferences.lasso.type === "freeform" ? "Lasso" : this.preferences.lasso.type === "ellipse" ? "Ellipse" : "Rectangle";
    this.buttons.get("drawing")!.setAttribute("aria-pressed", String(active === "pen" || active === "pencil"));
    this.buttons.get("eraser")!.setAttribute("aria-pressed", String(active === "eraser"));
    this.buttons.get("lasso")!.setAttribute("aria-pressed", String(active === "lasso"));
    const drawing = this.preferences[active === "pencil" ? "pencil" : "pen"];
    const color = this.buttons.get("color");
    if (color) {
      color.style.setProperty("--ink-current-color", drawing.color);
      color.setAttribute("aria-label", `Color ${drawing.color}`);
    }
  }
}
