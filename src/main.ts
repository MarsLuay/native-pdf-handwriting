import {
  FileView,
  Modal,
  Notice,
  Plugin,
  TFile,
  normalizePath,
  type Vault,
  type WorkspaceLeaf
} from "obsidian";
import { NativePdfViewAdapter } from "./integration/NativePdfViewAdapter";
import { DirectPdfWriteTransaction, PdfExportService, type BinaryFileAdapter } from "./pdf/PdfExportService";
import { ViewerInkSession } from "./runtime/ViewerInkSession";
import { mergeSettings, NativePdfInkSettingTab } from "./settings";
import { RecoveryRepository } from "./storage/RecoveryRepository";
import { SidecarRepository, type TextFileAdapter } from "./storage/SidecarRepository";
import type { CloseChoice } from "./storage/SaveCoordinator";
import type { PluginSettings, ToolPreferences } from "./model";

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
    const actions = this.contentEl.createDiv({ cls: "native-pdf-ink-confirm-actions" });
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

class VaultTextAdapter implements TextFileAdapter {
  constructor(private readonly vault: Vault) {}

  exists(path: string): Promise<boolean> {
    return this.vault.adapter.exists(normalizePath(path));
  }

  read(path: string): Promise<string> {
    return this.vault.adapter.read(normalizePath(path));
  }

  async write(path: string, contents: string): Promise<void> {
    const normalized = normalizePath(path);
    await ensureFolder(this.vault, parentPath(normalized));
    await this.vault.adapter.write(normalized, contents);
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (await this.vault.adapter.exists(normalized)) await this.vault.adapter.remove(normalized);
  }
}

class VaultBinaryAdapter implements BinaryFileAdapter {
  constructor(private readonly vault: Vault) {}

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.vault.adapter.readBinary(normalizePath(path)));
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    await ensureFolder(this.vault, parentPath(normalized));
    await this.vault.adapter.writeBinary(normalized, bytes.slice().buffer);
  }

  async copy(from: string, to: string): Promise<void> {
    await this.write(to, await this.read(from));
  }

  async replace(from: string, to: string): Promise<void> {
    await this.vault.adapter.rename(normalizePath(from), normalizePath(to));
  }

  async remove(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (await this.vault.adapter.exists(normalized)) await this.vault.adapter.remove(normalized);
  }
}

