import type { DrawingTool, SaveStatus, TextStyle, ToolId, ToolPreferences } from "../model";
import { isDrawingTool, resolveDrawingTool } from "../model";
import { colorOptions } from "./ColorPicker";
import { DropdownController, type DropdownOpenOptions, type DropdownOption } from "./DropdownController";
import { drawingAdvanced, drawingOptions } from "./DrawingToolDropdown";
import { eraserMenu } from "./EraserDropdown";
import { laserMenu } from "./LaserDropdown";
import { lassoOptions } from "./LassoDropdown";
import { SaveStatusIndicator } from "./SaveStatusIndicator";
import { textMenu, type TextStyleChange } from "./TextDropdown";
import { setToolbarColorSwatch, setToolbarIcon, type ToolbarIcon } from "./ToolbarIcon";

const DRAWING_LABELS: Record<DrawingTool, string> = {
  pen: "Pen",
  pencil: "Pencil",
  highlighter: "Highlighter"
};

export type MoreAction =
  | "export"
  | "export-editable"
  | "toolbar-main"
  | "toolbar-left"
  | "toolbar-right";

/** Identifies whether a preference change also needs a whole-session redraw. */
export type PreferenceChangeReason = "general" | "text-style";

export interface AnnotationToolbarCallbacks {
  onPreferencesChange(preferences: ToolPreferences, reason?: PreferenceChangeReason): void;
  onEraserSizePreview?(size: number): void;
  onTextStyleChange?(change: TextStyleChange): void;
  /** Runs before the toolbar takes focus, preserving a contenteditable range. */
  onTextFormatPointerDown?(): void;
  activeTextStyle?(): TextStyle | undefined;
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
    this.element = this.ownerDocument.createDiv();
    this.element.className = "native-pdf-handwriting-toolbar";
    this.element.dataset.focusOverlayInternal = "true";
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", "PDF annotation tools");
    this.controls = this.ownerDocument.createDiv();
    this.controls.className = "native-pdf-handwriting-toolbar-controls";

    this.controls.append(this.drawToggle(options.drawEnabled ?? false));
    this.controls.append(this.colorButton());
    this.controls.append(this.groupedTool("drawing", () => this.drawingMenu()));
    this.controls.append(this.groupedTool("eraser", () => this.eraserMenuOptions()));
    this.controls.append(this.groupedTool("laser", () => this.laserMenuOptions()));
    this.controls.append(this.groupedTool("lasso", () => ({ label: "Lasso options", options: this.lassoMenu() })));
    this.controls.append(this.groupedTool("text", () => this.textMenuOptions()));
    this.controls.append(this.actionButton("undo", "Undo", () => this.callbacks.onUndo?.(), !this.callbacks.onUndo));
    this.controls.append(this.actionButton("redo", "Redo", () => this.callbacks.onRedo?.(), !this.callbacks.onRedo));
    const supportedMore = options.supportedMoreActions ?? [];
    if (this.callbacks.onMore && supportedMore.length > 0) this.controls.append(this.menuButton("more", "More", () => this.moreMenu(supportedMore)));
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

  private groupedTool(id: "drawing" | "text" | "eraser" | "lasso" | "laser", menu: () => DropdownOpenOptions): HTMLButtonElement {
    const main = this.actionButton(id, id, () => {
      const active = id === "drawing"
        ? isDrawingTool(this.preferences.activeTool)
        : this.preferences.activeTool === id;
      if (active) this.dropdown.toggle(id, main, menu());
      else this.activate(id === "drawing" ? this.lastDrawingTool : id);
    });
    if (id === "text") {
      main.addEventListener("pointerdown", () => this.callbacks.onTextFormatPointerDown?.(), { signal: this.abort.signal });
    }
    main.setAttribute("aria-haspopup", "menu");
    main.setAttribute("aria-expanded", "false");
    return main;
  }

