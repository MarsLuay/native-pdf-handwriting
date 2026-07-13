# Manual test checklist

## Input and viewing

- Desktop mouse: PDF links, text selection, scroll, zoom work until edit tool active.
- Drawing tablet and Apple Pencil: pen input draws; pressure/tilt debug values update.
- One finger scrolls. Two fingers zoom/pan. Trackpad behavior remains native.
- Direct PDF overlay stays aligned across zoom, scroll, resize, page change, rotation.
- Embedded PDF opens focus view manually and from stylus; page/scroll position stays close.
- Internal toolbar/dropdown/search/outline clicks do not dismiss focus view.
- Outside click, Escape, close button dismiss; pinned view remains.
- Note switching, embed removal, PDF close, plugin disable/re-enable leave no overlay/listener.

## Tools and toolbar

- Open every dropdown with mouse, touch, stylus, keyboard.
- Click outside and Escape close dropdown; focus returns to button.
- Dropdown fits above/below toolbar at phone, tablet, desktop widths.
- Pen/Pencil selection, colors, opacity, five sizes, previews, stabilization persist.
- Pencil looks distinct from pen. Stroke eraser removes whole stroke.
- Freeform/Circle/Rectangle lasso settings persist; only supported actions appear.
- Undo/redo and selection actions update dirty/save status.

## Saving and recovery

- Fresh install: Autosave on, 750 ms; YOLO Mode off; backup on.
- Completed stroke, erase, transform, undo, redo schedule one serialized save.
- Pending autosave flushes on PDF/focus close, note switch, plugin unload.
- Autosave off: status shows unsaved, Save works, close offers save/discard/cancel.
- Simulated write failure keeps last valid sidecar, shows failure, permits retry/recovery.
- Rename PDF, sync conflict, large PDF, thousands of strokes remain recoverable.

## Export and YOLO Mode

- Export uses latest autosaved and unsaved in-memory edits.
- Exported filename defaults to `name-annotated.pdf`; original bytes unchanged.
- Cancelling YOLO warning leaves mode off.
- Enabling requires explicit confirmation once.
- Autosave on batches direct writes; autosave off waits for Save.
- Direct write creates backup, writes temporary PDF, validates reopen, then replaces original.
- Simulated failed/interrupted write preserves original and recovery transaction.
- Restore backup; test sync/external-edit conflict behavior.