function parentPath(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

async function ensureFolder(vault: Vault, path: string): Promise<void> {
  if (!path) return;
  let current = "";
  for (const part of normalizePath(path).split("/")) {
    current = current ? `${current}/${part}` : part;
    if (!await vault.adapter.exists(current)) await vault.adapter.mkdir(current);
  }
}

export default class NativePdfInkPlugin extends Plugin {
  settings: PluginSettings = mergeSettings(undefined);
  private readonly sessions = new Map<WorkspaceLeaf, ViewerInkSession>();
  private scanTimer: number | null = null;
  private unloaded = false;

  async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData() as Partial<PluginSettings> | null);
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
    this.addCommand({
      id: "toggle-active-pdf-ink-debug",
      name: "Toggle active PDF ink debug information",
      callback: () => this.activeSession()?.toggleDebug()
    });

    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleDebouncedScan()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      for (const [leaf, session] of this.sessions) {
        if (leaf !== this.app.workspace.activeLeaf) void session.flush();
      }
      this.scheduleDebouncedScan();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      for (const session of this.sessions.values()) void session.flush();
      this.scheduleDebouncedScan();
    }));
    this.app.workspace.onLayoutReady(() => this.scheduleDebouncedScan());
    this.registerDomEvent(window, "beforeunload", () => {
      for (const session of this.sessions.values()) void session.flush();
    });
  }

  onunload(): void {
    this.unloaded = true;
    if (this.scanTimer !== null) {
      window.clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    for (const session of this.sessions.values()) void session.destroy();
    this.sessions.clear();
  }

  async saveSettings(settings: PluginSettings): Promise<void> {
    this.settings = settings;
    await this.saveData(settings);
  }

  private scheduleDebouncedScan(delayMs = 100): void {
    if (this.scanTimer !== null || this.unloaded) return;
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = null;
      void this.scanPdfViews();
    }, delayMs);
  }

  private async scanPdfViews(): Promise<void> {
    if (this.unloaded) return;
    const leaves = this.app.workspace.getLeavesOfType("pdf");
    const live = new Set(leaves);
    for (const [leaf, session] of [...this.sessions]) {
      if (live.has(leaf)) continue;
      this.sessions.delete(leaf);
      void session.destroy();
    }

    for (const leaf of leaves) {
      if (this.sessions.has(leaf)) continue;
      const view = leaf.view;
      const file = view instanceof FileView ? view.file : (view as FileView).file;
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") continue;
      let session: ViewerInkSession | undefined;
      try {
        const adapter = NativePdfViewAdapter.attach(view.containerEl, {
          onPagesChanged: () => session?.refresh(),
          onViewStateChange: () => session?.refresh(),
          onCompatibilityWarning: (message) => console.warn(`[Native PDF Ink] ${message}`)
        });
        const textFiles = new VaultTextAdapter(this.app.vault);
        session = await ViewerInkSession.create({
          adapter,
          pdfPath: file.path,
          settings: this.settings,
          sidecars: new SidecarRepository(textFiles, this.settings.sidecarFolder),
          recovery: new RecoveryRepository(textFiles, `${this.settings.sidecarFolder}/recovery`),
          saveSettings: async (preferences) => this.saveToolPreferences(preferences),
          readSourcePdf: async () => new Uint8Array(await this.app.vault.readBinary(file)),
          writeExport: async (name, bytes) => this.writeExport(file, name, bytes),
          commitOriginal: async (bytes) => this.commitOriginal(file, bytes),
          openSettings: () => new Notice("Open Settings, then Native PDF Ink."),
          notice: (message) => new Notice(message),
          decideUnsaved: () => this.decideUnsaved()
        });
        this.sessions.set(leaf, session);
      } catch (error) {
        console.warn("[Native PDF Ink] PDF view not ready or incompatible", error);
        this.scheduleDebouncedScan(500);
      }
    }
  }

  private activeSession(): ViewerInkSession | undefined {
    const leaf = this.app.workspace.activeLeaf;
    return leaf ? this.sessions.get(leaf) : undefined;
  }

  private async saveToolPreferences(preferences: ToolPreferences): Promise<void> {
    this.settings = {
      ...this.settings,
      toolPreferences: structuredClone(preferences)
    };
    await this.saveData(this.settings);
  }

  private async writeExport(source: TFile, name: string, bytes: Uint8Array): Promise<void> {
    const folder = source.parent?.path ?? "";
    const stem = name.replace(/\.pdf$/i, "");
    let path = normalizePath(folder ? `${folder}/${name}` : name);
    let suffix = 2;
    while (await this.app.vault.adapter.exists(path)) {
      path = normalizePath(folder ? `${folder}/${stem}-${suffix}.pdf` : `${stem}-${suffix}.pdf`);
      suffix += 1;
    }
    await this.app.vault.createBinary(path, bytes.slice().buffer);
  }

  private async commitOriginal(file: TFile, bytes: Uint8Array): Promise<void> {
    if (!this.settings.yoloMode || !this.settings.yoloConfirmed) {
      throw new Error("YOLO Mode is not enabled and confirmed");
    }
    const backupName = `${file.basename}-${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`;
    const backupPath = normalizePath(`${this.settings.backupLocation}/${backupName}`);
    const binary = new VaultBinaryAdapter(this.app.vault);
    const validator = new PdfExportService();
    const transaction = new DirectPdfWriteTransaction(binary, (candidate) => validator.validate(candidate));
    await transaction.commit(file.path, bytes, {
      confirmed: true,
      createBackup: this.settings.createBackupBeforeDirectModification,
      backupPath,
      retainSidecar: this.settings.retainSidecarAfterDirectModification
    });
  }

  private decideUnsaved(): Promise<CloseChoice> {
    return new Promise((resolve) => new UnsavedChangesModal(this.app, resolve).open());
  }
}
