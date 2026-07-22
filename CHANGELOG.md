# Changelog

## Unreleased

- Vault debug log default path is `debug.md` (opens as a note); existing `debug.log` settings migrate.

## 0.1.20 — 2026-07-22

- Mobile: leave one-finger scroll to the native PDF viewer when draw is off (no custom touch `scrollBy` pan).
- Mouse/stylus drag-scroll still uses plugin pan when draw is off and the setting is enabled.
- Mouse/stylus: defer pointer capture until the drag activates; allow horizontal pan after activation when zoomed.

## 0.1.19 — 2026-07-21

- Mobile: debounce scroll/pagechanging ink remounts; skip work when mount set unchanged.
- Mobile: mount current page ±1 via O(1) page lookup (no full-DOM rect scans on scroll).
- Suppress full ink remount during zoom gesture and CSS handoff; flush remount after release.
- Draw mode: finger draws instead of panning; custom touch pan disabled while drawing.
- Mobile: ink toolbar defaults to the left sidebar when placement is PDF toolbar (`main`).

## 0.1.18 — 2026-07-21

- Mobile: mount ink canvases only for viewport pages (±1) so large textbooks cannot OOM Obsidian Mobile during attach.
- Urgent create-path breadcrumbs (`session create begin` → `refresh ok`) to pinpoint post-`adapter-ok` crashes.

## 0.1.17 — 2026-07-21

- Crash breadcrumbs: urgent vault-log flush, `file-open` / `scan-pdf-leaves` / attach-step events, window error handlers.
- Wait for PDF pages via polling (no MutationObserver on large mobile PDF trees).
- Defer mobile attach 500ms after prepare so Obsidian can finish mounting the PDF shell.

- Add palette commands (no default hotkeys) to clear freehand drawings: all pages, selected pages (or current page), and specific pages via prompt.

## 0.1.16 — 2026-07-21

- Stamp `data-page-number` on mobile page shells that mount without it; accept bare `[data-page-number]` nodes.
- Longer mobile page wait (12s). Richer attach/emergency logs (DOM child sample, open PDF leaf counts).
- Every vault debug log line includes `pluginVersion` and `obsidianVersion` (`apiVersion`).

## 0.1.15 — 2026-07-21

- Wait for PDF page nodes before attach; soft-fail + hard cooldown on mobile when page DOM is still missing (stops attach-retry storms that crash Obsidian Mobile).
- Richer `session attach failed` logs (`isMobile`, DOM snapshot). Shared PDF page selectors.

## 0.1.14 — 2026-07-21

- Set `minAppVersion` to `1.8.9` (actual PDF-viewer floor; matches 0.1.1). Rename plugin field `settings` → `inkSettings` so catalog/`Plugin.settings` (@since 1.13) does not force 1.13. Keep `display()` + `getSettingDefinitions()` for 1.12.x and 1.13+.

## 0.1.13 — 2026-07-21

- Restore `PluginSettingTab.display()` that renders the same rows as `getSettingDefinitions()`, so settings are not blank on Obsidian 1.12.x (1.13+ still uses the declarative API).

## 0.1.12 — 2026-07-18

- Keep the right annotation rail at a fixed width so it cannot stretch across the PDF pane.
- Shrink the Obsidian PDF scroll host under a right rail (`inset-inline-end` + `width: auto`).
- Skip false `full-refresh-during-zoom` warn noise on session `create` during mount resize.
- Reduce full-session paint churn (tool chrome, preferences, page-local clear-selection, history-local strokes).
- Harden zoom ink handoff (defer HQ upgrades until CSS compositing releases; layout-only reattach).
- Add attach retry / scan debounce and detached DOM helpers for safer PDF viewer wrapping.

## 0.1.11 — 2026-07-17

- Remove leftover `PluginSettingTab.display()` now that `getSettingDefinitions()` owns settings UI on `minAppVersion` 1.13.0+ (`obsidianmd/settings-tab/no-deprecated-display`).
- Keep About copy and Support links as declarative setting rows; bump `eslint-plugin-obsidianmd` to 0.4.1.

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
