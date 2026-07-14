# Inspiration analysis

## Scope and evidence

This analysis uses ten local, read-only, depth-1 clones under `Inspiration/`. Paths below are primary-source citations into those clones. “Verified” statements describe the inspected commit; “Adopt” and “Do not adopt” are design inferences for Handwriting Natively. Obsidian PDF internals are undocumented and must be runtime-guarded even when PDF++ currently types them.

No source code has been copied or adapted from any inspiration repository. Direct code reuse: **none**. If that changes, record the exact source range, commit, modifications, copyright notice, and license obligations here before merging it.

| Repository | Inspected commit | License finding |
| --- | --- | --- |
| `obsidian-pdf-plus` | `6a3218b9c506076b405438489e614bc9e22b833b` | MIT (`Inspiration/obsidian-pdf-plus/LICENSE`); bundled third-party notices also exist in `THIRD_PARTY_LICENSES`. |
| `obsidian-ink` | `d5007d151ab80bd48fa798a6b8e4d7e7f5365dbc` | CC BY-NC-ND 4.0 (`Inspiration/obsidian-ink/LICENSE.md`). No source adaptation: the license prohibits distributing adaptations and restricts commercial use. |
| `obsidian-excalidraw-plugin` | `6860b4a1caf262b8aae160b3243e5bd00f01b69a` | AGPL-3.0 (`Inspiration/obsidian-excalidraw-plugin/LICENSE`). Concept study only unless the project intentionally accepts AGPL obligations. |
| `perfect-freehand` | `176e00f2399f4969e1b0965c5921d96a3e50ce9f` | MIT (`Inspiration/perfect-freehand/LICENSE`; package copy also has a license file). |
| `tldraw` | `13fdd58841ef441ed7b9624a36de75764fcce79d` | Custom tldraw license (`Inspiration/tldraw/LICENSE.md`): development use is allowed, but production use is prohibited without a trial or commercial license. Concept study only; do not bundle it. |
| `pdf.js` | `5e3272c929debcfeaebeef6e876b17f6e3122587` | Apache-2.0 (`Inspiration/pdf.js/LICENSE`), including notice/change-marking obligations when distributing modified code. |
| `obsidian-annotator` | `3647dd92d0d803bae9a3f34a1aac19eacb2fd52d` | AGPL-3.0 (`Inspiration/obsidian-annotator/LICENSE.TXT`). Concept study only unless AGPL is accepted. |
| `obsidian-handwrite` | `ff1330f7931edaa44a8cb09d4b1908e537b8eadd` | MIT (`Inspiration/obsidian-handwrite/LICENSE`). |
| `pdf-lib` | `93dd36e85aa659a3bca09867d2d8fac172501fbe` | MIT (`Inspiration/pdf-lib/LICENSE.md`). |
| `monkey-around` | `0884a1003f4c4840c60d000ac86284b5a4b84e8b` | `package.json` declares ISC, but this clone has no standalone license text (`Inspiration/monkey-around/package.json`). Obtain and retain the complete ISC notice before distributing copied or vendored source. |

## PDF++: Obsidian PDF integration

### Verified source facts

PDF++ models the direct-view object graph in `Inspiration/obsidian-pdf-plus/src/typings.d.ts`:

```text
WorkspaceLeaf.view: PDFView
  -> viewer: PDFViewerComponent
    -> child: PDFViewerChild
      -> pdfViewer: ObsidianViewer
        -> pdfViewer: PDF.js PDFViewer
          -> _pages[] / getPageView(): PDFPageView
        -> eventBus
        -> pdfSidebar / pdfOutlineViewer / pdfThumbnailViewer
        -> findBar / findController / pdfLinkService
```

The same `PDFViewerComponent -> PDFViewerChild -> ObsidianViewer` tail is used by embeds. `PDFEmbed` owns `file`, optional `subpath`, `containerEl`, and `viewer`. The child also exposes `toolbar`, `findBar`, `getPage(page)`, `file`, and `opts.isEmbed`. A `PDFPageView` exposes `div`, `canvas`, `viewport`, text/annotation layers, and `getPagePoint()`; the underlying PDF.js viewer exposes scale, rotation/location state, page navigation, and page views.

