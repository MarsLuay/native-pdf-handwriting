# Autosave and recovery

## Defaults

- `Autosave`: on.
- Autosave delay: 750 ms after a completed annotation command.
- Save when closing a PDF: on.
- Retry failed autosaves: on.

Pointer samples update the active stroke in memory. Only completed commands—stroke completion, erase, selection transform, delete, undo, or redo—mark the document dirty and schedule persistence.

## State machine

```text
saved --command--> dirty --debounce/write--> saving --success--> saved
                                   |             |
                              newer command      +--failure--> failed
                                   |                           |
                                   +----------> dirty <---retry+
```

Each document has one queue entry. Writes for the same document never overlap. If a command completes while a write is running, the current write finishes and the newest snapshot is written next. A failed write leaves the document dirty. The last valid sidecar remains canonical.

`flush(documentId)` cancels its timer and waits for all current/newer snapshots. `flush()` handles every open document. View close, active-note change, and plugin unload call flush. `close()` flushes and rejects later schedules.

## Manual save and close

With Autosave off, commands only mark dirty. The toolbar/command exposes Save. A dirty close must offer:

1. Save: persist, then close.
2. Discard: explicitly abandon in-memory edits, then close.
3. Cancel: remain open.

No dirty document silently closes. With Autosave on and “Save when closing” enabled, close flushes before teardown. Ordinary sidecar failures keep recovery data and surface `Save failed`.

## Sidecars and recovery

Schema v1 JSON stores page-space coordinates. A temporary file is serialized and validated before atomic rename when the host adapter supports rename. Failed temporary writes/validation/rename remove the temporary file and preserve the prior valid sidecar. Non-atomic adapters retain and restore the prior bytes on failure.

Crash recovery uses a separate recovery repository. A successful canonical save can clear recovery data. Recovery is never mistaken for a committed normal save.

## Export

`Export PDF` always writes a separate annotated copy from the latest in-memory annotation snapshot. The original PDF bytes are never modified.
