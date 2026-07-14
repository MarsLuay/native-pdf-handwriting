# Private Obsidian PDF integration

## Boundary

Every undocumented PDF object lookup and selector is confined to `src/integration/`. Annotation, tools, input, storage, and UI consume only `ObsidianPdfAdapter`. No private Obsidian type escapes that boundary.

## Verified first-pass surface

The adapter verifies observable DOM before attaching:

- viewer root: `.pdf-viewer` or PDF.js `.pdfViewer`;
- rendered page: `.page[data-page-number]` or `.pdf-page-view[data-page-number]`;
- optional toolbar: `.pdf-toolbar` or `.pdf-toolbar-container`;
- embedded host: `.internal-embed[src$='.pdf']`, `.internal-embed[data-type='pdf']`, or `.pdf-embed`.

The page element and its canvas provide a safe fallback for page bounds. A missing viewer root or page is a hard `PdfAdapterCompatibilityError` with every selector attempted. A missing native toolbar is a warning; the shared toolbar mounts beside the viewer.

## Assumed/private object graph

The compatibility layer cautiously probes these host-owned paths:

```text
host.pdfViewer
host.viewer
host.component.pdfViewer
host.component.viewer
```

When present, the object may provide `currentPageNumber`, `currentScale`, `pagesRotation`, and an `eventBus`. These paths are assumptions, not public Obsidian API. They are optional; DOM metrics remain the fallback. Compatibility reporting must include the fallback warning so a changed object graph is visible during debugging.

## Lifecycle and cleanup

Adapters register scroll handlers, mutation observers, and PDF.js event-bus callbacks at construction. `destroy()` removes them in reverse order, removes every mounted overlay/toolbar, and is idempotent. No prototype or method is patched. If a future release requires a monkey patch, the adapter must register restoration in the same cleanup stack before enabling it.

Page overlays mount transparent with `pointer-events: none`. Annotation mode explicitly adds `.is-editing`; leaving annotation mode removes it. This prevents the adapter from stealing text selection, links, search, mouse, touch, or trackpad behavior by default.

Direct and embedded adapters differ only in discovery and compatibility probing. Both expose the same state, page, overlay, toolbar, and cleanup contract.
