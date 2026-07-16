import { isDrawingTool, resolveDrawingTool, type DrawingTool, type SaveStatus, type TextStyle, type ToolId, type ToolPreferences } from "../model";
import { colorOptions } from "./ColorPicker";
import { DropdownController, type DropdownOpenOptions, type DropdownOption } from "./DropdownController";
import { drawingAdvanced, drawingOptions } from "./DrawingToolDropdown";
import { eraserMenu } from "./EraserDropdown";
import { laserMenu } from "./LaserDropdown";
import { lassoOptions } from "./LassoDropdown";
import { SaveStatusIndicator } from "./SaveStatusIndicator";
import { setToolbarColorSwatch, setToolbarIcon, type ToolbarIcon } from "./ToolbarIcon";

export type MoreAction =
  | "export-flattened"
  | "export-editable"
  | "toolbar-main"
  | "toolbar-left"
  | "toolbar-right";

export interface AnnotationToolbarCallbacks {
  onPreferencesChange(preferences: ToolPreferences): void;
  onTextStyleChange?(patch: Partial<TextStyle>): boolean;
  onTextMarkdownFormat?(format: "bold" | "italic"): boolean;
  selectedTextFontSize?(): { fontSize: number; mixed: boolean } | undefined;
  selectedTextColor?(): string | undefined;
  onSelectionColorChange?(color: string): boolean;
  onSelectionWidthChange?(width: number): boolean;
  hasActiveTextInput?(): boolean;
  hasSelectedText?(): boolean;
  onTextMenuOpen?(): void;
  onTextEditorInteractionStart?(): void;
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
  private drawEnabled: boolean;

