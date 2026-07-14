import { describe, expect, it } from "vitest";
import { parseHistoryShortcut, parseSelectionShortcut, shouldIgnoreSelectionShortcut } from "../src/input/SelectionShortcuts";

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

describe("selection shortcuts", () => {
  it("parses copy, cut, paste, select all, and delete", () => {
    expect(parseSelectionShortcut(keyEvent({ key: "c", ctrlKey: true }))).toBe("copy");
    expect(parseSelectionShortcut(keyEvent({ key: "C", metaKey: true }))).toBe("copy");
    expect(parseSelectionShortcut(keyEvent({ key: "x", ctrlKey: true }))).toBe("cut");
    expect(parseSelectionShortcut(keyEvent({ key: "v", metaKey: true }))).toBe("paste");
    expect(parseSelectionShortcut(keyEvent({ key: "a", metaKey: true }))).toBe("selectAll");
    expect(parseSelectionShortcut(keyEvent({ key: "A", ctrlKey: true }))).toBe("selectAll");
    expect(parseSelectionShortcut(keyEvent({ key: "Delete" }))).toBe("delete");
    expect(parseSelectionShortcut(keyEvent({ key: "Backspace" }))).toBe("delete");
  });

  it("parses undo and redo", () => {
    expect(parseHistoryShortcut(keyEvent({ key: "z", metaKey: true }))).toBe("undo");
    expect(parseHistoryShortcut(keyEvent({ key: "Z", ctrlKey: true }))).toBe("undo");
    expect(parseHistoryShortcut(keyEvent({ key: "z", metaKey: true, shiftKey: true }))).toBe("redo");
    expect(parseHistoryShortcut(keyEvent({ key: "y", ctrlKey: true }))).toBe("redo");
    expect(parseHistoryShortcut(keyEvent({ key: "z", altKey: true, metaKey: true }))).toBeNull();
  });

  it("ignores modified delete and alt combos", () => {
    expect(parseSelectionShortcut(keyEvent({ key: "Delete", ctrlKey: true }))).toBeNull();
    expect(parseSelectionShortcut(keyEvent({ key: "c", ctrlKey: true, altKey: true }))).toBeNull();
    expect(parseSelectionShortcut(keyEvent({ key: "v", metaKey: true, shiftKey: true }))).toBeNull();
  });

  it("ignores form fields outside plugin chrome", () => {
    const toolbar = document.createElement("div");
    toolbar.className = "native-pdf-ink-toolbar";
    const input = document.createElement("input");
    toolbar.append(input);
    document.body.append(toolbar);
    expect(shouldIgnoreSelectionShortcut(input)).toBe(false);
    toolbar.remove();

    const lone = document.createElement("input");
    document.body.append(lone);
    expect(shouldIgnoreSelectionShortcut(lone)).toBe(true);
    lone.remove();
  });
});
