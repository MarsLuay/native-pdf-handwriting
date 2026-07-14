export type SelectionShortcutAction = "copy" | "cut" | "paste" | "delete" | "selectAll";
export type HistoryShortcutAction = "undo" | "redo";

const PLUGIN_CHROME =
  ".native-pdf-ink-toolbar, .native-pdf-ink-selection-toolbar, .native-pdf-ink-dropdown, .native-pdf-ink-eraser-menu, .native-pdf-ink-advanced";

export function shouldIgnoreSelectionShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // Tool chrome: allow Mod+A / undo through Obsidian commands; DOM path still skips real fields.
  if (target.closest("input, textarea, select, [contenteditable='true']")) {
    if (target.closest(PLUGIN_CHROME)) return false;
    return true;
  }
  const el = target as HTMLElement;
  return Boolean(el.isContentEditable);
}

export function parseSelectionShortcut(event: KeyboardEvent): SelectionShortcutAction | null {
  if (event.altKey) return null;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && !event.shiftKey) {
    const key = event.key.toLowerCase();
    if (key === "a") return "selectAll";
    if (key === "c") return "copy";
    if (key === "x") return "cut";
    if (key === "v") return "paste";
    return null;
  }
  if (!mod && !event.shiftKey) {
    if (event.key === "Delete" || event.key === "Backspace" || event.code === "Delete" || event.code === "Backspace") {
      return "delete";
    }
  }
  return null;
}

export function parseHistoryShortcut(event: KeyboardEvent): HistoryShortcutAction | null {
  if (event.altKey) return null;
  const mod = event.ctrlKey || event.metaKey;
  if (!mod) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}
