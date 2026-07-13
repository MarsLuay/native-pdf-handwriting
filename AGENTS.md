# Native PDF Ink agent rules

- Keep `Inspiration/` read-only.
- Keep undocumented Obsidian PDF access inside `src/integration/`.
- Sidecar JSON is canonical unless YOLO Mode is explicitly enabled.
- Autosave defaults on. YOLO Mode defaults off. Backup defaults on.
- Mouse, touch, and trackpad keep normal PDF behavior unless editing is explicit.
- Use shared toolbar, tools, storage, and engine for direct and embedded PDF views.
- No OCR. No whole-framework embedding. No unsafe in-place PDF writes.
- Run `npm test` and `npm run build` before done.
