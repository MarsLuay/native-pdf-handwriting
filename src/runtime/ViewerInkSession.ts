import type { InkStroke, PdfPoint, PluginSettings, ToolPreferences } from "../model";
import type { ObsidianPdfAdapter } from "../integration/ObsidianPdfAdapter";
import type { PdfPageInfo } from "../integration/PdfPageLocator";
import { PointerRouter } from "../input/PointerRouter";
import type { PointerSample } from "../input/PointerCapabilities";
import { InkSession } from "../ink/InkSession";
import { StrokeBuilder } from "../ink/StrokeBuilder";
import { PdfCoordinateMapper, type PageRotation } from "../pdf/PdfCoordinateMapper";
import { PdfExportService, annotatedFilename } from "../pdf/PdfExportService";
import { AddStrokeCommand, DeleteStrokesCommand, ReplaceStrokesCommand, translateStrokes } from "../history/AnnotationCommands";
import { CommandHistory, type Command } from "../history/CommandHistory";
import { eraseWholeStrokes } from "../tools/EraserTool";
import { selectStrokes, type SelectionShape } from "../tools/LassoTool";
import { AutosaveQueue } from "../storage/AutosaveQueue";
import { createDocumentIdentity } from "../storage/DocumentIdentity";
import { RecoveryRepository } from "../storage/RecoveryRepository";
import { SaveCoordinator, type CloseChoice } from "../storage/SaveCoordinator";
import { SidecarRepository } from "../storage/SidecarRepository";
import type { SidecarSchemaV1 } from "../storage/SidecarSchema";
import { AnnotationToolbar, type MoreAction } from "../ui/AnnotationToolbar";
import { DebugPanel } from "../ui/DebugPanel";
import { SelectionToolbar } from "../ui/SelectionToolbar";

export interface ViewerInkSessionOptions {
  adapter: ObsidianPdfAdapter;
  pdfPath: string;
  settings: PluginSettings;
  sidecars: SidecarRepository;
  recovery: RecoveryRepository;
  saveSettings(preferences: ToolPreferences): Promise<void>;
  readSourcePdf(): Promise<Uint8Array>;
  writeExport(name: string, bytes: Uint8Array): Promise<void>;
  commitOriginal?(bytes: Uint8Array): Promise<void>;
  openSettings?(): void;
  notice(message: string): void;
  decideUnsaved?(): Promise<CloseChoice>;
}

interface PageSurface {
  page: PdfPageInfo;
  overlay: HTMLElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  router: PointerRouter | null;
  builder: StrokeBuilder | undefined;
  editPath: PdfPoint[];
}

export class ViewerInkSession {
  private readonly ink = new InkSession();
  private readonly identity;
  private readonly surfaces = new Map<number, PageSurface>();
  private readonly exporter = new PdfExportService();
  private readonly createdAt = new Date().toISOString();
  private readonly toolbar: AnnotationToolbar;
  private readonly debug = new DebugPanel();
  private readonly selectionToolbar: SelectionToolbar;
  private readonly history: CommandHistory;
  private readonly autosave: AutosaveQueue<SidecarSchemaV1>;
  private readonly saveCoordinator: SaveCoordinator;
  private selected: InkStroke[] = [];
  private debugVisible = false;
  private destroyed = false;
  private readonly resizeObserver: ResizeObserver | null;

