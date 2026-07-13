# Native PDF Ink

Handwrite and annotate PDFs inside Obsidian. Original PDFs stay unchanged by default.

## First pass

- Direct PDF ink overlay with pen-aware input
- Shared compact toolbar and accessible dropdowns
- Pen, distinct pencil, stroke eraser, lasso definitions, color, size, stabilization
- PDF-space sidecar JSON with migrations and recovery
- Autosave on by default; manual Save and close protection when disabled
- Separate annotated-copy export
- YOLO Mode off by default, explicit warning, backups, validated transactional design
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
- **Toggle active PDF ink debug information** (`toggle-active-pdf-ink-debug`) shows or hides compatibility details.

Settings ends with **Copy all settings**, which copies a readable local JSON snapshot for support or backup.

The first release uses English interface text. Annotation files remain language-independent.

Privacy: [PRIVACY.md](PRIVACY.md). Terms: [TERMS.md](TERMS.md). All annotation processing is local; no telemetry or hosted service.
