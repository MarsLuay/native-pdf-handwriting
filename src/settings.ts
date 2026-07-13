import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS, serializePluginSettings, type PluginSettings } from "./model";

export interface SettingsHost {
  app: App;
  settings: PluginSettings;
  saveSettings(settings: PluginSettings): Promise<void>;
}

export function mergeSettings(saved: Partial<PluginSettings> | null | undefined): PluginSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    toolPreferences: {
      ...DEFAULT_SETTINGS.toolPreferences,
      ...saved?.toolPreferences,
      pen: { ...DEFAULT_SETTINGS.toolPreferences.pen, ...saved?.toolPreferences?.pen },
      pencil: { ...DEFAULT_SETTINGS.toolPreferences.pencil, ...saved?.toolPreferences?.pencil },
      eraser: { ...DEFAULT_SETTINGS.toolPreferences.eraser, ...saved?.toolPreferences?.eraser },
      lasso: { ...DEFAULT_SETTINGS.toolPreferences.lasso, ...saved?.toolPreferences?.lasso }
    }
  };
}

class YoloConfirmationModal extends Modal {
  private readonly abort = new AbortController();
  constructor(app: App, private readonly onConfirm: () => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Enable YOLO Mode?");
    this.contentEl.createEl("p", {
      text: "YOLO Mode modifies the original PDF. Changes may not be reversible outside this plugin. PDF corruption, incomplete writes, and sync conflicts are possible. Keep backups or file history enabled."
    });
    const actions = this.contentEl.createDiv({ cls: "native-pdf-ink-confirm-actions" });
    const cancel = actions.createEl("button", { text: "Keep originals safe" });
    const confirm = actions.createEl("button", {
      text: "I understand — enable YOLO Mode",
      cls: "mod-warning"
    });
    cancel.addEventListener("click", () => this.close(), { signal: this.abort.signal });
    confirm.addEventListener("click", () => {
      void this.onConfirm()
        .then(() => this.close())
        .catch((error) => {
          console.error("Native PDF Ink could not enable YOLO Mode", error);
          new Notice("Could not enable YOLO Mode. Your original PDF remains unchanged.");
        });
    }, { signal: this.abort.signal });
  }

  onClose(): void {
    this.abort.abort();
    this.contentEl.empty();
  }
}

export class NativePdfInkSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: SettingsHost) {
    super(app, host as never);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Native PDF Ink" });
    containerEl.createEl("p", {
      text: "Annotations stay local in an editable sidecar. Your original PDF remains unchanged unless you explicitly enable YOLO Mode."
    });

