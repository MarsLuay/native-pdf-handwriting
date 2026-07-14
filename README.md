# Native PDF Ink

Locally handwrite on PDFs with a stylus or mouse inside Obsidian.

## First pass

- Direct PDF ink overlay with pen-aware input
- Shared compact toolbar and accessible dropdowns
- Explicit Draw checkbox; off by default so Sidecar Apple Pencil input behaves like a normal mouse
- Pen, distinct pencil, circular eraser, lasso tools, color, size, stabilization
- PDF-space sidecar JSON with migrations and recovery
- Autosave on by default; manual Save and close protection when disabled
- Separate annotated-copy export (original PDF never modified)
- Desktop/mobile compatibility adapters and cleanup guards

## Development

```bash
npm install
npm test
npm run build
```

Install `manifest.json`, `main.js`, and `styles.css` in an Obsidian plugin folder for runtime testing.

See `docs/manual-test-checklist.md` before trusting private PDF-view integration or direct PDF modification.

## Commands

- **Save active PDF annotations** (`save-active-pdf-annotations`) saves the open PDF's sidecar now.
- **Export active annotated PDF** (`export-active-annotated-pdf`) creates a separate annotated copy.
- **Select all PDF ink** (`select-all-pdf-ink`) selects ink on the current page when Draw is on. In command palette only; Cmd/Ctrl+A still selects PDF text when Draw is off.

Settings ends with **Copy all settings**, which copies a readable local JSON snapshot for support or backup.

The first release uses English interface text. Annotation files remain language-independent.

Privacy: [PRIVACY.md](PRIVACY.md). Terms: [TERMS.md](TERMS.md). All annotation processing is local; no telemetry or hosted service.
