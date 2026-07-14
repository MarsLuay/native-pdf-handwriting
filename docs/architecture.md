# Architecture

Native PDF Ink adds one annotation system to Obsidian's direct and embedded PDF experiences. Both routes share input policy, tools, toolbar, history, sidecar storage, autosave, export, and recovery.

## Boundaries

- `integration/`: only owner of undocumented Obsidian PDF objects, DOM selectors, PDF.js compatibility probes, viewer discovery, page location, and reversible patches.
- `focus-view/`: embed Annotate chrome and helpers that open a PDF leaf (not a private-class viewer).
- `input/`: Pointer Events policy. It decides before capture or `preventDefault()`.
- `ink/`: strokes, filtering, rendering, simplification, hit testing. Coordinates use PDF page space.
- `tools/`: tool state and behavior. Preferences stay outside annotation documents.
- `storage/`: versioned sidecars, identity, serialized autosave, manual save, recovery, atomic writes.
- `pdf/`: coordinate mapping and annotated-copy export.
- `history/`: commands used by edits, undo, redo, autosave scheduling.
- `ui/`: one accessible toolbar and dropdown system used by both viewing routes.

Private viewer changes should require edits only in `integration/`. Engine tests run without Obsidian.

## Canonical data

Sidecar JSON is canonical editable annotation data. Screen coordinates are transient. Original PDF stays unchanged. `Export PDF` creates a separate annotated copy; there is no in-place source-PDF write path.

## Lifecycle

Each attached viewer owns one disposable session. Closing PDF, removing embed, switching note, or unloading plugin performs this order:

1. stop accepting new edits;
2. release pointer capture;
3. close dropdowns and overlays;
4. flush autosave, or request save/discard/cancel when manual mode is dirty;
5. disconnect observers and listeners;
6. restore patches;
7. release viewer references.

## First use

Open PDF, enable Draw, select Pen or Pencil, write. Mouse/touch keep normal PDF controls until Draw is on. Status reads `Saved`, `Saving…`, `Unsaved changes`, or `Save failed`.

## Offline behavior

Core use needs no account, telemetry, hosted service, CDN, or remote AI. Sidecars, settings, recovery, backups, and exports remain inside vault/device storage. Package installation may require downloading dependencies; operation after installation is local.
