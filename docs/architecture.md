# Architecture

Native PDF Ink adds one annotation system to Obsidian's direct and embedded PDF experiences. Both routes share input policy, tools, toolbar, history, sidecar storage, autosave, export, and recovery.

## Boundaries

- `integration/`: only owner of undocumented Obsidian PDF objects, DOM selectors, PDF.js compatibility probes, viewer discovery, page location, and reversible patches.
- `focus-view/`: expanded embedded-PDF lifecycle. It receives a stable viewer adapter, never private PDF classes.
- `input/`: Pointer Events policy. It decides before capture or `preventDefault()`.
- `ink/`: strokes, filtering, rendering, simplification, hit testing. Coordinates use PDF page space.
- `tools/`: tool state and behavior. Preferences stay outside annotation documents.
- `storage/`: versioned sidecars, identity, serialized autosave, manual save, recovery, atomic writes.
- `pdf/`: coordinate mapping, outline/search interfaces, annotated-copy export, validated direct-write transaction.
- `history/`: commands used by edits, undo, redo, autosave scheduling.
- `ui/`: one accessible toolbar and dropdown system used by both viewing routes.

Private viewer changes should require edits only in `integration/`. Engine tests run without Obsidian.

## Canonical data

Sidecar JSON is canonical editable annotation data. Screen coordinates are transient. Original PDF stays unchanged by default. `Export PDF` creates a separate annotated copy. YOLO Mode is optional, confirmed, transactional, backed up by default, and never performs in-place byte writes.

## Lifecycle

Each attached viewer owns one disposable session. Closing PDF, removing embed, switching note, closing focus mode, or unloading plugin performs this order:

1. stop accepting new edits;
2. release pointer capture;
3. close dropdowns and overlays;
4. flush autosave, or request save/discard/cancel when manual mode is dirty;
5. disconnect observers and listeners;
6. restore patches;
7. release viewer references.

## First use

Open PDF, select Pen, write. Stylus may enter annotation mode automatically; mouse/touch keep normal PDF controls until editing is selected. Status reads `Saved`, `Saving…`, `Unsaved changes`, or `Save failed`. Expert compatibility data stays in debug command, not main toolbar.

## Offline behavior

Core use needs no account, telemetry, hosted service, CDN, or remote AI. Sidecars, settings, recovery, backups, and exports remain inside vault/device storage. Package installation may require downloading dependencies; operation after installation is local.
