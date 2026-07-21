import {
  FileView,
  MarkdownView,
  Modal,
  Notice,
  Platform,
  Plugin,
  TFile,
  normalizePath,
  type WorkspaceLeaf
} from "obsidian";
import type { SelectionShortcutAction } from "./input/SelectionShortcuts";
import { EmbeddedPdfAdapter } from "./integration/EmbeddedPdfAdapter";
import { NativePdfViewAdapter } from "./integration/NativePdfViewAdapter";
import type { ObsidianPdfAdapter, PdfAdapterCallbacks } from "./integration/ObsidianPdfAdapter";
import { PdfViewerCompatibility } from "./integration/PdfViewerCompatibility";
import { describePdfPageDom } from "./integration/pdfPageSelectors";
import { EmbedAnnotateChrome, findExistingEmbedChrome } from "./focus-view/EmbedAnnotateChrome";
import { resolvePdfFileFromEmbed } from "./focus-view/embedFocusHelpers";
import { ViewerInkSession } from "./runtime/ViewerInkSession";
import { AttachRetryPolicy } from "./runtime/AttachRetryPolicy";
import { ScanDebounce } from "./runtime/ScanDebounce";
import { VaultDebugLog } from "./logging/VaultDebugLog";
import { mergeSettings, NativePdfInkSettingTab } from "./settings";
import { RecoveryRepository } from "./storage/RecoveryRepository";
import { SidecarRepository } from "./storage/SidecarRepository";
import type { CloseChoice } from "./storage/SaveCoordinator";
import type { PluginSettings, ToolPreferences } from "./model";
import { createVaultFsTextAdapter, createVaultSyncWriter } from "./storage/VaultFs";

class UnsavedChangesModal extends Modal {
  private readonly abort = new AbortController();
  constructor(
    app: NativePdfInkPlugin["app"],
    private readonly resolveChoice: (choice: CloseChoice) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Save PDF annotations?");
    this.contentEl.createEl("p", {
      text: "This PDF has unsaved handwriting. Save it, discard it, or keep the view open."
    });
    const actions = this.contentEl.createDiv({ cls: "native-pdf-handwriting-confirm-actions" });
    for (const [label, choice, className] of [
      ["Save", "save", "mod-cta"],
      ["Discard", "discard", "mod-warning"],
      ["Cancel", "cancel", ""]
    ] as const) {
      const button = actions.createEl("button", { text: label, cls: className });
      button.addEventListener("click", () => {
        this.resolveChoice(choice);
        this.close();
      }, { signal: this.abort.signal });
    }
  }

  onClose(): void {
    this.abort.abort();
    this.contentEl.empty();
  }
}

export default class NativePdfInkPlugin extends Plugin {
  inkSettings: PluginSettings = mergeSettings(undefined, "config");
  private readonly sessions = new Map<WorkspaceLeaf, ViewerInkSession>();
  private readonly attachingLeaves = new Set<WorkspaceLeaf>();
  private readonly embedChrome = new Map<HTMLElement, EmbedAnnotateChrome>();
  private readonly persistEpochByDoc = new Map<string, number>();
  /** Back off repeated attach failures so layout rescans cannot storm a not-ready PDF. */
  private readonly attachRetry = new AttachRetryPolicy();
  private readonly scanDebounce = new ScanDebounce();
  private scanAgain = false;
  private unloaded = false;
  private readonly vaultDebugLog = new VaultDebugLog(
    () => this.app.vault,
    () => this.inkSettings.vaultDebugLogPath,
    () => this.inkSettings.vaultDebugLog
  );

