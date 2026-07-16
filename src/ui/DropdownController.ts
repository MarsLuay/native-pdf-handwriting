export interface DropdownOption {
  id: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  description?: string;
  render?: (button: HTMLButtonElement) => void;
  onSelect: () => void;
}

export interface DropdownOpenOptions {
  label: string;
  options?: DropdownOption[];
  content?: HTMLElement;
  focusFirst?: boolean;
}

export class DropdownController {
  private popup: HTMLElement | null = null;
  private trigger: HTMLElement | null = null;
  private abort: AbortController | null = null;
  private currentId: string | null = null;

  constructor(private readonly ownerDocument: Document = activeDocument) {}

  get activeId(): string | null {
    return this.currentId;
  }

  isOpen(id?: string): boolean {
    return this.popup !== null && (id === undefined || id === this.currentId);
  }

  toggle(id: string, trigger: HTMLElement, options: DropdownOpenOptions): void {
    if (this.isOpen(id)) this.close(true);
    else this.open(id, trigger, options);
  }

  open(id: string, trigger: HTMLElement, options: DropdownOpenOptions): void {
    this.close(false);
    this.currentId = id;
    this.trigger = trigger;
    this.abort = new AbortController();
    const popup = this.ownerDocument.createElement("div");
    popup.className = "native-pdf-handwriting-dropdown";
    popup.dataset.focusOverlayInternal = "true";
    popup.setAttribute("role", "menu");
    popup.setAttribute("aria-label", options.label);
    popup.tabIndex = -1;
    popup.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal: this.abort.signal });
    if (options.options) {
      for (const option of options.options) popup.append(this.optionButton(option));
    }
    if (options.content) popup.append(options.content);
    this.ownerDocument.body.append(popup);
    this.popup = popup;
    trigger.setAttribute("aria-expanded", "true");
    this.reposition();

    this.ownerDocument.addEventListener("pointerdown", this.onOutsidePointer, { capture: true, signal: this.abort.signal });
    this.ownerDocument.addEventListener("keydown", this.onKeyDown, { signal: this.abort.signal });
    this.ownerDocument.defaultView?.addEventListener("resize", this.reposition, { signal: this.abort.signal });
    this.ownerDocument.defaultView?.addEventListener("scroll", this.reposition, { capture: true, signal: this.abort.signal });
    if (options.focusFirst !== false) this.enabledItems()[0]?.focus();
  }

  close(restoreFocus = true): void {
    const trigger = this.trigger;
    trigger?.setAttribute("aria-expanded", "false");
    this.abort?.abort();
    this.popup?.remove();
    this.popup = null;
    this.trigger = null;
    this.abort = null;
    this.currentId = null;
    if (restoreFocus) trigger?.focus();
  }

  destroy(): void {
    this.close(false);
  }

  private optionButton(option: DropdownOption): HTMLButtonElement {
    const button = this.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "native-pdf-handwriting-dropdown-option";
    button.dataset.optionId = option.id;
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(option.active ?? false));
    button.disabled = option.disabled ?? false;
    button.textContent = option.label;
    if (option.description) button.title = option.description;
    option.render?.(button);
    button.addEventListener("click", () => {
      if (button.disabled) return;
      option.onSelect();
      this.close(true);
    }, this.abort ? { signal: this.abort.signal } : undefined);
    return button;
  }

  private readonly onOutsidePointer = (event: PointerEvent): void => {
    const target = event.target as Node | null;
    if (target && (this.popup?.contains(target) || this.trigger?.contains(target))) return;
    this.close(false);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close(true);
      return;
    }
    const items = this.enabledItems();
    if (items.length === 0) return;
    const current = items.indexOf(this.ownerDocument.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = (current + 1 + items.length) % items.length;
    else if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  };

  private enabledItems(): HTMLButtonElement[] {
    return this.popup ? Array.from(this.popup.querySelectorAll<HTMLButtonElement>("[role^='menuitem']:not(:disabled)")) : [];
  }

  private readonly reposition = (): void => {
    if (!this.popup || !this.trigger) return;
    const anchor = this.trigger.getBoundingClientRect();
    const popup = this.popup.getBoundingClientRect();
    const view = this.ownerDocument.defaultView;
    const width = view?.innerWidth ?? this.ownerDocument.documentElement.clientWidth;
    const height = view?.innerHeight ?? this.ownerDocument.documentElement.clientHeight;
    const gap = 6;
    const popupWidth = popup.width || Math.min(320, width - 16);
    const popupHeight = popup.height || 240;
    const left = Math.max(8, Math.min(anchor.left, width - popupWidth - 8));
    const fitsBelow = anchor.bottom + gap + popupHeight <= height - 8;
    const top = fitsBelow ? anchor.bottom + gap : Math.max(8, anchor.top - popupHeight - gap);
    Object.assign(this.popup.style, { left: `${left}px`, top: `${top}px`, maxHeight: `${Math.max(120, height - 16)}px` });
    this.popup.dataset.placement = fitsBelow ? "bottom" : "top";
  };
}