These are not stable Obsidian APIs. The same typings record a concrete break: through Obsidian 1.7.7, `view.viewer.child.pdfViewer` was an `ObsidianViewer` instance; from 1.8.0 it became a raw object created by `window.pdfjsViewer.createObsidianPDFViewer`, with `PDFViewerApplication` as prototype. Text-layer ownership also changed across that boundary.

Direct discovery iterates workspace leaves, tests for PDF views, and reads `view.viewer` (`Inspiration/obsidian-pdf-plus/src/lib/workspace-lib.ts`). Active discovery prefers a learned constructor with `getActiveViewOfType`, then falls back to `activeLeaf`. `Inspiration/obsidian-pdf-plus/src/patchers/pdf-view.ts` reaches `view.viewer.child.pdfViewer.pdfViewer` to capture/restore page, left/top, zoom, and `_location`.

Embedded discovery is structurally different. `Inspiration/obsidian-pdf-plus/src/lib/index.ts` recursively walks descendant Obsidian `Component`s because embeds can be nested in Markdown embeds or canvas nodes. It separately traverses Markdown `currentMode`, Canvas node children, and Excalidraw embeddable leaf refs, then returns each `PDFEmbed.viewer`. `Inspiration/obsidian-pdf-plus/src/utils/index.ts` further distinguishes Markdown embeds, Canvas, hover popovers, and Hover Editor by `isEmbed` plus DOM ancestry. A CSS query alone would miss instances and misclassify contexts.

PDF++ learns internal constructors from a live component, patches their prototypes, and reloads existing direct and embedded viewer components (`Inspiration/obsidian-pdf-plus/src/patchers/pdf-internals.ts`). Readiness is asynchronous through `PDFViewerComponent.then(child => ...)`. Its toolbar integration mounts against `child.toolbar`; `Inspiration/obsidian-pdf-plus/src/toolbar.ts` uses `toolbar.toolbarLeftEl`, `toolbar.zoomInEl`, `toolbar.zoomOutEl`, and sibling/icon checks before inserting controls. It drives native PDF.js behavior through the existing viewer/event bus rather than maintaining a second zoom model.

Outline and search are already reachable. `Inspiration/obsidian-pdf-plus/src/lib/commands.ts` opens the existing outline with `pdfSidebar.switchView(..., true)` after checking `haveOutline`; `Inspiration/obsidian-pdf-plus/src/lib/index.ts` calls `findBar.showSearch()`, sets `searchComponent`, updates search settings, and dispatches the native find event. The corresponding internal shapes and events are recorded in `src/typings.d.ts`, including `outlineloaded`, `textlayerrendered`, `pagerendered`, `pagechanging`, `scalechanging`, and `sidebarviewchanged`.

Mobile is not equivalent to desktop. PDF++ disables some text-layer copy processing on `Platform.isMobile`, avoids hover toolbar behavior on `Platform.isPhone`, uses mobile-specific copy handling, and applies embed-specific page-width/sidebar workarounds in `src/patchers/pdf-internals.ts` and `src/toolbar.ts`. These branches are evidence that behavior and DOM timing must be tested on Obsidian Mobile, not inferred from desktop.

Cleanup is deliberately reversible. Every prototype patch is passed to `plugin.register(around(...))`; event listeners are attached through a child `Component`; PDF.js event-bus listeners register a matching `off`; toolbar-created elements register removal callbacks (`src/patchers/pdf-internals.ts`, `src/lib/index.ts`, `src/toolbar.ts`). PDF++ sometimes reloads viewer components after patching, which is useful evidence but too disruptive to make Handwriting Natively’s normal mounting strategy.

### Design inference for Handwriting Natively

