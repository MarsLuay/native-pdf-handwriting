import { Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS, mergeSettings, serializePluginSettings, type PluginSettings } from "./model";

export { mergeSettings, DEFAULT_SETTINGS };

export interface SettingsHost {
  settings: PluginSettings;
  saveSettings(settings: PluginSettings): Promise<void>;
}

export class NativePdfInkSettingTab extends PluginSettingTab {
  constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], private readonly host: Plugin & SettingsHost) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      text: "PDF handwriting for a stylus or mouse. Write directly in the document view while keeping the original file untouched."
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
      descriptionId: "native-pdf-handwriting-autosave-delay-description",
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

    new Setting(containerEl).setName("PDF navigation").setHeading();
    new Setting(containerEl)
      .setName("Drag to scroll when draw mode is off")
      .setDesc("Vertical mouse drag on empty PDF areas scrolls the document. Text selection and links still work normally.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.mouseDragScroll).onChange(async (value) => {
          await this.persistPatch({ mouseDragScroll: value });
        })
      );

    new Setting(containerEl)
      .setName("Ink toolbar placement")
      .setDesc("Put the ink controls on the PDF toolbar, or as a left/right sidebar beside the pages.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("main", "PDF toolbar (default)")
          .addOption("left", "Left sidebar")
          .addOption("right", "Right sidebar")
          .setValue(this.host.settings.toolbarPlacement)
          .onChange(async (value) => {
            if (value === "main" || value === "left" || value === "right") {
              await this.persistPatch({ toolbarPlacement: value });
            }
          })
      );

    new Setting(containerEl).setName("Drawing").setHeading();
    new Setting(containerEl)
      .setName("Simplify strokes on release")
      .setDesc("Snap finished ink to cleaner straight segments. Off keeps the exact path you drew.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.simplifyStrokes).onChange(async (value) => {
          await this.persistPatch({ simplifyStrokes: value });
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

    new Setting(containerEl).setName("Developer").setHeading();
    new Setting(containerEl)
      .setName("Vault debug log")
      .setDesc("Append every plugin event to a line-delimited log file in the vault so agents can read it directly. Off by default. Includes left-toolbar PDF sidebar offset diagnostics (reason, rects, jumps).")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.vaultDebugLog).onChange(async (value) => {
          await this.persistPatch({ vaultDebugLog: value });
        })
      );

    new Setting(containerEl)
      .setName("Vault debug log path")
      .setDesc("Relative vault path for the log file. One JSON object per line.")
      .addText((text) =>
        text.setValue(this.host.settings.vaultDebugLogPath).onChange(async (value) => {
          if (value.trim()) await this.persistPatch({ vaultDebugLogPath: value.trim() });
        })
      );

    new Setting(containerEl)
      .setName("Copy all settings")
      .setDesc("Copy every plugin setting in a structured, readable format.")
      .addButton((button) =>
        button.setButtonText("Copy all").onClick(async () => {
          try {
            await navigator.clipboard.writeText(serializePluginSettings(this.host.settings));
            new Notice("All plugin settings copied.");
          } catch (error) {
            console.error("Handwriting Natively could not copy settings", error);
            new Notice("Could not copy settings. Check clipboard permission and try again.");
          }
        })
      );

    const supportLinks = containerEl.createDiv({ cls: "native-pdf-handwriting-support-links" });
    supportLinks.createEl("a", {
      cls: "native-pdf-handwriting-support-link",
      text: "Report bug",
      attr: {
        href: "https://github.com/MarsLuay/handwriting-natively/issues",
        rel: "noopener noreferrer",
        target: "_blank"
      }
    });
    supportLinks.createEl("a", {
      cls: "native-pdf-handwriting-support-link",
      text: "Buy me a coffee",
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
    // Do not assign host.settings before saveSettings — it compares previous placement to remount open PDFs.
    await this.host.saveSettings({ ...this.host.settings, ...patch });
  }
}
