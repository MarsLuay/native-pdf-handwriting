# Native PDF Ink agent rules

- Keep `Inspiration/` read-only.
- Keep undocumented Obsidian PDF access inside `src/integration/`.
- Sidecar JSON is the canonical editable annotation store. Original PDFs are never modified.
- Autosave defaults on. Use Export PDF for a separate annotated copy.
- Mouse, touch, and trackpad keep normal PDF behavior unless editing is explicit.
- Use shared toolbar, tools, storage, and engine for direct and embedded PDF views.
- No OCR. No whole-framework embedding. No in-place PDF writes.
- Run `npm test` and `npm run build` before done.
