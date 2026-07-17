# Changelog

## Unreleased

## 0.1.10 — 2026-07-17

- Expose `getSettingDefinitions()` so Obsidian 1.13+ settings search can index Handwriting Natively toggles while still routing changes through `persistPatch`.
- Prefer Obsidian `createEl` / `createDiv` / `createSpan` / `createSvg` helpers over `document.createElement` (marketplace `prefer-create-el`).

## 0.1.9 — 2026-07-17

- Add sidecar-backed rich text annotations with in-editor text styling and a Text toolbar dropdown.
- Add held-stroke shape recognition (line, arrow, rectangle, ellipse, and related shapes) with resize handles.
- Improve eraser, lasso, pointer routing, page-coordinate layout, and zoom/ink compositing.
- Expand session logging / vault debug log coverage and sidebar layout CSS tests.

## 0.1.8 — 2026-07-14

- Hide the native PDF cursor during ink/eraser with high-specificity selectors instead of `!important` (Stylelint / Obsidian css-important).

## 0.1.7 — 2026-07-14

- Add an Excalidraw-style laser pointer: freehand trails that hold briefly, then fade and erase little-by-little. Never saved to the sidecar.
- Add highlighter drawing tool (pen / pencil / highlighter) with wide translucent marker strokes, separate prefs, and PDF export.
- Make pencil graphite denser and darker by default; keep grit without pen-like solid fill.
- Fix stroke release snapping for laser and ink by committing live preview geometry and stable pencil grit seeds.
- Point the laser tip as a fixed-length triangle that stays sharp while the trail shortens.
- Reorder the ink rail to Draw, Color, Pen, Eraser, Laser, then Lasso.
- Remove the ink toolbar Zoom button and its preset/scale APIs (fit, % jumps, in/out). Pinch, native Obsidian zoom, and high-zoom ceiling boost stay.
- Fix left ink toolbar sitting under the open PDF outline/thumbnail sidebar; rail shifts to sit adjacent when the sidebar overlays it.
- Deploy `main.js` / `styles.css` / `manifest.json` into the vault plugin folder on every build so Obsidian picks up local fixes.
- Animate the left ink rail with the PDF sidebar: follow its edge while the outline/thumbnail pane opens or closes.

## 0.1.6 — 2026-07-14

- Replace forbidden sentence-case lint suppressions with marketplace-compliant settings copy.

## 0.1.5 — 2026-07-14

- Restore the immutable plugin ID `native-pdf-handwriting` while keeping the Handwriting Natively display name and repository branding.
- Add analyzer coverage that rejects plugin ID changes after the first catalog-valid release.

## 0.1.4 — 2026-07-14

- Rename the plugin to Handwriting Natively and change its ID to `handwriting-natively`.
- Refresh the Community plugin description.

## 0.1.3 — 2026-07-13

- Refresh README intro copy for Community listing.
- Republish after catalog review pass (settings heading, bound callbacks, minAppVersion 1.13.0).


## 0.1.2 — 2026-07-14

- Require Obsidian 1.13.0+ (`Plugin.settings` API / catalog `no-unsupported-api`).
- Drop plugin-name settings heading; bind selection-toolbar callbacks safely.


## 0.1.1 — 2026-07-14

- Catalog-safe manifest (`native-pdf-handwriting`), Vault API-only storage, CSS/`setCssProps` style hygiene, Setting headings, and `Vault#configDir` defaults.
- Raise `minAppVersion` to 1.8.9 for current settings APIs.


## 0.1.0 — 2026-07-13

- Local-first handwriting on Obsidian PDF views (pen, graphite pencil, eraser, lasso).
- Versioned vault sidecars, autosave, recovery; original PDFs never modified; annotated PDF export.
- Draw mode opt-in so normal PDF mouse/trackpad behavior stays intact until annotation is enabled.
- Graphite pencil LOD with tip-proportional stamp density; ink layer blit + capped backing store under heavy PDF zoom.
- Embed Annotate chrome, selection toolbar, mouse pan when not drawing, and debug logging hooks.