Adopt a narrow `ObsidianPdfAdapter` that returns a capability-checked session rather than leaking the graph. Validate every edge independently: component readiness; child; viewer DOM; PDF.js viewer; event bus; page view/viewport; toolbar; find bar; sidebar. Record the detected Obsidian version and failed edge for compatibility diagnostics. Prefer event and DOM observation over prototype patches; patch only where no instance-level seam exists.

For direct views, attach one overlay host per `PDFPageView.div`, keep canonical points in PDF page space, and recompute the view transform from the current viewport on render/scale/rotation/resize events. Do not treat `_location`, `_pages`, DOM class names, or toolbar sibling positions as contracts.

For embeds, discover `PDFEmbed` instances through component ownership, not global selectors. The focus viewer should create/own its own adapter session for the same `TFile`; transfer page, approximate PDF-space position, and zoom through a small state DTO. Do not detach or reparent the live embedded viewer DOM: that would entangle Obsidian’s component lifetime with the overlay. Direct and focus sessions must then feed the same annotation engine, toolbar model, sidecar repository, and save coordinator.

Reuse native outline and search capabilities when present: toggle `pdfSidebar`, and expose/focus the existing `findBar` or dispatch through it. Do not fork outline extraction or text search. If those internals are absent, hide the capability with a compatibility notice rather than silently substituting incompatible behavior.

Mount a Handwriting Natively toolbar container into `toolbarLeftEl` only after structural checks. On narrow/mobile layouts, mount the same toolbar model in a plugin-owned, viewport-safe host instead of depending on desktop toolbar siblings. Popovers belong to that session host and must stop dismissal propagation without globally swallowing PDF pointer input.

Each session needs one disposal stack: PDF.js `off` callbacks, DOM listeners/`AbortController`, observers, injected nodes, popovers, pending timers, pointer captures, references, and optional monkey-patch uninstallers. Close order is: stop accepting edits; finish/cancel the active gesture; flush or resolve unsaved changes; release capture; dispose UI/listeners; drop viewer references. Plugin unload must await all save queues before session disposal completes.

## Other repositories

### `monkey-around`

**Verified.** `Inspiration/monkey-around/index.ts` implements `around()` as a cooperative wrapper chain and returns an uninstaller that remains safe when wrappers are removed out of order. It also provides `dedupe()` and a promise-based `serialize()`. PDF++ demonstrates registering each uninstaller with Obsidian’s plugin lifecycle.

**Adopt.** Use the removable-patch concept and register every uninstaller immediately. A dependency on the published package may be considered after confirming its full ISC notice and compatibility.

**Do not adopt.** Do not hand-assign prototype methods, leave patches installed after unload, or use `serialize()` as the annotation save queue without verifying failure/coalescing semantics; its queue serializes calls but does not itself implement latest-state coalescing, retries, or durable recovery.

### `obsidian-ink`

**Verified.** The current plugin embeds tldraw. `Inspiration/obsidian-ink/src/tldraw/drawing/tldraw-drawing-editor.tsx` listens to user store changes, separates drawing/camera activity, schedules short incremental and longer complete saves, clears timers/listeners on unmount, and exposes `saveAndHalt`. `src/tldraw/drawing/drawing-embed.tsx` switches between preview/editor states and awaits `saveAndHalt` before returning to preview. `src/extensions/widgets/drawing-embed-widget.tsx` persists serialized Ink file data with `vault.modify`. Menus are split across `src/tldraw/primary-menu-bar/`, `secondary-menu-bar/`, and grouped menu components.

**Adopt.** Keep preview/focused-edit state explicit, classify user changes before scheduling persistence, and provide an awaitable “flush then halt” boundary.

**Do not adopt.** Do not embed tldraw or its infinite-canvas snapshot model into PDF pages. Do not copy code under CC BY-NC-ND. Its timer-triggered save calls are not a demonstrated per-document serialized queue with retries/recovery, so use it only as interaction evidence.

### `obsidian-excalidraw-plugin`

