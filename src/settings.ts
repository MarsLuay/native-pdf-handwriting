import { FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, mergeSettings, serializePluginSettings, type PluginSettings } from "./model";

export { mergeSettings, DEFAULT_SETTINGS };

export interface SettingsHost {
  settings: PluginSettings;
  saveSettings(settings: PluginSettings): Promise<void>;
}

class FolderPicker extends FuzzySuggestModal<string> {
  constructor(
    app: ConstructorParameters<typeof PluginSettingTab>[0],
    private readonly folders: string[],
    private readonly onChoose: (path: string) => void
  ) {
    super(app);
    this.setPlaceholder("Choose a vault folder");
  }

  getItems(): string[] {
    return this.folders;
  }

  getItemText(path: string): string {
    return path || "Vault root";
  }

  onChooseItem(path: string): void {
    this.onChoose(path);
  }
}

export class NativePdfInkSettingTab extends PluginSettingTab {
  constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], private readonly host: Plugin & SettingsHost) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("p", {
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- Preserve the PDF acronym and Apple Pencil brand name.
      text: "PDF handwriting. Use your Apple Pencil/stylus to write in PDFs natively as the higher powers intended."
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

    const textEscapeBehavior = this.host.settings.skipTextCancelConfirmation
      ? this.host.settings.textEscapeAction ?? "discard"
      : "ask";
    new Setting(containerEl)
      .setName("Text editor Escape key")
      .setDesc("Choose whether Escape asks, saves the current text annotation, or discards it. Ctrl/Cmd+Enter always saves text.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ask", "Always ask")
          .addOption("save", "Save text")
          .addOption("discard", "Discard text")
          .setValue(textEscapeBehavior)
          .onChange(async (value) => {
            if (value === "save" || value === "discard") {
              await this.persistPatch({ skipTextCancelConfirmation: true, textEscapeAction: value });
            } else if (value === "ask") {
              await this.persistPatch({ skipTextCancelConfirmation: false, textEscapeAction: null });
            }
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
      .setName("Treat single touch as")
      .setDesc("None blocks one-finger input. Touch scrolls the PDF. Stylus sends one finger to the selected annotation tool while Draw is enabled.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("none", "None")
          .addOption("touch", "Touch")
          .addOption("stylus", "Stylus")
          .setValue(this.host.settings.singleTouchMode)
          .onChange(async (value) => {
            if (value === "none" || value === "touch" || value === "stylus") {
              await this.persistPatch({ singleTouchMode: value });
            }
          })
      );

    new Setting(containerEl)
      .setName("Allow two-finger pinch zoom")
      .setDesc("Zoom when two fingers change distance. The gesture is classified once, so it does not also scroll the PDF. Enabled by default.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.twoFingerPinchZoom).onChange(async (value) => {
          await this.persistPatch({ twoFingerPinchZoom: value });
        })
      );

    new Setting(containerEl)
      .setName("Allow two-finger swipe scroll")
      .setDesc("Scroll horizontally or vertically with two fingers moving in parallel. Distance changes use pinch zoom instead. Enabled by default.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.twoFingerSwipeScroll).onChange(async (value) => {
          await this.persistPatch({ twoFingerSwipeScroll: value });
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
      .setDesc("Reduce unnecessary points when you release a stroke for a cleaner path. Turn it off to keep every sampled point.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.simplifyStrokes).onChange(async (value) => {
          await this.persistPatch({ simplifyStrokes: value });
        })
      );

    new Setting(containerEl)
      .setName("Hold to straighten strokes")
      .setDesc("Pause at the last point for one second, then release to convert the current stroke into a straight line. Moving the pen restarts the hold.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.holdToStraighten).onChange(async (value) => {
          await this.persistPatch({ holdToStraighten: value });
        })
      );

    new Setting(containerEl)
      .setName("Hide stylus annotation label")
      .setDesc("Remove the accessible page label from each ink canvas. Keep it enabled when screen-reader context is useful.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.hideStylusAnnotationLabel).onChange(async (value) => {
          await this.persistPatch({ hideStylusAnnotationLabel: value });
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

    new Setting(containerEl)
      .setName("Annotation sidecar folder")
      .setDesc("Vault-relative folder for editable annotation JSON. The original PDF is never changed; Export PDF creates a separate copy. New PDF views use this location after saving the setting.")
      .then((setting) => this.addFolderPathInput(setting, {
        value: this.host.settings.sidecarFolder,
        persist: async (sidecarFolder) => this.persistPatch({ sidecarFolder }),
        selectedPath: (folder) => folder
      }));

    new Setting(containerEl).setName("Developer").setHeading();
    new Setting(containerEl)
      .setName("Vault debug log")
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- Preserve the plugin name and NDJSON acronym.
      .setDesc("Append every Handwriting Natively event to a vault NDJSON log file so agents can read it directly. Off by default.")
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.vaultDebugLog).onChange(async (value) => {
          await this.persistPatch({ vaultDebugLog: value });
        })
      );

    new Setting(containerEl)
      .setName("Vault debug log path")
      .setDesc("Relative vault path for the log file. One JSON object per line.")
      .then((setting) => this.addFolderPathInput(setting, {
        value: this.host.settings.vaultDebugLogPath,
        persist: async (vaultDebugLogPath) => this.persistPatch({ vaultDebugLogPath }),
        selectedPath: (folder) => folder ? `${folder}/debug.log` : "debug.log"
      }));

    new Setting(containerEl)
      .setName("Copy all settings")
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- Preserve the Handwriting Natively plugin name.
      .setDesc("Copy every Handwriting Natively setting as readable JSON.")
      .addButton((button) =>
        button.setButtonText("Copy all").onClick(async () => {
          try {
            await navigator.clipboard.writeText(serializePluginSettings(this.host.settings));
            // eslint-disable-next-line obsidianmd/ui/sentence-case -- Preserve the Handwriting Natively plugin name.
            new Notice("All Handwriting Natively settings copied.");
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
      // eslint-disable-next-line obsidianmd/ui/sentence-case -- Buy Me a Coffee is a brand name.
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

  private addFolderPathInput(
    setting: Setting,
    options: { value: string; persist: (value: string) => Promise<void>; selectedPath: (folder: string) => string }
  ): void {
    let input: HTMLInputElement | null = null;
    setting.addText((text) => {
      input = text.inputEl;
      text.setValue(options.value).onChange(async (value) => {
        await options.persist(value.trim());
      });
    });
    setting.addExtraButton((button) =>
      button.setIcon("x").setTooltip("Clear path").onClick(async () => {
        if (!input) return;
        input.value = "";
        await options.persist("");
      })
    );
    setting.addExtraButton((button) =>
      button.setIcon("search").setTooltip("Choose vault folder").onClick(() => {
        new FolderPicker(this.app, this.vaultFolders(), (folder) => {
          const selected = options.selectedPath(folder);
          if (input) input.value = selected;
          void options.persist(selected);
        }).open();
      })
    );
  }

  private vaultFolders(): string[] {
    const folders = this.app.vault.getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder)
      .map((folder) => folder.path);
    return ["", ...folders].sort((left, right) => left.localeCompare(right));
  }

  private async persistPatch(patch: Partial<PluginSettings>): Promise<void> {
    // Do not assign host.settings before saveSettings — it compares previous placement to remount open PDFs.
    await this.host.saveSettings({ ...this.host.settings, ...patch });
  }
}
