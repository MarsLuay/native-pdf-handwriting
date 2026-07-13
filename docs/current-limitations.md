# Current limitations

First pass proves architecture and direct-view annotation path. Runtime compatibility still needs testing against current Obsidian desktop, Android, and iPad builds.

- Undocumented PDF viewer selectors may change; adapter fails closed and reports compatibility details.
- Segment eraser is reserved but not enabled.
- Native editable PDF `/Ink` annotations are not emitted; export draws vector page content.
- Pencil texture is lightweight, not a physical graphite simulation.
- Lasso resize and clipboard behavior are initial implementations and need large-document profiling.
- OCR and handwriting recognition are intentionally absent.
- YOLO Mode architecture exists for validated atomic writes; keep disabled until platform-specific vault replacement behavior passes manual tests.

Next phase: test inside Obsidian, record real private object graph by platform/version, fix compatibility adapter only, profile large PDFs, then complete embedded focus-view parity.