**Verified.** `Inspiration/obsidian-excalidraw-plugin/src/view/ExcalidrawView.ts` has explicit dirty state, save/autosave semaphores, desktop/mobile intervals, checks that avoid autosaving during active freedraw/text/new-element interactions, and unload-time forced save behavior. `src/core/managers/EventManager.ts` saves a dirty prior view during leaf changes; `ObserverManager.ts` covers modal and mobile drawer transitions; `FileManager.ts` coordinates external file changes. Pen-mode preferences live in `src/core/settings.ts`, while `src/shared/Dialogs/PenSettingsModal.ts` and `FloatingModal.ts` show staged settings and mobile-aware floating UI. Actual stroke and lasso mechanics are largely supplied by Excalidraw rather than this Obsidian wrapper.

**Adopt.** Use explicit dirty/saving/autosaving state, suppress save work during an active gesture, flush on leaf/view lifecycle transitions, and test mobile drawers/popout documents as separate DOM environments.

**Do not adopt.** Do not copy AGPL code or import the whole Excalidraw lifecycle. Avoid polling autosave as the primary trigger; Handwriting Natively should debounce completed commands and serialize writes, with lifecycle flush as a backstop.

### `perfect-freehand`

**Verified.** `Inspiration/perfect-freehand/packages/perfect-freehand/src/getStroke.ts` composes `getStrokePoints` and `getStrokeOutlinePoints`; adjacent files expose streamline, smoothing, thinning, pressure simulation, caps, and tapering. The result is an outline polygon, not a persistent editable centerline. Tests and benchmarks live beside the implementation.

**Adopt.** Evaluate the MIT package behind `StrokeRenderer`; pass real pressure with `simulatePressure: false`, and use simulation only for mouse/no-pressure input. Store normalized centerline samples and tool parameters, then derive render outlines so library upgrades do not migrate sidecars.

**Do not adopt.** Do not store returned outline vertices as canonical ink, and do not mistake streamline for the entire stabilization pipeline; retain coalesced/raw samples during the gesture and benchmark final simplification separately.

### `tldraw`

**Verified.** `Inspiration/tldraw/packages/tldraw/src/lib/tools/SelectTool/childStates/Brushing.ts` implements rectangular enclosed/intersecting selection with spatial-index candidate filtering. `ScribbleBrushing.ts` implements crossing-path selection via segment/geometry hit tests; it is not a closed freeform-area lasso. `packages/editor/src/lib/editor/managers/SpatialIndexManager/SpatialIndexManager.ts`, `HistoryManager/HistoryManager.ts`, and `packages/editor/src/lib/editor/Editor.ts` cover spatial queries, history, selection bounds, duplication, transforms, ordering, and clipboard-related operations. `packages/tldraw/src/lib/tools/EraserTool/EraserTool.ts` is the eraser state-machine reference. No circle/ellipse lasso implementation was found in the inspected paths.

**Adopt.** Reproduce the small concepts: broad-phase page-local spatial index; precise geometry hit tests; enclosed versus intersecting policies; command-based undo/redo; selection bounds; and explicit state machines. Implement ellipse selection directly against stroke geometry rather than claiming tldraw supplies it.

**Do not adopt.** Do not bundle tldraw under its production-restricted license, lift its implementation, or inherit its multi-shape/infinite-canvas record system for fixed PDF pages.

### `pdf.js`

**Verified.** `Inspiration/pdf.js/web/pdf_page_view.js` owns page render/scale/rotation lifecycle and dispatches layer-rendered events; `web/pdf_viewer.js` owns viewer navigation and scale; `web/pdf_find_controller.js` defines `PDFFindController`; `web/pdf_find_bar.js`, `web/pdf_outline_viewer.js`, and `web/sidebar.js` supply search/outline/sidebar UI. `src/display/display_utils.js` contains viewport transforms. `src/display/editor/ink.js` and `src/display/editor/drawers/inkdraw.js` demonstrate upstream ink/editor geometry with rotation-aware transforms.