  constructor(options: AnnotationToolbarOptions) {
    this.ownerDocument = options.ownerDocument ?? activeDocument;
    this.callbacks = options.callbacks;
    this.preferences = options.preferences;
    this.autosave = options.autosave;
    this.drawEnabled = options.drawEnabled ?? true;
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

    this.controls.append(this.actionButton("pan", "Pan", () => this.setDrawEnabled(false)));
    this.controls.append(this.groupedTool("text", () => this.textMenu()));
    this.controls.append(this.colorButton());
    this.controls.append(this.groupedTool("drawing", () => this.drawingMenu()));
    this.controls.append(this.groupedTool("eraser", () => this.eraserMenuOptions()));
    this.controls.append(this.groupedTool("laser", () => this.laserMenuOptions()));
    this.controls.append(this.groupedTool("lasso", () => ({ label: "Lasso options", options: this.lassoMenu() })));
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

  selectEraser(): void {
    this.preferences.activeTool = "eraser";
    this.setDrawEnabled(true);
    this.updateButtons();
  }

  restoreLastDrawingTool(): void {
    this.preferences.activeTool = this.lastDrawingTool;
    this.setDrawEnabled(true);
    this.updateButtons();
  }

  setSaveStatus(status: SaveStatus, lastSavedAt?: Date): void {
    this.saveStatus.update(status, lastSavedAt);
  }

  refresh(): void {
    this.updateButtons();
    this.updateTextMenuSize();
  }

  destroy(): void {
    this.abort.abort();
    this.dropdown.destroy();
    this.element.remove();
  }

  private groupedTool(id: "drawing" | "text" | "eraser" | "laser" | "lasso", menu: () => DropdownOpenOptions): HTMLButtonElement {
    const main = this.actionButton(id, id, () => {
      if (id === "text" && this.callbacks.hasActiveTextInput?.()) {
        this.dropdown.toggle(id, main, menu());
        return;
      }
      if (id === "text" && this.callbacks.hasSelectedText?.()) {
        this.dropdown.toggle(id, main, menu());
        return;
      }
      if (!this.drawEnabled) {
        this.activate(id === "drawing" ? this.lastDrawingTool : id);
        return;
      }
      const active = id === "drawing"
        ? isDrawingTool(this.preferences.activeTool)
        : this.preferences.activeTool === id;
      if (active) {
        if (id === "text" && !this.callbacks.hasActiveTextInput?.()) this.callbacks.onTextMenuOpen?.();
        this.dropdown.toggle(id, main, menu());
      }
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
    if (id === "text") this.preserveTextEditorSelection(button);
    button.addEventListener("click", action, { signal: this.abort.signal });
    this.buttons.set(id, button);
    return button;
  }

  private presentButton(button: HTMLButtonElement, label: string, icon: ToolbarIcon): void {
    button.setAttribute("aria-label", label);
    // No native title — Obsidian already tooltips clickable-icon from aria-label (double bubble otherwise).
    button.removeAttribute("title");
    setToolbarIcon(button, icon);
  }

  private preserveTextEditorSelection(element: HTMLElement): void {
    element.addEventListener("pointerdown", (event) => {
      if (!this.callbacks.hasActiveTextInput?.()) return;
      this.callbacks.onTextEditorInteractionStart?.();
      if (event.target instanceof HTMLButtonElement) event.preventDefault();
    }, { capture: true, signal: this.abort.signal });
  }

  private iconFor(id: string): ToolbarIcon {
    if (id === "drawing") return this.lastDrawingTool;
    switch (id) {
      case "pan":
      case "eraser":
      case "text":
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

  private menuButton(id: string, label: string, options: DropdownOption[] | (() => DropdownOption[])): HTMLButtonElement {
    const button = this.actionButton(id, label, () => this.dropdown.toggle(id, button, {
      label: `${label} options`,
      options: typeof options === "function" ? options() : options
    }));
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    return button;
  }

  private drawingMenu(): DropdownOpenOptions {
    const content = this.ownerDocument.createElement("div");
    for (const option of drawingOptions(this.preferences, (tool) => {
      this.preferences.activeTool = tool;
      this.lastDrawingTool = tool;
      this.setDrawEnabled(true);
      this.changed();
    }, (width) => {
      if (this.callbacks.onSelectionWidthChange?.(width)) {
        this.updateButtons();
        return;
      }
      this.preferences[this.lastDrawingTool].width = width;
      this.preferences.activeTool = this.lastDrawingTool;
      this.setDrawEnabled(true);
      this.changed();
    })) {
      const button = this.inlineOption(option);
      if (option.id.startsWith("width-")) button.classList.add("native-pdf-handwriting-drawing-width-option");
      content.append(button);
      if (option.id === "highlighter") {
        const separator = this.ownerDocument.createElement("div");
        separator.className = "native-pdf-handwriting-drawing-menu-separator";
        separator.setAttribute("role", "separator");
        content.append(separator);
      }
    }
    content.append(drawingAdvanced(this.ownerDocument, this.preferences, () => this.changed(), this.abort.signal));
    return { label: "Drawing options", content };
  }

  private textMenu(): DropdownOpenOptions {
    const content = this.ownerDocument.createElement("div");
    content.className = "native-pdf-handwriting-text-menu";
    this.preserveTextEditorSelection(content);
    const fontLabel = this.ownerDocument.createElement("label");
    fontLabel.textContent = "Font";
    const font = this.ownerDocument.createElement("select");
    for (const { label, family } of this.obsidianTextFonts()) {
      const option = this.ownerDocument.createElement("option");
      option.value = family;
      option.textContent = label;
      option.selected = this.preferences.text.fontFamily === family;
      font.append(option);
    }
    font.addEventListener("change", () => {
      this.applyTextStyle({ fontFamily: font.value });
    }, { signal: this.abort.signal });
    fontLabel.append(font);

    const controls = this.ownerDocument.createElement("div");
    controls.className = "native-pdf-handwriting-text-menu-controls";
    const selectedSize = this.callbacks.selectedTextFontSize?.();
    const size = this.ownerDocument.createElement("div");
    size.className = "native-pdf-handwriting-text-menu-size";
    const sizeInput = this.ownerDocument.createElement("input");
    sizeInput.className = "native-pdf-handwriting-text-menu-size-input";
    sizeInput.type = "text";
    sizeInput.inputMode = "decimal";
    sizeInput.setAttribute("aria-label", "Font size in pixels");
    const suffix = this.ownerDocument.createElement("span");
    const formatFontSize = (fontSize: number): string => String(Math.round(fontSize * 10) / 10);
    const normalizedFontSize = (fontSize: number): number => Math.min(96, Math.max(8, Math.round(fontSize * 10) / 10));
    let displayedFontSize = selectedSize?.fontSize ?? this.preferences.text.fontSize;
    const updateSize = (fontSize: number, mixed = false): void => {
      displayedFontSize = fontSize;
      sizeInput.value = formatFontSize(fontSize);
      suffix.textContent = mixed ? "px+" : "px";
    };
    updateSize(selectedSize?.fontSize ?? this.preferences.text.fontSize, selectedSize?.mixed);
    const setFontSize = (fontSize: number): void => {
      const normalized = normalizedFontSize(fontSize);
      this.applyTextStyle({ fontSize: normalized });
      updateSize(normalized);
    };
    sizeInput.addEventListener("change", () => {
      const fontSize = Number.parseFloat(sizeInput.value);
      if (Number.isFinite(fontSize)) setFontSize(fontSize);
      else updateSize(displayedFontSize);
    }, { signal: this.abort.signal });
    sizeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sizeInput.blur();
      }
    }, { signal: this.abort.signal });
    size.append(sizeInput, suffix);
    const button = (id: string, label: string, action: () => void, pressed: boolean): HTMLButtonElement => {
      const element = this.ownerDocument.createElement("button");
      element.type = "button";
      element.className = "native-pdf-handwriting-text-menu-button";
      element.dataset.optionId = id;
      element.textContent = label;
      element.setAttribute("aria-label", label);
      element.setAttribute("aria-pressed", String(pressed));
      element.addEventListener("click", action, { signal: this.abort.signal });
      return element;
    };
    controls.append(
      button("text-size-decrease", "-", () => {
        setFontSize(displayedFontSize - 1);
      }, false),
      button("text-size-increase", "+", () => {
        setFontSize(displayedFontSize + 1);
      }, false),
      button("text-bold", "B", () => {
        if (this.callbacks.onTextMarkdownFormat?.("bold")) {
          return;
        }
        this.applyTextStyle({ bold: !this.preferences.text.bold });
      }, this.preferences.text.bold),
      button("text-italic", "I", () => {
        if (this.callbacks.onTextMarkdownFormat?.("italic")) {
          return;
        }
        this.applyTextStyle({ italic: !this.preferences.text.italic });
      }, this.preferences.text.italic)
    );
    const togglePressed = (id: "text-bold" | "text-italic"): void => {
      const format = content.querySelector<HTMLButtonElement>(`[data-option-id='${id}']`);
      if (format) format.setAttribute("aria-pressed", String(format.getAttribute("aria-pressed") !== "true"));
    };
    controls.querySelector<HTMLButtonElement>("[data-option-id='text-bold']")?.addEventListener("click", () => {
      togglePressed("text-bold");
    }, { signal: this.abort.signal });
    controls.querySelector<HTMLButtonElement>("[data-option-id='text-italic']")?.addEventListener("click", () => {
      togglePressed("text-italic");
    }, { signal: this.abort.signal });
    content.append(fontLabel, controls, size);
    return { label: "Text options", content, focusFirst: !this.callbacks.hasActiveTextInput?.() };
  }

  private updateTextMenuSize(): void {
    if (!this.dropdown.isOpen("text")) return;
    const input = this.ownerDocument.querySelector<HTMLInputElement>(".native-pdf-handwriting-text-menu-size-input");
    if (!input || this.ownerDocument.activeElement === input) return;
    const selectedSize = this.callbacks.selectedTextFontSize?.();
    const fontSize = selectedSize?.fontSize ?? this.preferences.text.fontSize;
    input.value = String(Math.round(fontSize * 10) / 10);
    const suffix = input.nextElementSibling;
    if (suffix) suffix.textContent = selectedSize?.mixed ? "px+" : "px";
  }

  private obsidianTextFonts(): Array<{ label: string; family: string }> {
    const document = this.ownerDocument;
    const style = document.defaultView?.getComputedStyle(document.body);
    const configured = [
      { label: "Obsidian interface", variable: "--font-interface" },
      { label: "Obsidian text", variable: "--font-text" },
      { label: "Obsidian monospace", variable: "--font-monospace" }
    ].map(({ label, variable }) => ({ label, family: style?.getPropertyValue(variable).trim() ?? "" }))
      .filter((option) => option.family && !option.family.startsWith("var("));
    const fonts = configured.length ? configured : [
      { label: "Sans serif", family: "sans-serif" },
      { label: "Serif", family: "serif" },
      { label: "Monospace", family: "monospace" }
    ];
    if (!fonts.some((option) => option.family === this.preferences.text.fontFamily)) {
      fonts.push({ label: "Current annotation font", family: this.preferences.text.fontFamily });
    }
    return fonts.filter((option, index) => fonts.findIndex((candidate) => candidate.family === option.family) === index);
  }

  private applyTextStyle(patch: Partial<TextStyle>): void {
    Object.assign(this.preferences.text, patch);
    this.callbacks.onTextStyleChange?.(patch);
    this.changed();
  }

  private eraserMenuOptions(): DropdownOpenOptions {
    return {
      label: "Eraser options",
      content: eraserMenu(this.ownerDocument, this.preferences, {
        onPreview: (size) => {
          this.preferences.activeTool = "eraser";
          this.setDrawEnabled(true);
          this.preferences.eraser.size = size;
          this.callbacks.onEraserSizePreview?.(size);
        },
        onCommit: (size) => {
          this.preferences.activeTool = "eraser";
          this.setDrawEnabled(true);
          this.preferences.eraser.size = size;
          this.changed();
        },
        onWholeStrokeChange: (enabled) => {
          this.preferences.activeTool = "eraser";
          this.setDrawEnabled(true);
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

  private laserMenuOptions(): DropdownOpenOptions {
    return {
      label: "Laser options",
      content: laserMenu(this.ownerDocument, this.preferences, () => this.changed(), this.abort.signal)
    };
  }

  private lassoMenu(): DropdownOption[] {
    return lassoOptions(this.preferences, (type) => {
      this.preferences.activeTool = "lasso";
      this.setDrawEnabled(true);
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
    this.preserveTextEditorSelection(button);
    button.addEventListener("click", () => {
      const keepTextFocus = this.callbacks.hasActiveTextInput?.() ?? false;
      if (!keepTextFocus) this.setDrawEnabled(true);
      if (this.preferences.activeTool !== "eraser") {
        this.dropdown.toggle("color", button, {
          label: "Color options",
          content: this.colorMenu(),
          focusFirst: !keepTextFocus
        });
      }
    }, { signal: this.abort.signal });
    this.buttons.set("color", button);
    return button;
  }

  private colorMenu(): HTMLElement {
    const content = this.ownerDocument.createElement("div");
    this.preserveTextEditorSelection(content);
    const drawingTool: DrawingTool | "text" | "laser" = this.callbacks.hasActiveTextInput?.()
      ? "text"
      : this.preferences.activeTool === "text" ? "text" : this.preferences.activeTool === "laser" ? "laser" : resolveDrawingTool(this.preferences.activeTool);
    for (const option of colorOptions(this.preferences, (color) => {
      if (!this.callbacks.hasActiveTextInput?.() && this.callbacks.onSelectionColorChange?.(color)) {
        this.updateButtons();
        return;
      }
      this.preferences[drawingTool].color = color;
      this.callbacks.onTextStyleChange?.({ color });
      this.changed();
    })) content.append(this.inlineOption(option));
    const colorLabel = this.ownerDocument.createElement("label");
    colorLabel.textContent = "Custom color";
    const colorInput = this.ownerDocument.createElement("input");
    colorInput.type = "color";
    colorInput.value = this.preferences[drawingTool].color;
    colorInput.addEventListener("input", () => {
      if (!this.callbacks.hasActiveTextInput?.() && this.callbacks.onSelectionColorChange?.(colorInput.value)) {
        this.updateButtons();
        return;
      }
      this.preferences[drawingTool].color = colorInput.value;
      this.callbacks.onTextStyleChange?.({ color: colorInput.value });
      this.changed();
    }, { signal: this.abort.signal });
    colorLabel.append(colorInput);
    if (drawingTool === "text" || drawingTool === "laser") {
      content.append(colorLabel);
      return content;
    }
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
    content.append(colorLabel, opacityLabel);
    return content;
  }

  private moreMenu(supported: MoreAction[]): DropdownOption[] {
    const labels: Record<MoreAction, string> = {
      "export-flattened": "Export PDF (flattened)",
      "export-editable": "Export PDF (editable annotations)",
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
      this.dropdown.close(!this.callbacks.hasActiveTextInput?.());
    }, { signal: this.abort.signal });
    return button;
  }

  private activate(tool: ToolId): void {
    this.preferences.activeTool = tool;
    if (isDrawingTool(tool)) this.lastDrawingTool = tool;
    if (tool !== "pan") this.setDrawEnabled(true);
    this.changed();
  }

  private setDrawEnabled(enabled: boolean): void {
    if (this.drawEnabled === enabled) return;
    this.drawEnabled = enabled;
    this.callbacks.onDrawModeChange?.(enabled);
    this.updateButtons();
  }

  private changed(): void {
    this.updateButtons();
    this.callbacks.onPreferencesChange(this.preferences);
  }

  private updateButtons(): void {
    const active = this.preferences.activeTool;
    const drawingLabel = this.lastDrawingTool === "pen" ? "Pen" : this.lastDrawingTool === "pencil" ? "Pencil" : "Highlight";
    this.presentButton(this.buttons.get("pan")!, "Pan", "pan");
    this.presentButton(this.buttons.get("drawing")!, drawingLabel, this.lastDrawingTool);
    this.presentButton(this.buttons.get("text")!, "Text", "text");
    this.presentButton(this.buttons.get("eraser")!, "Eraser", "eraser");
    this.presentButton(this.buttons.get("laser")!, "Laser pointer", "laser");
    this.presentButton(this.buttons.get("lasso")!, this.preferences.lasso.type === "freeform" ? "Lasso" : "Rectangle", "lasso");
    const editing = this.drawEnabled;
    this.buttons.get("drawing")!.setAttribute("aria-pressed", String(editing && isDrawingTool(active)));
    this.buttons.get("text")!.setAttribute("aria-pressed", String(editing && active === "text"));
    this.buttons.get("pan")!.setAttribute("aria-pressed", String(!this.drawEnabled));
    this.buttons.get("eraser")!.setAttribute("aria-pressed", String(editing && active === "eraser"));
    this.buttons.get("laser")!.setAttribute("aria-pressed", String(editing && active === "laser"));
    this.buttons.get("lasso")!.setAttribute("aria-pressed", String(editing && active === "lasso"));
    const drawing = active === "text"
      ? this.preferences.text
      : active === "laser"
        ? this.preferences.laser
        : this.preferences[resolveDrawingTool(active)];
    const selectedTextColor = this.callbacks.selectedTextColor?.();
    const color = this.buttons.get("color");
    if (color) {
      const erasing = active === "eraser";
      const colorValue = selectedTextColor ?? drawing.color;
      color.setAttribute("aria-label", erasing ? "Transparent eraser" : `Color ${colorValue}`);
      color.removeAttribute("title");
      color.setAttribute("aria-disabled", String(erasing));
      setToolbarColorSwatch(color, colorValue, erasing);
    }
  }
}