    new Setting(containerEl)
      .setName("Autosave")
      .setDesc("Save completed edits automatically. Enabled by default.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.autosave).onChange(async (value) => {
          await this.persistPatch({ autosave: value });
        })
      );

    const autosaveDelaySetting = new Setting(containerEl)
      .setName("Autosave delay")
      .setDesc("Wait 100–60,000 milliseconds after an edit before saving the sidecar.");
    this.addDelayInput(autosaveDelaySetting, {
      descriptionId: "native-pdf-ink-autosave-delay-description",
      value: this.host.settings.autosaveDelayMs,
      min: 100,
      max: 60_000,
      persist: async (autosaveDelayMs) => this.persistPatch({ autosaveDelayMs })
    });

    new Setting(containerEl)
      .setName("Save when closing a PDF")
      .setDesc("Flush pending autosaves before a PDF view closes.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.saveWhenClosing).onChange(async (value) => {
          await this.persistPatch({ saveWhenClosing: value });
        })
      );

    new Setting(containerEl)
      .setName("Show save-status indicator")
      .setDesc("Show whether the current PDF is saved, saving, or needs attention.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.showSaveStatus).onChange(async (value) => {
          await this.persistPatch({ showSaveStatus: value });
        })
      );

    new Setting(containerEl)
      .setName("Retry failed autosaves")
      .setDesc("Try saving again after an automatic save fails.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.retryFailedAutosaves).onChange(async (value) => {
          await this.persistPatch({ retryFailedAutosaves: value });
        })
      );

    containerEl.createEl("h3", { text: "Direct PDF modification" });
    new Setting(containerEl)
      .setName("YOLO Mode")
      .setDesc("Dangerous: write committed annotations into the original PDF. Off by default.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.yoloMode).onChange(async (value) => {
          if (!value) {
            await this.persistPatch({ yoloMode: false });
            return;
          }
          if (this.host.settings.yoloConfirmed) {
            await this.persistPatch({ yoloMode: true });
            return;
          }
          toggle.setValue(false);
          new YoloConfirmationModal(this.app, async () => {
            await this.persistPatch({ yoloMode: true, yoloConfirmed: true });
            new Notice("YOLO Mode enabled. Backups remain on by default.");
            this.display();
          }).open();
        })
      );

    const yoloDelaySetting = new Setting(containerEl)
      .setName("YOLO Mode autosave delay")
      .setDesc("Wait 500–300,000 milliseconds to batch direct PDF rewrites.");
    this.addDelayInput(yoloDelaySetting, {
      descriptionId: "native-pdf-ink-yolo-delay-description",
      value: this.host.settings.yoloAutosaveDelayMs,
      min: 500,
      max: 300_000,
      persist: async (yoloAutosaveDelayMs) => this.persistPatch({ yoloAutosaveDelayMs })
    });

    new Setting(containerEl)
      .setName("Create backup before direct modification")
      .setDesc("Enabled by default, including before first YOLO Mode write.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.host.settings.createBackupBeforeDirectModification)
          .onChange(async (value) => {
            await this.persistPatch({ createBackupBeforeDirectModification: value });
          })
      );

    new Setting(containerEl)
      .setName("Backup location")
      .setDesc("Vault folder used for backups before YOLO Mode changes the original PDF.")
      .addText((text) =>
        text.setValue(this.host.settings.backupLocation).onChange(async (value) => {
          if (value.trim()) await this.persistPatch({ backupLocation: value.trim() });
        })
      );

    new Setting(containerEl)
      .setName("Retain sidecar after direct modification")
      .setDesc("Keep editable strokes and recovery data after the PDF write succeeds.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.retainSidecarAfterDirectModification).onChange(async (value) => {
          await this.persistPatch({ retainSidecarAfterDirectModification: value });
        })
      );

    new Setting(containerEl)
      .setName("Copy all settings")
      .setDesc("Copy every Native PDF Ink setting as readable JSON.")
      .addButton((button) =>
        button.setButtonText("Copy all").onClick(async () => {
          try {
            await navigator.clipboard.writeText(serializePluginSettings(this.host.settings));
            new Notice("All Native PDF Ink settings copied.");
          } catch (error) {
            console.error("Native PDF Ink could not copy settings", error);
            new Notice("Could not copy settings. Check clipboard permission and try again.");
          }
        })
      );

    const supportLinks = containerEl.createDiv({ cls: "native-pdf-ink-support-links" });
    supportLinks.createEl("a", {
      cls: "native-pdf-ink-support-link",
      text: "Report bug",
      attr: {
        href: "https://github.com/MarsLuay/obsidian-native-pdf-ink/issues",
        rel: "noopener noreferrer",
        target: "_blank"
      }
    });
    supportLinks.createEl("a", {
      cls: "native-pdf-ink-support-link",
      text: "Buy Me a Coffee",
      attr: {
        href: "https://buymeacoffee.com/marwanluaye",
        rel: "noopener noreferrer",
        target: "_blank"
      }
    });
  }

  private addDelayInput(
    setting: Setting,
    options: {
      descriptionId: string;
      value: number;
      min: number;
      max: number;
      persist: (value: number) => Promise<void>;
    }
  ): void {
    setting.descEl.id = options.descriptionId;
    setting.addText((text) => {
      const readValidDelay = (value: string): number | null => {
        const delay = Number(value);
        const valid = Number.isFinite(delay) && delay >= options.min && delay <= options.max;
        text.inputEl.setAttribute("aria-invalid", String(!valid));
        return valid ? Math.round(delay) : null;
      };
      text.inputEl.setAttribute("aria-describedby", options.descriptionId);
      text.inputEl.setAttribute("inputmode", "numeric");
      text.setValue(String(options.value));
      readValidDelay(String(options.value));
      text.onChange(async (value) => {
        const delay = readValidDelay(value);
        if (delay !== null) await options.persist(delay);
      });
    });
  }

  private async persistPatch(patch: Partial<PluginSettings>): Promise<void> {
    this.host.settings = { ...this.host.settings, ...patch };
    await this.host.saveSettings(this.host.settings);
  }
}
