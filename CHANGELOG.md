# Changelog

## Unreleased

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
