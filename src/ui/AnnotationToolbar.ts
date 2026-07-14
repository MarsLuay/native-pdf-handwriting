import type { DrawingTool, SaveStatus, ToolId, ToolPreferences } from "../model";
import { isDrawingTool, resolveDrawingTool } from "../model";
import { colorOptions } from "./ColorPicker";
import { DropdownController, type DropdownOpenOptions, type DropdownOption } from "./DropdownController";
import { drawingAdvanced, drawingOptions } from "./DrawingToolDropdown";
import { eraserMenu } from "./EraserDropdown";
import { laserMenu } from "./LaserDropdown";
import { lassoOptions } from "./LassoDropdown";
import { SaveStatusIndicator } from "./SaveStatusIndicator";
import { setToolbarColorSwatch, setToolbarIcon, type ToolbarIcon } from "./ToolbarIcon";

const DRAWING_LABELS: Record<DrawingTool, string> = {
  pen: "Pen",
  pencil: "Pencil",
  highlighter: "Highlighter"
};

export type MoreAction =
  | "export"
  | "toolbar-main"
  | "toolbar-left"
  | "toolbar-right";

export interface AnnotationToolbarCallbacks {
  onPreferencesChange(preferences: ToolPreferences): void;
  onEraserSizePreview?(size: number): void;
  onDrawModeChange?(enabled: boolean): void;
  onUndo?(): void;
  onRedo?(): void;
  onSave?(): void | Promise<void>;
  onMore?(action: MoreAction): void;
  toolbarPlacement?(): "main" | "left" | "right";
}

export interface AnnotationToolbarOptions {
  preferences: ToolPreferences;
  autosave: boolean;
  drawEnabled?: boolean;
  callbacks: AnnotationToolbarCallbacks;
  supportedMoreActions?: MoreAction[];
  ownerDocument?: Document;
}

export class AnnotationToolbar {
  readonly element: HTMLElement;
  readonly dropdown: DropdownController;
  readonly saveStatus: SaveStatusIndicator;
  private readonly ownerDocument: Document;
  private readonly callbacks: AnnotationToolbarCallbacks;
  private readonly preferences: ToolPreferences;
  private readonly abort = new AbortController();
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly controls: HTMLElement;
  private lastDrawingTool: DrawingTool;
  private autosave: boolean;

  constructor(options: AnnotationToolbarOptions) {
    this.ownerDocument = options.ownerDocument ?? activeDocument;
    this.callbacks = options.callbacks;
    this.preferences = options.preferences;
    this.autosave = options.autosave;
    this.lastDrawingTool = resolveDrawingTool(options.preferences.activeTool);
    this.dropdown = new DropdownController(this.ownerDocument);
    this.saveStatus = new SaveStatusIndicator(this.ownerDocument);
    this.element = this.ownerDocument.createElement("div");
    this.element.className = "native-pdf-handwriting-toolbar";
    this.element.dataset.focusOverlayInternal = "true";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", "PDF annotation tools");
    this.controls = this.ownerDocument.createElement("div");
    this.controls.className = "native-pdf-handwriting-toolbar-controls";

    this.controls.append(this.drawToggle(options.drawEnabled ?? false));
    this.controls.append(this.colorButton());
    this.controls.append(this.groupedTool("drawing", () => this.drawingMenu()));
    this.controls.append(this.groupedTool("eraser", () => this.eraserMenuOptions()));
    this.controls.append(this.groupedTool("laser", () => this.laserMenuOptions()));
    this.controls.append(this.groupedTool("lasso", () => ({ label: "Lasso options", options: this.lassoMenu() })));
    this.controls.append(this.actionButton("undo", "Undo", () => this.callbacks.onUndo?.(), !this.callbacks.onUndo));
    this.controls.append(this.actionButton("redo", "Redo", () => this.callbacks.onRedo?.(), !this.callbacks.onRedo));
    const supportedMore = options.supportedMoreActions ?? [];
    if (this.callbacks.onMore && supportedMore.length > 0) this.controls.append(this.menuButton("more", "More", this.moreMenu(supportedMore)));
    if (!this.autosave && this.callbacks.onSave) this.controls.append(this.actionButton("save", "Save", () => void this.callbacks.onSave?.()));
    this.element.append(this.controls, this.saveStatus.element);
    this.updateButtons();
  }