  private constructor(private readonly options: ViewerInkSessionOptions) {
    this.identity = createDocumentIdentity({ vaultPath: options.pdfPath });
    this.toolbar = new AnnotationToolbar({
      preferences: options.settings.toolPreferences,
      autosave: options.settings.autosave,
      supportedMoreActions: ["export", "settings", "debug", "compatibility"],
      callbacks: {
        onPreferencesChange: (preferences) => {
          void options.saveSettings(preferences);
          this.refresh();
        },
        onUndo: () => this.history.undo(),
        onRedo: () => this.history.redo(),
        onSave: () => this.manualSave(),
        onMore: (action) => void this.handleMore(action)
      }
    });
    this.selectionToolbar = new SelectionToolbar({
      onDelete: () => this.deleteSelection(),
      onDuplicate: () => this.duplicateSelection(),
      onRecolor: (color) => this.recolorSelection(color),
      onClear: () => this.clearSelection()
    });
    this.autosave = new AutosaveQueue<SidecarSchemaV1>({
      delayMs: options.settings.yoloMode
        ? options.settings.yoloAutosaveDelayMs
        : options.settings.autosaveDelayMs,
      retryFailed: options.settings.retryFailedAutosaves,
      write: async (_documentId, snapshot) => this.persist(snapshot),
      onStatus: (_documentId, status) => {
        this.toolbar.setSaveStatus(status, status === "saved" ? new Date() : undefined);
        if (status === "saved") this.saveCoordinator.markSaved();
      }
    });
    this.saveCoordinator = new SaveCoordinator({
      autosave: options.settings.autosave,
      saveWhenClosing: options.settings.saveWhenClosing,
      save: () => this.persist(this.snapshot()),
      scheduleAutosave: () => this.autosave.schedule(this.identity.id, this.snapshot())
    });
    this.history = new CommandHistory(() => {
      this.saveCoordinator.completedCommand();
      this.toolbar.setSaveStatus("dirty");
      this.refresh();
    });
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => this.refresh());
    this.resizeObserver?.observe(options.adapter.root);
  }

  static async create(options: ViewerInkSessionOptions): Promise<ViewerInkSession> {
    const session = new ViewerInkSession(options);
    const stored = await options.sidecars.load(session.identity.id)
      ?? await options.recovery.load(session.identity.id);
    for (const page of stored?.pages ?? []) {
      for (const stroke of page.strokes) session.ink.add(stroke);
    }
    options.adapter.mountToolbar(session.toolbar.element);
    session.toolbar.element.append(session.debug.element);
    session.debug.element.hidden = true;
    session.refresh();
    return session;
  }

  refresh(): void {
    if (this.destroyed) return;
    const pages = this.options.adapter.pages();
    const live = new Set(pages.map((page) => page.pageNumber));
    for (const [pageNumber, surface] of this.surfaces) {
      const current = pages.find((page) => page.pageNumber === pageNumber);
      if (!current || current.element !== surface.page.element) {
        surface.router?.destroy();
        surface.overlay.remove();
        this.surfaces.delete(pageNumber);
      }
    }
    for (const page of pages) {
      if (!this.surfaces.has(page.pageNumber)) this.surfaces.set(page.pageNumber, this.mountPage(page));
      this.renderPage(page.pageNumber);
    }
    for (const pageNumber of [...this.surfaces.keys()]) {
      if (!live.has(pageNumber)) this.surfaces.delete(pageNumber);
    }
  }

  isDirty(): boolean {
    return this.saveCoordinator.hasUnsavedChanges() || this.autosave.isDirty(this.identity.id);
  }

  async manualSave(): Promise<void> {
    this.toolbar.setSaveStatus("saving");
    try {
      await this.saveCoordinator.manualSave();
      this.toolbar.setSaveStatus("saved", new Date());
      this.options.notice(this.options.settings.yoloMode ? "Original PDF updated safely." : "Annotations saved.");
    } catch (error) {
      this.toolbar.setSaveStatus("failed");
      this.options.notice(`Save failed: ${this.errorMessage(error)}`);
      throw error;
    }
  }

  async flush(): Promise<void> {
    if (this.options.settings.autosave) await this.autosave.flush(this.identity.id);
    else if (this.options.settings.saveWhenClosing && this.isDirty()) await this.manualSave();
  }

  async exportCopy(): Promise<void> {
    await this.autosave.flush(this.identity.id);
    const bytes = await this.exporter.export({
      sourceBytes: await this.options.readSourcePdf(),
      getStrokes: () => this.ink.all()
    });
    const name = annotatedFilename(this.options.pdfPath.split("/").pop() ?? "document.pdf");
    await this.options.writeExport(name, bytes);
    this.options.notice(`Exported ${name}. Original PDF unchanged.`);
  }

  toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    this.debug.element.hidden = !this.debugVisible;
    this.updateDebug();
  }

  async destroy(): Promise<boolean> {
    if (this.destroyed) return true;
    if (!this.options.settings.autosave && this.isDirty()) {
      const choice = await this.options.decideUnsaved?.() ?? "cancel";
      if (!await this.saveCoordinator.prepareClose(choice)) return false;
    } else if (this.options.settings.saveWhenClosing) {
      try {
        await this.autosave.flush(this.identity.id);
      } catch (error) {
        await this.options.recovery.save(this.snapshot());
        this.options.notice(`Pending annotations kept for recovery: ${this.errorMessage(error)}`);
      }
    }
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    for (const surface of this.surfaces.values()) surface.router?.destroy();
    this.surfaces.clear();
    this.selectionToolbar.destroy();
    this.toolbar.destroy();
    this.options.adapter.destroy();
    await this.autosave.close().catch(() => undefined);
    return true;
  }

  private mountPage(page: PdfPageInfo): PageSurface {
    const overlay = this.options.adapter.mountOverlay(page.pageNumber);
    const canvas = overlay.ownerDocument.createElement("canvas");
    canvas.className = "native-pdf-ink-canvas";
    canvas.setAttribute("aria-label", `Annotations for PDF page ${page.pageNumber}`);
    overlay.append(canvas);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D rendering is unavailable");
    const surface: PageSurface = {
      page,
      overlay,
      canvas,
      context,
      router: null,
      builder: undefined,
      editPath: []
    };
    surface.router = new PointerRouter(page.element, {
      activeTool: () => this.options.settings.toolPreferences.activeTool,
      onStart: (samples, route, event) => this.pointerStart(surface, samples, route, event),
      onMove: (samples, route, event) => this.pointerMove(surface, samples, route, event),
      onEnd: (samples, route, event) => this.pointerEnd(surface, samples, route, event),
      onRoute: (_route, event) => this.updateDebug(surface, event)
    });
    return surface;
  }

  private pointerStart(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void {
    const preferences = this.options.settings.toolPreferences;
    if (route === "draw") {
      const tool = preferences.activeTool === "pencil" ? "pencil" : "pen";
      const drawing = preferences[tool];
      surface.builder = new StrokeBuilder({
        id: this.id(),
        page: surface.page.pageNumber,
        tool,
        color: drawing.color,
        width: drawing.width,
        opacity: drawing.opacity,
        inputType: event.pointerType === "pen" ? "pen" : "mouse",
        stabilization: drawing.stabilization
      });
      for (const sample of samples) surface.builder.add(this.toPdfPoint(surface, sample, drawing.simulateMousePressure));
    } else {
      surface.editPath = samples.map((sample) => this.toPdfPoint(surface, sample, true));
    }
    this.renderPage(surface.page.pageNumber);
  }

  private pointerMove(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void {
    if (route === "draw" && surface.builder) {
      const tool = this.options.settings.toolPreferences.activeTool === "pencil" ? "pencil" : "pen";
      const simulate = this.options.settings.toolPreferences[tool].simulateMousePressure;
      for (const sample of samples) surface.builder.add(this.toPdfPoint(surface, sample, simulate));
    } else if (route === "edit") {
      surface.editPath.push(...samples.map((sample) => this.toPdfPoint(surface, sample, true)));
    }
    this.updateDebug(surface, event);
    this.renderPage(surface.page.pageNumber);
  }

  private pointerEnd(surface: PageSurface, samples: PointerSample[], route: "draw" | "edit", event: PointerEvent): void {
    if (route === "draw" && surface.builder) {
      const tool = this.options.settings.toolPreferences.activeTool === "pencil" ? "pencil" : "pen";
      const simulate = this.options.settings.toolPreferences[tool].simulateMousePressure;
      for (const sample of samples) surface.builder.add(this.toPdfPoint(surface, sample, simulate));
      this.history.execute(new AddStrokeCommand(this.ink, surface.builder.finish()));
      surface.builder = undefined;
    } else if (route === "edit") {
      surface.editPath.push(...samples.map((sample) => this.toPdfPoint(surface, sample, true)));
      this.finishEdit(surface);
      surface.editPath = [];
    }
    this.updateDebug(surface, event);
    this.renderPage(surface.page.pageNumber);
  }

  private finishEdit(surface: PageSurface): void {
    const preferences = this.options.settings.toolPreferences;
    if (preferences.activeTool === "eraser") {
      const erased = eraseWholeStrokes(this.ink.page(surface.page.pageNumber), surface.editPath, preferences.eraser.size).erased;
      if (erased.length) this.history.execute(new DeleteStrokesCommand(this.ink, erased));
      return;
    }
    if (preferences.activeTool !== "lasso" || surface.editPath.length < 2) return;
    const xs = surface.editPath.map((point) => point.x);
    const ys = surface.editPath.map((point) => point.y);
    const bounds = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    const shape: SelectionShape = preferences.lasso.type === "freeform"
      ? { type: "freeform", points: surface.editPath }
      : { type: preferences.lasso.type, bounds };
    this.selected = selectStrokes(this.ink.page(surface.page.pageNumber), shape, preferences.lasso.selectionMode);
    surface.overlay.append(this.selectionToolbar.element);
    this.selectionToolbar.show(this.selected.length);
  }

  private deleteSelection(): void {
    if (!this.selected.length) return;
    this.history.execute(new DeleteStrokesCommand(this.ink, this.selected));
    this.clearSelection();
  }

  private duplicateSelection(): void {
    if (!this.selected.length) return;
    const duplicates = translateStrokes(this.selected, 10, -10).map((stroke) => ({ ...stroke, id: this.id() }));
    const command: Command = {
      label: "Duplicate strokes",
      execute: () => duplicates.forEach((stroke) => this.ink.add(stroke)),
      undo: () => duplicates.forEach((stroke) => this.ink.remove(stroke.id))
    };
    this.history.execute(command);
    this.selected = duplicates;
    this.selectionToolbar.show(duplicates.length);
  }

  private recolorSelection(color: string): void {
    if (!this.selected.length) return;
    const now = new Date().toISOString();
    const after = this.selected.map((stroke) => ({ ...stroke, color, updatedAt: now }));
    this.history.execute(new ReplaceStrokesCommand(this.ink, this.selected, after));
    this.selected = after;
  }

  private clearSelection(): void {
    this.selected = [];
    this.selectionToolbar.hide();
    this.refresh();
  }

  private renderPage(pageNumber: number): void {
    const surface = this.surfaces.get(pageNumber);
    if (!surface) return;
    const rect = surface.page.element.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const ratio = window.devicePixelRatio || 1;
    surface.canvas.width = Math.round(width * ratio);
    surface.canvas.height = Math.round(height * ratio);
    surface.canvas.style.width = `${width}px`;
    surface.canvas.style.height = `${height}px`;
    surface.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    surface.context.clearRect(0, 0, width, height);
    for (const stroke of this.ink.page(pageNumber)) this.drawStroke(surface, stroke, this.selected.some((item) => item.id === stroke.id));
    if (surface.builder?.preview().length) {
      const drawing = this.options.settings.toolPreferences[
        this.options.settings.toolPreferences.activeTool === "pencil" ? "pencil" : "pen"
      ];
      this.drawPoints(surface, surface.builder.preview(), drawing.color, drawing.width, drawing.opacity, this.options.settings.toolPreferences.activeTool === "pencil");
    }
  }

  private drawStroke(surface: PageSurface, stroke: InkStroke, selected: boolean): void {
    this.drawPoints(surface, stroke.points, stroke.color, stroke.width, stroke.opacity, stroke.tool === "pencil", selected);
  }

  private drawPoints(surface: PageSurface, points: readonly PdfPoint[], color: string, width: number, opacity: number, pencil: boolean, selected = false): void {
    if (!points.length) return;
    const mapper = this.mapper(surface);
    const context = surface.context;
    const scale = this.displayScale(surface);
    context.save();
    context.globalAlpha = opacity;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(0.5, width * scale);
    context.setLineDash(pencil ? [0.8, 0.7] : []);
    const first = mapper.toViewport(points[0]!);
    if (points.length === 1) {
      context.beginPath();
      context.arc(first.x, first.y, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.beginPath();
      context.moveTo(first.x, first.y);
      for (const point of points.slice(1)) {
        const view = mapper.toViewport(point);
        context.lineTo(view.x, view.y);
      }
      context.stroke();
    }
    if (selected) {
      context.globalAlpha = 0.9;
      context.strokeStyle = "#2563eb";
      context.lineWidth += 4;
      context.setLineDash([4, 3]);
      context.stroke();
    }
    context.restore();
  }

  private toPdfPoint(surface: PageSurface, sample: PointerSample, simulateMousePressure: boolean): PdfPoint {
    const rect = surface.page.element.getBoundingClientRect();
    const point = this.mapper(surface).toPdf({ x: sample.clientX - rect.left, y: sample.clientY - rect.top });
    const pressure = sample.pressure > 0 ? sample.pressure : simulateMousePressure ? 0.5 : 1;
    const pdf: PdfPoint = { x: point.x, y: point.y, pressure, tiltX: sample.tiltX, tiltY: sample.tiltY, time: sample.timeStamp };
    return pdf;
  }

  private mapper(surface: PageSurface): PdfCoordinateMapper {
    return new PdfCoordinateMapper({
      width: surface.page.width,
      height: surface.page.height,
      scale: this.displayScale(surface),
      rotation: this.rotation(surface.page.rotation)
    });
  }

  private displayScale(surface: PageSurface): number {
    const rect = surface.page.element.getBoundingClientRect();
    const rotation = this.rotation(surface.page.rotation);
    const pdfDisplayWidth = rotation === 90 || rotation === 270 ? surface.page.height : surface.page.width;
    return Math.max(0.001, rect.width / Math.max(1, pdfDisplayWidth));
  }

  private rotation(value: number): PageRotation {
    const normalized = ((Math.round(value) % 360) + 360) % 360;
    return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
  }

  private snapshot(): SidecarSchemaV1 {
    const now = new Date().toISOString();
    const stored = new Map<number, InkStroke[]>();
    for (const stroke of this.ink.all()) stored.set(stroke.page, [...(stored.get(stroke.page) ?? []), stroke]);
    const known = new Map(this.options.adapter.pages().map((page) => [page.pageNumber, page]));
    return {
      schemaVersion: 1,
      document: this.identity,
      pages: [...stored.entries()].map(([pageNumber, strokes]) => {
        const page = known.get(pageNumber);
        return {
          page: pageNumber,
          width: page?.width ?? 1,
          height: page?.height ?? 1,
          rotation: this.rotation(page?.rotation ?? 0),
          strokes
        };
      }),
      createdAt: this.createdAt,
      updatedAt: now
    };
  }

  private async persist(snapshot: SidecarSchemaV1): Promise<void> {
    await this.options.recovery.save(snapshot);
    await this.options.sidecars.save(snapshot);
    if (this.options.settings.yoloMode) {
      if (!this.options.settings.yoloConfirmed || !this.options.commitOriginal) {
        throw new Error("YOLO Mode direct write is unavailable or not confirmed");
      }
      const output = await this.exporter.export({ sourceBytes: await this.options.readSourcePdf(), strokes: snapshot.pages.flatMap((page) => page.strokes) });
      await this.options.commitOriginal(output);
      if (!this.options.settings.retainSidecarAfterDirectModification) await this.options.sidecars.remove(this.identity.id);
    }
    await this.options.recovery.clear(this.identity.id);
  }

  private async handleMore(action: MoreAction): Promise<void> {
    if (action === "export") await this.exportCopy().catch((error) => this.options.notice(`Export failed: ${this.errorMessage(error)}`));
    else if (action === "settings") this.options.openSettings?.();
    else if (action === "debug" || action === "compatibility") this.toggleDebug();
  }

  private updateDebug(surface?: PageSurface, event?: PointerEvent): void {
    if (!this.debugVisible) return;
    const view = this.options.adapter.getViewState();
    this.debug.update({
      ...(event ? {
        pointerType: event.pointerType,
        pressure: event.pressure,
        tiltX: event.tiltX,
        tiltY: event.tiltY
      } : {}),
      page: surface?.page.pageNumber ?? view.pageNumber,
      scale: surface ? this.displayScale(surface) : view.scale,
      rotation: surface?.page.rotation ?? view.rotation,
      tool: this.options.settings.toolPreferences.activeTool,
      dirty: this.isDirty(),
      autosave: this.options.settings.autosave,
      pending: this.autosave.isDirty(this.identity.id)
    });
  }

  private id(): string {
    return globalThis.crypto?.randomUUID?.() ?? `stroke-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