  private actionButton(id: string, label: string, action: () => void, disabled = false): HTMLButtonElement {
    const button = this.ownerDocument.createEl('button');
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
    const label = this.ownerDocument.createEl('label');
    label.className = "native-pdf-handwriting-draw-toggle";
    label.setAttribute("aria-label", "Turn on to draw, erase, or select annotations. Leave off for normal PDF controls.");
    label.removeAttribute("title");
    const input = this.ownerDocument.createEl('input');
    input.type = "checkbox";
    input.checked = enabled;
    input.dataset.control = "draw";
    input.addEventListener("change", () => {
      label.dataset.enabled = String(input.checked);
      this.callbacks.onDrawModeChange?.(input.checked);
    }, { signal: this.abort.signal });
    label.dataset.enabled = String(enabled);
    const text = this.ownerDocument.createSpan();
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
      case "text":
      case "undo":
      case "redo":
      case "more":
      case "save":
        return id;
      default:
        return "more";
    }
  }

  private menuButton(id: string, label: string, options: () => DropdownOption[]): HTMLButtonElement {
    const button = this.actionButton(id, label, () => this.dropdown.toggle(id, button, { label: `${label} options`, options: options() }));
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    return button;
  }

  private drawingMenu(): DropdownOpenOptions {
    const content = this.ownerDocument.createDiv();
    const options = drawingOptions(this.preferences, (tool) => {
      this.preferences.activeTool = tool;
      this.lastDrawingTool = tool;
      this.changed();
    }, (width) => {
      this.preferences[this.lastDrawingTool].width = width;
      this.preferences.activeTool = this.lastDrawingTool;
      this.changed();
    });
    const tools = options.filter((option) => !option.id.startsWith("width-"));
    const widths = options.filter((option) => option.id.startsWith("width-"));
    for (const option of tools) content.append(this.inlineOption(option));
    for (const option of widths) content.append(this.inlineOption(option));
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
        },
        onWholeStrokeChange: (enabled) => {
          this.preferences.eraser.eraseWholeStrokes = enabled;
          this.changed();
        },
        onRightMouseButtonChange: (enabled) => {
          this.preferences.eraser.eraseWithRightMouseButton = enabled;
          this.changed();
        }
      }, this.abort.signal)
    };
  }

  private textMenuOptions(): DropdownOpenOptions {
    // An existing text box has its own persisted style. Show that style in the
    // menu so changing one property does not visually imply the defaults apply.
    const style = { ...(this.callbacks.activeTextStyle?.() ?? this.preferences.text) };
    return {
      label: "Text options",
      content: textMenu(this.ownerDocument, style, (change) => {
        this.applyTextPreference(change);
        this.callbacks.onTextStyleChange?.(change);
        // Active and selected text receive their own focused render before
        // this callback. Do not follow it with a second full-page refresh.
        this.changed("text-style");
      }, this.abort.signal, () => this.callbacks.onTextFormatPointerDown?.())
    };
  }

  private applyTextPreference(change: TextStyleChange): void {
    switch (change.property) {
      case "fontFamily": this.preferences.text.fontFamily = change.value as string; return;
      case "color": this.preferences.text.color = change.value as string; return;
      case "fontSize": this.preferences.text.fontSize = change.value as number; return;
      case "bold": this.preferences.text.bold = change.value as boolean; return;
      case "italic": this.preferences.text.italic = change.value as boolean; return;
      case "strikethrough": this.preferences.text.strikethrough = change.value as boolean; return;
    }
  }

  private lassoMenu(): DropdownOption[] {
    return lassoOptions(this.preferences, (type) => {
      this.preferences.activeTool = "lasso";
      this.preferences.lasso.type = type;
      this.changed();
    });
  }

  private colorButton(): HTMLButtonElement {
    const button = this.ownerDocument.createEl('button');
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
    const content = this.ownerDocument.createDiv();
    const laserActive = this.preferences.activeTool === "laser";
    const textActive = this.preferences.activeTool === "text";
    const drawingTool = resolveDrawingTool(this.preferences.activeTool);
    const applyColor = (color: string): void => {
      if (laserActive) this.preferences.laser.color = color;
      else if (textActive) this.preferences.text.color = color;
      else this.preferences[drawingTool].color = color;
      this.changed();
    };
    for (const option of colorOptions(this.preferences, applyColor)) content.append(this.inlineOption(option));
    const colorLabel = this.ownerDocument.createEl('label');
    colorLabel.textContent = "Custom color";
    const colorInput = this.ownerDocument.createEl('input');
    colorInput.type = "color";
    colorInput.value = laserActive ? this.preferences.laser.color : textActive ? this.preferences.text.color : this.preferences[drawingTool].color;
    colorInput.addEventListener("input", () => applyColor(colorInput.value), { signal: this.abort.signal });
    colorLabel.append(colorInput);
    content.append(colorLabel);
    if (!laserActive && !textActive) {
      const opacityLabel = this.ownerDocument.createEl('label');
      opacityLabel.textContent = "Opacity";
      const opacity = this.ownerDocument.createEl('input');
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
      "export-editable": "Export editable PDF annotations",
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
    const button = this.ownerDocument.createEl('button');
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

  private changed(reason: PreferenceChangeReason = "general"): void {
    this.updateButtons();
    this.callbacks.onPreferencesChange(this.preferences, reason);
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
    this.presentButton(this.buttons.get("text")!, "Text", "text");
    this.buttons.get("drawing")!.setAttribute("aria-pressed", String(isDrawingTool(active)));
    this.buttons.get("eraser")!.setAttribute("aria-pressed", String(active === "eraser"));
    this.buttons.get("laser")!.setAttribute("aria-pressed", String(active === "laser"));
    this.buttons.get("lasso")!.setAttribute("aria-pressed", String(active === "lasso"));
    this.buttons.get("text")!.setAttribute("aria-pressed", String(active === "text"));
    const colorValue = active === "laser"
      ? this.preferences.laser.color
      : active === "text"
        ? this.preferences.text.color
      : this.preferences[resolveDrawingTool(active)].color;
    const color = this.buttons.get("color");
    if (color) {
      color.setAttribute("aria-label", `Color ${colorValue}`);
      color.removeAttribute("title");
      setToolbarColorSwatch(color, colorValue);
    }
  }
}