  setAutosave(enabled: boolean): void {
    this.autosave = enabled;
    const existing = this.buttons.get("save");
    if (enabled) {
      existing?.remove();
      this.buttons.delete("save");
    } else if (!existing && this.callbacks.onSave) {
      this.controls.append(this.actionButton("save", "Save", () => void this.callbacks.onSave?.()));
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

  private groupedTool(id: "drawing" | "eraser" | "lasso" | "laser", menu: () => DropdownOpenOptions): HTMLButtonElement {
    const main = this.actionButton(id, id, () => {
      const active = id === "drawing"
        ? isDrawingTool(this.preferences.activeTool)
        : this.preferences.activeTool === id;
      if (active) this.dropdown.toggle(id, main, menu());
      else this.activate(id === "drawing" ? this.lastDrawingTool : id);
    });
    main.setAttribute("aria-haspopup", "menu");
    main.setAttribute("aria-expanded", "false");
    return main;
  }

  private actionButton(id: string, label: string, action: () => void, disabled = false): HTMLButtonElement {
    const button = this.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "native-pdf-handwriting-toolbar-button clickable-icon";
    button.dataset.control = id;
    this.presentButton(button, label, this.iconFor(id));
    button.disabled = disabled;
    button.addEventListener("click", action, { signal: this.abort.signal });
    this.buttons.set(id, button);
    return button;
  }

  private drawToggle(enabled: boolean): HTMLLabelElement {
    const label = this.ownerDocument.createElement("label");
    label.className = "native-pdf-handwriting-draw-toggle";
    label.setAttribute("aria-label", "Turn on to draw, erase, or select annotations. Leave off for normal PDF controls.");
    label.removeAttribute("title");
    const input = this.ownerDocument.createElement("input");
    input.type = "checkbox";
    input.checked = enabled;
    input.dataset.control = "draw";
    input.addEventListener("change", () => {
      label.dataset.enabled = String(input.checked);
      this.callbacks.onDrawModeChange?.(input.checked);
    }, { signal: this.abort.signal });
    label.dataset.enabled = String(enabled);
    const text = this.ownerDocument.createElement("span");
    text.className = "native-pdf-handwriting-draw-toggle-label";
    text.textContent = "Draw";
    label.append(input, text);
    return label;
  }

  private presentButton(button: HTMLButtonElement, label: string, icon: ToolbarIcon): void {
    button.setAttribute("aria-label", label);
    // No native title — Obsidian already tooltips clickable-icon from aria-label (double bubble otherwise).
    button.removeAttribute("title");
    setToolbarIcon(button, icon);
  }

  private iconFor(id: string): ToolbarIcon {
    if (id === "drawing") return this.lastDrawingTool;
    switch (id) {
      case "eraser":
      case "lasso":
      case "laser":
      case "undo":
      case "redo":
      case "more":
      case "save":
        return id;
      default:
        return "more";
    }
  }

  private menuButton(id: string, label: string, options: DropdownOption[]): HTMLButtonElement {
    const button = this.actionButton(id, label, () => this.dropdown.toggle(id, button, { label: `${label} options`, options }));
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    return button;
  }

  private drawingMenu(): DropdownOpenOptions {
    const content = this.ownerDocument.createElement("div");
    for (const option of drawingOptions(this.preferences, (tool) => {
      this.preferences.activeTool = tool;
      this.lastDrawingTool = tool;
      this.changed();
    }, (width) => {
      this.preferences[this.lastDrawingTool].width = width;
      this.preferences.activeTool = this.lastDrawingTool;
      this.changed();
    })) content.append(this.inlineOption(option));
    content.append(drawingAdvanced(this.ownerDocument, this.preferences, () => this.changed(), this.abort.signal));
    return { label: "Drawing options", content };
  }

  private laserMenuOptions(): DropdownOpenOptions {
    return {
      label: "Laser options",
      content: laserMenu(this.ownerDocument, this.preferences, () => this.changed(), this.abort.signal)
    };
  }

  private eraserMenuOptions(): DropdownOpenOptions {
    return {
      label: "Eraser options",
      content: eraserMenu(this.ownerDocument, this.preferences, {
        onPreview: (size) => {
          this.preferences.activeTool = "eraser";
          this.preferences.eraser.size = size;
          this.callbacks.onEraserSizePreview?.(size);
        },
        onCommit: (size) => {
          this.preferences.activeTool = "eraser";
          this.preferences.eraser.size = size;
          this.changed();
        }
      }, this.abort.signal)
    };
  }

  private lassoMenu(): DropdownOption[] {
    return lassoOptions(this.preferences, (type) => {
      this.preferences.activeTool = "lasso";
      this.preferences.lasso.type = type;
      this.changed();
    });
  }

  private colorButton(): HTMLButtonElement {
    const button = this.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "native-pdf-handwriting-toolbar-button clickable-icon";
    button.dataset.control = "color";
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => this.dropdown.toggle("color", button, { label: "Color options", content: this.colorMenu() }), { signal: this.abort.signal });
    this.buttons.set("color", button);
    return button;
  }

  private colorMenu(): HTMLElement {
    const content = this.ownerDocument.createElement("div");
    const laserActive = this.preferences.activeTool === "laser";
    const drawingTool = resolveDrawingTool(this.preferences.activeTool);
    const applyColor = (color: string): void => {
      if (laserActive) this.preferences.laser.color = color;
      else this.preferences[drawingTool].color = color;
      this.changed();
    };
    for (const option of colorOptions(this.preferences, applyColor)) content.append(this.inlineOption(option));
    const colorLabel = this.ownerDocument.createElement("label");
    colorLabel.textContent = "Custom color";
    const colorInput = this.ownerDocument.createElement("input");
    colorInput.type = "color";
    colorInput.value = laserActive ? this.preferences.laser.color : this.preferences[drawingTool].color;
    colorInput.addEventListener("input", () => applyColor(colorInput.value), { signal: this.abort.signal });
    colorLabel.append(colorInput);
    content.append(colorLabel);
    if (!laserActive) {
      const opacityLabel = this.ownerDocument.createElement("label");
      opacityLabel.textContent = "Opacity";
      const opacity = this.ownerDocument.createElement("input");
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
      content.append(opacityLabel);
    }
    return content;
  }

  private moreMenu(supported: MoreAction[]): DropdownOption[] {
    const labels: Record<MoreAction, string> = {
      export: "Export PDF",
      "toolbar-main": "Toolbar: PDF bar",
      "toolbar-left": "Toolbar: Left sidebar",
      "toolbar-right": "Toolbar: Right sidebar"
    };
    return supported.map((id) => ({
      id,
      label: labels[id],
      active: id === `toolbar-${this.callbacks.toolbarPlacement?.() ?? "main"}`,
      onSelect: () => this.callbacks.onMore?.(id)
    }));
  }

  private inlineOption(option: DropdownOption): HTMLButtonElement {
    const button = this.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "native-pdf-handwriting-dropdown-option";
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
    if (isDrawingTool(tool)) this.lastDrawingTool = tool;
    this.changed();
  }

  private changed(): void {
    this.updateButtons();
    this.callbacks.onPreferencesChange(this.preferences);
  }

  private updateButtons(): void {
    const active = this.preferences.activeTool;
    this.presentButton(
      this.buttons.get("drawing")!,
      DRAWING_LABELS[this.lastDrawingTool],
      this.lastDrawingTool
    );
    this.presentButton(this.buttons.get("eraser")!, "Eraser", "eraser");
    this.presentButton(this.buttons.get("laser")!, "Laser pointer", "laser");
    this.presentButton(this.buttons.get("lasso")!, this.preferences.lasso.type === "freeform" ? "Lasso" : "Rectangle", "lasso");
    this.buttons.get("drawing")!.setAttribute("aria-pressed", String(isDrawingTool(active)));
    this.buttons.get("eraser")!.setAttribute("aria-pressed", String(active === "eraser"));
    this.buttons.get("laser")!.setAttribute("aria-pressed", String(active === "laser"));
    this.buttons.get("lasso")!.setAttribute("aria-pressed", String(active === "lasso"));
    const colorValue = active === "laser"
      ? this.preferences.laser.color
      : this.preferences[resolveDrawingTool(active)].color;
    const color = this.buttons.get("color");
    if (color) {
      color.setAttribute("aria-label", `Color ${colorValue}`);
      color.removeAttribute("title");
      setToolbarColorSwatch(color, colorValue);
    }
  }
}