**Adopt.** Use PDF.js viewport conversion and event semantics as the coordinate/lifecycle reference. Treat page rotation as part of the transform and use the existing Obsidian viewer’s text/search/outline objects through the adapter.

**Do not adopt.** Do not instantiate a second upstream viewer inside direct PDF views, reach into upstream private fields from engine code, or assume Obsidian’s customized build matches this commit. Upstream editor layers may inform export/interoperability, but sidecar ink remains canonical.

### `obsidian-annotator`

**Verified.** `Inspiration/obsidian-annotator/src/constants.ts` defines annotation-target metadata. `src/annotationUtils.tsx` stores Web Annotation-like JSON with source/target selectors inside Markdown blocks, and `src/annotationFileUtils.tsx` reads and rewrites a separate annotation Markdown file. This is non-destructive to the source PDF, but it is not the proposed versioned JSON sidecar. Some `vault.modify/create` calls are initiated without awaiting their promises.

**Adopt.** Preserve source identity separately from annotations and keep human-linkable annotation IDs/targets.

**Do not adopt.** Do not copy AGPL code, embed high-frequency stroke arrays in Markdown blockquote/regex storage, reuse its older reader, or inherit its write coordination. Use versioned sidecar JSON, atomic repository operations, migrations, and explicit recovery.

### `obsidian-handwrite`

**Verified.** `Inspiration/obsidian-handwrite/main.js` is a single large `CalligraphyCanvasView`. It uses Pointer Events, pressure, stylus-button checks, distinct pen/fountain/calligraphy/pencil rendering, rectangle selection, object movement, erasing, zoom/pan, and history. It sets `touch-action: none` on the whole canvas, falls back with `pressure || 0.5`, stores a 5000×5000 canvas/history image, and autosaves every state to one plugin-settings entry named `autosave` without a visible per-document serialized queue.

**Adopt.** Preserve separate pen/pencil parameters and stroke metadata; pressure-aware visual differentiation is useful test material.

**Do not adopt.** Do not copy the monolith or storage model. Do not use `pointerType === "eraser"` as a portable assumption, convert real zero pressure to `0.5`, disable all touch behavior, omit pointer capture/coalesced samples, or keep full-canvas `ImageData` in command history.

### `pdf-lib`

**Verified.** `Inspiration/pdf-lib/src/api/PDFDocument.ts` exposes `PDFDocument.load`, `copyPages`, and `save`; `src/api/PDFPage.ts` exposes `drawSvgPath`; `src/api/svgPath.ts` supports path conversion. The library produces PDF bytes in memory; Obsidian vault atomic replace remains separate from export.

**Adopt.** Evaluate the MIT library inside `PdfExportService`: load the original, draw vector paths with explicit PDF-page transforms, save to a new byte array, write an exported copy, and reopen/parse it for validation.

**Do not adopt.** Do not rewrite the source PDF during ordinary live editing, treat `save()` as an atomic file operation, or rely on export bytes as the editable stroke model.

## Resulting architecture decisions

1. `src/integration/` is the sole owner of undocumented Obsidian/PDF.js objects and runtime compatibility probes.
2. Direct and embedded-focus sessions share one page-space annotation engine, command history, toolbar state, sidecar repository, and serialized save coordinator.
3. Native viewer search, outline, zoom, navigation, links, and text layers remain authoritative; annotation input intercepts only confirmed editing gestures.
4. Sidecar JSON is canonical and versioned. Autosave is command-triggered, debounced, per-document serialized, retryable, and flushable. UI/tool preferences and transient popover state are not sidecar data.
5. Rendering libraries are replaceable. Canonical strokes retain normalized centerline points, pressure/tilt/tool metadata, page dimensions, and rotation; generated outlines are caches.
6. Export is non-destructive. Annotated copies are written separately; source PDFs are never replaced by this plugin.
7. Reversible cleanup is a release criterion: no session may retain patches, event-bus listeners, DOM listeners, observers, overlays, toolbar nodes, popovers, timers, pointer captures, pending writes, or viewer references after disposal.
