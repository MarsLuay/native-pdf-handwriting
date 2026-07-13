# Toolbar and dropdown design

`AnnotationToolbar` is the only toolbar implementation for direct and embedded PDFs. It is plain DOM, dependency-free, keyboard accessible, and consumes shared `ToolPreferences`.

## Compact controls

- Drawing main button shows Pen/Pencil; its dropdown contains both tools, five numeric widths with live previews, and advanced pressure/stabilization/opacity/thinning/texture/tilt/mouse controls.
- Eraser exposes whole-stroke sizes. Segment erasing is visible but disabled until supported.
- Color exposes recent colors and the active swatch.
- Lasso exposes freeform, ellipse, rectangle, enclosed, and intersecting modes.
- Undo/redo always occupy predictable positions when supported.
- Zoom, outline, manual Save, and More appear only when callbacks/actions are supported.
- Manual Save appears only with Autosave off. The live status announces Saved, Saving…, Unsaved changes, or Save failed.

The toolbar updates the active icon/label and remembers per-tool values through `ToolPreferences`; open dropdown state is transient UI state and never enters annotation sidecars.

## Placement

Desktop and tablet dropdowns anchor below the trigger when space permits and flip above it otherwise. Horizontal position clamps to an 8px viewport gutter. Mobile uses the same controller and markup, capped to `100vw - 16px`. The toolbar is narrow-first, uses 44px targets, and scrolls horizontally inside its own bounds rather than widening the document.

## Interaction

Dropdown options use menu roles, active/disabled state, Arrow Up/Down, Home/End, Escape, outside-click dismissal, and trigger focus restoration. Popup and toolbar roots carry `data-focus-overlay-internal="true"`, so portaled color inputs and dropdowns cannot dismiss the embedded focus viewer. Focus overlay dismissal separately recognizes its panel, marked portal controls, Pin state, click-outside, Escape, and close button.

## Cleanup

`DropdownController.destroy()` aborts document/window listeners, removes the popup, and releases references. `AnnotationToolbar.destroy()` invokes it before removing the toolbar. Focus close first flushes Autosave, or requests Save/Discard/Cancel when Autosave is disabled and state is dirty, then destroys its PDF adapter and overlay.
