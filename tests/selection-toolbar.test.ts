import { describe, expect, it } from "vitest";
import { SelectionToolbar } from "../src/ui/SelectionToolbar";

function pointer(type: string, target: EventTarget, x: number, y: number, pointerId = 3): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerType: { value: "mouse" },
    pointerId: { value: pointerId },
    buttons: { value: type === "pointerup" ? 0 : 1 }
  });
  return event as unknown as PointerEvent;
}

describe("selection toolbar viewport", () => {
  it("spawns in the viewer and can be dragged", () => {
    const viewer = document.createElement("div");
    Object.defineProperty(viewer, "getBoundingClientRect", {
      value: () => ({ left: 100, top: 200, right: 700, bottom: 900, width: 600, height: 700, x: 100, y: 200, toJSON: () => ({}) })
    });
    document.body.append(viewer);

    const toolbar = new SelectionToolbar({
      onDelete: () => undefined,
      onDuplicate: () => undefined,
      onClear: () => undefined
    });
    toolbar.bindViewport(viewer);
    toolbar.show(1, { x: 40, y: 16 });

    expect(toolbar.element.style.left).toBe("140px");
    expect(toolbar.element.style.top).toBe("216px");
    expect(toolbar.element.querySelector("input[type='color']")).toBeNull();
    expect(toolbar.element.textContent).toContain("Delete");
    expect(toolbar.element.textContent).toContain("Duplicate");
    expect(toolbar.element.textContent).toContain("Done");

    const handle = toolbar.element.querySelector(".native-pdf-handwriting-selection-toolbar-drag")!;
    handle.dispatchEvent(pointer("pointerdown", handle, 180, 240));
    handle.dispatchEvent(pointer("pointermove", handle, 260, 320));

    expect(Number.parseFloat(toolbar.element.style.left)).toBeGreaterThan(140);
    expect(Number.parseFloat(toolbar.element.style.top)).toBeGreaterThan(216);

    toolbar.destroy();
    viewer.remove();
  });
});
