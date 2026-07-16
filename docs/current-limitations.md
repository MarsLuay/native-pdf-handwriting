# Current limitations

First pass proves architecture and direct-view annotation path. Runtime compatibility still needs testing against current Obsidian desktop, Android, and iPad builds.

- Undocumented PDF viewer selectors may change; adapter fails closed and reports compatibility details.
- Circular erasing preserves untouched stroke segments; very dense pages still need device profiling.
- `Export PDF (editable annotations)` emits standard `/Ink` annotations with appearance streams. Pressure variation, pencil texture, and highlighter blending are approximated because `/Ink` has one width and opacity per stroke.
- Pencil uses graphite grit with broken ribbon + fine elliptical tooth (Texture slider). Screen-capped stamp size so thick tips stay porous, not mega-blobs. Not a physical deposition sim.
- Highlighter is a wide translucent flat marker (alpha overlay). Not multiply-blend or text-region fill.
- Lasso resize and clipboard behavior are initial implementations and need large-document profiling.
- OCR and handwriting recognition are intentionally absent.
- MacBook Force Touch trackpad pressure is not available in Obsidian (Electron); stylus pressure works when the OS exposes it.
- Source PDFs are never modified; annotated copies are export-only.
- Flattened exports rasterize text into the PDF page content, so its visible appearance does not depend on PDF annotation support. Editable exports use FreeText annotations instead.
- Text annotations support bold, italic, strike-through, and heading sizes. Leading `#` markers are retained in the editor source, while saved/exported text runs resolve each heading to explicit bold and size formatting.
- Editable FreeText exports preserve Unicode in their annotation contents. Their visible appearance is rasterized with the selected Obsidian/system font, so colors, emphasis, strike-through, and headings remain visible without embedding a font. Generic PDF viewers use that appearance instead of reinterpreting incomplete rich-text styles; changing the text in another PDF app may not reproduce the same typography.

Next phase: test inside Obsidian, record real private object graph by platform/version, fix compatibility adapter only, profile large PDFs.