  async onload(): Promise<void> {
    this.inkSettings = mergeSettings(
      await this.loadData() as Partial<PluginSettings> | null,
      this.app.vault.configDir
    );
    this.addSettingTab(new NativePdfInkSettingTab(this.app, this));

    this.addCommand({
      id: "save-active-pdf-annotations",
      name: "Save active PDF annotations",
      callback: () => void this.activeSession()?.manualSave()
    });
    this.addCommand({
      id: "export-active-annotated-pdf",
      name: "Export active annotated PDF",
      callback: () => void this.activeSession()?.exportCopy()
    });
    this.registerSelectionCommands();

    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleDebouncedScan()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => {
      for (const [sessionLeaf, session] of this.sessions) {
        if (sessionLeaf !== leaf) void session.flush();
      }
      this.scheduleDebouncedScan();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      for (const session of this.sessions.values()) void session.flush();
      this.scheduleDebouncedScan();
    }));
    this.app.workspace.onLayoutReady(() => this.scheduleDebouncedScan());
    this.registerDomEvent(window, "beforeunload", () => {
      this.emergencyPersistAllSessions();
    });
    this.registerDomEvent(window, "keydown", (event) => {
      this.activeSession()?.handleKeyDown(event);
    }, { capture: true });
  }

  onunload(): void {
    this.unloaded = true;
    this.scanDebounce.clear();
    this.attachRetry.clearAll();
    this.attachingLeaves.clear();
    for (const chrome of this.embedChrome.values()) chrome.destroy();
    this.embedChrome.clear();
    this.emergencyPersistAllSessions();
    for (const session of this.sessions.values()) {
      void session.destroy({ silent: true, alreadyPersisted: true });
    }
    this.sessions.clear();
    this.vaultDebugLog.destroy();
  }

  private allSessions(): ViewerInkSession[] {
    return [...this.sessions.values()];
  }

  private emergencyPersistAllSessions(): void {
    const writeSync = createVaultSyncWriter(this.app.vault);
    const sessions = this.allSessions();
    if (!writeSync) {
      this.vaultDebugLog.write("warn", "emergency persist unavailable", {
        reason: "no-filesystem-adapter",
        sessions: sessions.length
      });
      return;
    }
    const winners = new Map<string, ViewerInkSession>();
    for (const session of sessions) {
      const id = session.getDocumentId();
      const current = winners.get(id);
      if (!current || this.isBetterPersistWriter(session, current)) {
        winners.set(id, session);
      }
    }
    this.vaultDebugLog.write("info", "emergency persist begin", {
      sessions: sessions.length,
      documents: winners.size
    });
    for (const session of sessions) {
      const winner = winners.get(session.getDocumentId());
      if (winner !== session) {
        session.abandonWrites("plugin-unload-stale-session");
      }
    }
    for (const session of winners.values()) {
      session.emergencyPersist(writeSync, { force: true, reason: "plugin-unload" });
    }
  }

  /** Dirty beats clean; otherwise higher persistEpoch wins. */
  private isBetterPersistWriter(candidate: ViewerInkSession, current: ViewerInkSession): boolean {
    const candDirty = candidate.isDirty();
    const currDirty = current.isDirty();
    if (candDirty !== currDirty) return candDirty;
    return candidate.getPersistEpoch() > current.getPersistEpoch();
  }

  private claimPersistEpoch(documentId: string): number {
    const next = (this.persistEpochByDoc.get(documentId) ?? 0) + 1;
    this.persistEpochByDoc.set(documentId, next);
    return next;
  }

  private livePersistEpoch(documentId: string): number {
    return this.persistEpochByDoc.get(documentId) ?? 0;
  }

  private syncPersistSession(session: ViewerInkSession, reason: string): void {
    const writeSync = createVaultSyncWriter(this.app.vault);
    if (!writeSync) {
      this.vaultDebugLog.write("warn", "sync persist unavailable", {
        reason,
        document: session.getDiagnostics().pdfPath
      });
      return;
    }
    const live = this.livePersistEpoch(session.getDocumentId());
    if (live !== session.getPersistEpoch()) {
      session.abandonWrites(`${reason}-stale-session`);
      return;
    }
    for (const other of this.allSessions()) {
      if (other === session) continue;
      if (other.getDocumentId() !== session.getDocumentId()) continue;
      if (other.getPersistEpoch() < session.getPersistEpoch()) {
        other.abandonWrites(`${reason}-superseded`);
      }
    }
    session.emergencyPersist(writeSync, { force: true, reason });
  }

  async saveSettings(settings: PluginSettings): Promise<void> {
    const previousPlacement = this.inkSettings.toolbarPlacement;
    const previousBoostedZoom = this.inkSettings.boostedPdfZoom;
    this.inkSettings = settings;
    await this.saveData(settings);
    if (previousPlacement !== settings.toolbarPlacement) {
      for (const session of this.allSessions()) session.remountToolbar();
    }
    if (previousBoostedZoom !== settings.boostedPdfZoom) {
      for (const session of this.allSessions()) session.setBoostedPdfZoom(settings.boostedPdfZoom);
    }
  }

  async readAllLogs(): Promise<string | null> {
    await this.vaultDebugLog.flush();
    const path = normalizePath(this.inkSettings.vaultDebugLogPath);
    if (!path || !await this.app.vault.adapter.exists(path)) return null;
    const logs = await this.app.vault.adapter.read(path);
    return logs.trim() ? logs : null;
  }

  private scheduleDebouncedScan(delayMs = 100): void {
    this.scanAgain = true;
    if (this.unloaded) return;
    // Soonest wake wins: layout can still scan other leaves quickly, while
    // AttachRetryPolicy.canAttempt blocks the cooling path until its deadline.
    this.scanDebounce.schedule(delayMs, () => {
      void this.scanPdfViews();
    });
  }

  private async scanPdfViews(): Promise<void> {
    if (this.unloaded) return;
    this.scanAgain = false;
    await this.scanPdfLeaves();
    this.scanPdfEmbeds();
    if (this.scanAgain && !this.unloaded) this.scheduleDebouncedScan(0);
  }

  private async scanPdfLeaves(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType("pdf");
    const live = new Set(leaves);
    const livePaths = new Set<string>();
    for (const [leaf, session] of [...this.sessions]) {
      if (!live.has(leaf)) {
        this.sessions.delete(leaf);
        this.syncPersistSession(session, "leaf-closed");
        void session.destroy({ silent: true, alreadyPersisted: true });
        continue;
      }
      if (!session.isAttached()) {
        this.sessions.delete(leaf);
        this.syncPersistSession(session, "detach-rescan");
        void session.destroy({ silent: true, alreadyPersisted: true });
      }
    }

    for (const leaf of leaves) {
      if (this.sessions.has(leaf) || this.attachingLeaves.has(leaf)) continue;
      const view = leaf.view;
      const file = view instanceof FileView ? view.file : (view as FileView).file;
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") continue;
      livePaths.add(file.path);
      if (!this.attachRetry.canAttempt(file.path)) continue;

      this.attachingLeaves.add(leaf);
      let session: ViewerInkSession | undefined;
      try {
        const privateViewer = await PdfViewerCompatibility.resolvePrivateViewerFromPdfView(view);
        const pageWaitMs = Platform.isMobile ? 8_000 : 5_000;
        const adapter = await NativePdfViewAdapter.attach(
          view.containerEl,
          this.sessionAdapterCallbacks(() => session),
          privateViewer ? { privateViewer, pageWaitMs } : { pageWaitMs }
        );
        session = await this.createInkSession(file, adapter, {
          onDetached: () => {
            const current = this.sessions.get(leaf);
            if (!current || current !== session) return;
            this.sessions.delete(leaf);
            this.syncPersistSession(current, "on-detached");
            void current.destroy({ silent: true, alreadyPersisted: true });
            this.scheduleDebouncedScan(300);
          }
        });
        if (this.unloaded) {
          this.syncPersistSession(session, "unloaded-during-attach");
          void session.destroy({ silent: true, alreadyPersisted: true });
          continue;
        }
        this.sessions.set(leaf, session);
        this.attachRetry.clear(file.path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const pagesMissing = message.includes("PDF page nodes missing");
        const preview = PdfViewerCompatibility.direct(view.containerEl);
        console.warn("[Handwriting Natively] PDF view not ready or incompatible", error);
        this.vaultDebugLog.write("warn", "session attach failed", {
          document: file.path,
          error: message,
          stack: error instanceof Error ? error.stack ?? null : null,
          mobile: Platform.isMobile,
          phone: Platform.isPhone,
          pagesMissing,
          ...describePdfPageDom(preview.viewerRoot)
        });
        // After waiting for pages, keep mobile from re-attach-storming large PDFs.
        const delayMs = pagesMissing && Platform.isMobile
          ? this.attachRetry.recordHardFailure(file.path)
          : this.attachRetry.recordFailure(file.path);
        this.scheduleDebouncedScan(delayMs);
      } finally {
        this.attachingLeaves.delete(leaf);
      }
    }

    // Paths seen above omit leaves that already have sessions — still retain those paths
    // so we do not prune an open doc's cooldown incorrectly when attach is in-flight only.
    for (const leaf of leaves) {
      const view = leaf.view;
      const file = view instanceof FileView ? view.file : (view as FileView).file;
      if (file instanceof TFile && file.extension.toLowerCase() === "pdf") livePaths.add(file.path);
    }
    this.attachRetry.retainOnly(livePaths);
    const wait = this.attachRetry.msUntilNextRetry(livePaths);
    if (wait != null) this.scheduleDebouncedScan(wait);
  }

  private scanPdfEmbeds(): void {
    const liveHosts = new Set<HTMLElement>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const sourcePath = view.file.path;
      const root = view.contentEl ?? view.containerEl;
      for (const host of EmbeddedPdfAdapter.discover(root)) {
        liveHosts.add(host);
        if (this.embedChrome.has(host) || findExistingEmbedChrome(host)) continue;
        const file = resolvePdfFileFromEmbed(this.app, host, sourcePath);
        if (!file) continue;
        const chrome = new EmbedAnnotateChrome(host, {
          onAnnotate: () => void this.openPdfInNewTab(file)
        });
        this.embedChrome.set(host, chrome);
      }
    }
    for (const [host, chrome] of [...this.embedChrome]) {
      if (!host.isConnected || !liveHosts.has(host)) {
        chrome.destroy();
        this.embedChrome.delete(host);
      }
    }
  }

  private sessionAdapterCallbacks(getSession: () => ViewerInkSession | undefined): PdfAdapterCallbacks {
    return {
      onPagesChanged: (reason) => getSession()?.onPagesChanged(reason),
      onViewStateChange: (state, source) => getSession()?.onViewStateChange(state, source),
      onPageContentMutation: (recordCount) => getSession()?.onPdfPageContentMutation(recordCount),
      onCompatibilityWarning: (message) => {
        console.warn(`[Handwriting Natively] ${message}`);
        this.vaultDebugLog.write("warn", "compatibility", { message });
      },
      onDebugLog: (level, event, payload) => {
        this.vaultDebugLog.write(level, event, payload ?? {});
      }
    };
  }

  private async createInkSession(
    file: TFile,
    adapter: ObsidianPdfAdapter,
    options: { onDetached?: () => void } = {}
  ): Promise<ViewerInkSession> {
    const textFiles = createVaultFsTextAdapter(this.app.vault);
    return ViewerInkSession.create({
      adapter,
      pdfPath: file.path,
      settings: this.inkSettings,
      sidecars: new SidecarRepository(textFiles, this.inkSettings.sidecarFolder),
      recovery: new RecoveryRepository(textFiles, `${this.inkSettings.sidecarFolder}/recovery`),
      saveSettings: async (preferences) => this.saveToolPreferences(preferences),
      savePluginSettings: async (patch) => {
        await this.saveSettings({ ...this.inkSettings, ...patch });
      },
      readSourcePdf: async () => new Uint8Array(await this.app.vault.readBinary(file)),
      writeExport: async (name, bytes) => this.writeAndOpenExport(file, name, bytes),
      notice: (message) => new Notice(message),
      decideUnsaved: () => this.decideUnsaved(),
      mouseDragScrollEnabled: () => this.inkSettings.mouseDragScroll,
      simplifyStrokesEnabled: () => this.inkSettings.simplifyStrokes,
      toolbarPlacement: () => this.inkSettings.toolbarPlacement,
      vaultLog: this.vaultDebugLog,
      debugEnabled: () => this.inkSettings.vaultDebugLog,
      writeSync: createVaultSyncWriter(this.app.vault),
      claimPersistEpoch: (documentId) => this.claimPersistEpoch(documentId),
      livePersistEpoch: (documentId) => this.livePersistEpoch(documentId),
      ...(options.onDetached ? { onDetached: options.onDetached } : {})
    });
  }

  private async openPdfInNewTab(file: TFile): Promise<void> {
    if (this.unloaded) return;
    try {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true });
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
      this.vaultDebugLog.write("info", "embed annotate open tab", { document: file.path });
    } catch (error) {
      console.warn("[Handwriting Natively] open PDF tab failed", error);
      this.vaultDebugLog.write("warn", "embed annotate open tab failed", {
        document: file.path,
        error: error instanceof Error ? error.message : String(error)
      });
      new Notice(`Could not open PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private activeSession(): ViewerInkSession | undefined {
    const mostRecent = this.app.workspace.getMostRecentLeaf();
    if (mostRecent && this.sessions.has(mostRecent)) return this.sessions.get(mostRecent);
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) return undefined;
    for (const [leaf, session] of this.sessions) {
      const view = leaf.view;
      if (view instanceof FileView && view.file?.path === activeFile.path) return session;
    }
    return undefined;
  }

  private registerSelectionCommands(): void {
    // Commands stay in the palette, but no default hotkeys — Obsidian does not fall through
    // when checkCallback is false, which breaks Delete/Backspace/Cmd+C in normal Markdown.
    // Shortcuts still work on PDF ink via window capture in ViewerInkSession.
    const register = (id: string, name: string, action: SelectionShortcutAction): void => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const session = this.activeSession();
          if (!session?.canSelectionShortcut(action)) return false;
          if (!checking) session.applySelectionShortcut(action);
          return true;
        }
      });
    };
    register("delete-selected-pdf-ink", "Delete selected PDF ink", "delete");
    register("copy-selected-pdf-ink", "Copy selected PDF ink", "copy");
    register("cut-selected-pdf-ink", "Cut selected PDF ink", "cut");
    register("paste-selected-pdf-ink", "Paste PDF ink", "paste");
    register("select-all-pdf-ink", "Select all PDF ink", "selectAll");
  }

  private async saveToolPreferences(preferences: ToolPreferences): Promise<void> {
    this.inkSettings = {
      ...this.inkSettings,
      toolPreferences: structuredClone(preferences)
    };
    await this.saveData(this.inkSettings);
  }

  private async writeAndOpenExport(source: TFile, name: string, bytes: Uint8Array): Promise<string> {
    const folder = source.parent?.path ?? "";
    const stem = name.replace(/\.pdf$/i, "");
    let path = normalizePath(folder ? `${folder}/${name}` : name);
    let suffix = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = normalizePath(folder ? `${folder}/${stem}-${suffix}.pdf` : `${stem}-${suffix}.pdf`);
      suffix += 1;
    }
    const created = await this.app.vault.createBinary(path, bytes.slice().buffer);
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(created, { active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    return created.path;
  }

  private decideUnsaved(): Promise<CloseChoice> {
    return new Promise((resolve) => new UnsavedChangesModal(this.app, resolve).open());
  }
}
