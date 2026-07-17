import { FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TFolder } from "obsidian";
import { DEFAULT_SETTINGS, mergeSettings, type PluginSettings } from "./model";

export { mergeSettings, DEFAULT_SETTINGS };

export interface SettingsHost {
  settings: PluginSettings;
  saveSettings(settings: PluginSettings): Promise<void>;
  readAllLogs(): Promise<string | null>;
}

/** Vault-only picker used for paths that must never escape the current vault. */
class FolderPicker extends FuzzySuggestModal<string> {
  constructor(
    app: ConstructorParameters<typeof PluginSettingTab>[0],
    private readonly folders: readonly string[],
    private readonly onChoose: (path: string) => void
  ) {
    super(app);
    this.setPlaceholder("Choose a vault folder");
  }

  getItems(): string[] {
    return [...this.folders];
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

  /**
   * Obsidian 1.13+ settings search + declarative render. Uses `render` (not
   * `control.key`) so changes still go through {@link persistPatch} / host
   * `saveSettings` (toolbar remount + boosted zoom). With
   * `minAppVersion` ≥ 1.13.0, do not keep a leftover `display()` — Obsidian
   * bypasses it once this method exists.
   */
  getSettingDefinitions() {
    return [
      {
        name: "About",
        desc: "PDF handwriting for a stylus or mouse. Write directly in the document view while keeping the original file untouched.",
        searchable: false
      },
      {
        name: "Autosave",
        desc: "Save completed edits automatically. Enabled by default.",
        render: (setting: Setting) => {
          setting.addToggle((toggle) =>
            toggle.setValue(this.host.settings.autosave).onChange(async (value) => {
              await this.persistPatch({ autosave: value });
            })
          );
        }
      },
      {
        name: "Autosave delay",
        desc: "Wait 100–60,000 milliseconds after an edit before saving the sidecar.",
        render: (setting: Setting) => {
          this.addDelayInput(setting, {
            descriptionId: "native-pdf-handwriting-autosave-delay-description",
            value: this.host.settings.autosaveDelayMs,
            min: 100,
            max: 60_000,
            persist: async (autosaveDelayMs) => this.persistPatch({ autosaveDelayMs })
          });
        }
      },
      {
        name: "Save when closing a PDF",
        desc: "Flush pending autosaves before a PDF view closes.",
        render: (setting: Setting) => {
          setting.addToggle((toggle) =>
            toggle.setValue(this.host.settings.saveWhenClosing).onChange(async (value) => {
              await this.persistPatch({ saveWhenClosing: value });
            })
          );
        }
      },
      {
        name: "Show save-status indicator",
        desc: "Show whether the current PDF is saved, saving, or needs attention.",
        render: (setting: Setting) => {
          setting.addToggle((toggle) =>
            toggle.setValue(this.host.settings.showSaveStatus).onChange(async (value) => {
              await this.persistPatch({ showSaveStatus: value });
            })
          );
        }
      },
      {
        type: "group" as const,
        heading: "PDF navigation",
        items: [
          {
            name: "Drag to scroll when draw mode is off",
            desc: "Vertical mouse drag on empty PDF areas scrolls the document. Text selection and links still work normally.",
            render: (setting: Setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.host.settings.mouseDragScroll).onChange(async (value) => {
                  await this.persistPatch({ mouseDragScroll: value });
                })
              );
            }
          },
          {
            name: "Ink toolbar placement",
            desc: "Put the ink controls on the PDF toolbar, or as a left/right sidebar beside the pages.",
            render: (setting: Setting) => {
              setting.addDropdown((dropdown) =>
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
            }
          }
        ]
      },
      {
        type: "group" as const,
        heading: "Drawing",
        items: [
          {
            name: "Simplify strokes on release",
            desc: "Snap finished ink to cleaner straight segments. Off keeps the exact path you drew.",
            render: (setting: Setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.host.settings.simplifyStrokes).onChange(async (value) => {
                  await this.persistPatch({ simplifyStrokes: value });
                })
              );
            }
          },
          {
            name: "Retry failed autosaves",
            desc: "Try saving again after an automatic save fails.",
            render: (setting: Setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.host.settings.retryFailedAutosaves).onChange(async (value) => {
                  await this.persistPatch({ retryFailedAutosaves: value });
                })
              );
            }
          }
        ]
      },
      {
        type: "group" as const,
        heading: "Storage",
        items: [
          {
            name: "Annotation sidecar folder",
            desc: "Vault-relative folder for editable annotation JSON. The original PDF is never changed; export creates a separate copy.",
            render: (setting: Setting) => {
              this.addFolderPathInput(setting, {
                value: this.host.settings.sidecarFolder,
                persist: async (sidecarFolder) => this.persistPatch({ sidecarFolder })
              });
            }
          }
        ]
      },
      {
        type: "group" as const,
        heading: "Advanced settings",
        items: [
          {
            name: "Allow 25× PDF zoom",
            desc: "Increase the PDF viewer zoom limit beyond Obsidian's normal 10× cap. This can use substantially more memory on large pdfs.",
            render: (setting: Setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.host.settings.boostedPdfZoom).onChange(async (value) => {
                  await this.persistPatch({ boostedPdfZoom: value });
                })
              );
            }
          },
          {
            name: "Hide stylus annotation label",
            desc: "Remove the invisible page label announced to screen readers when the annotation canvas is focused.",
            render: (setting: Setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.host.settings.hideStylusAnnotationLabel).onChange(async (value) => {
                  await this.persistPatch({ hideStylusAnnotationLabel: value });
                })
              );
            }
          },
          {
            name: "Vault debug log",
            desc: "Append every plugin event to a line-delimited log file in the vault so agents can read it directly. Off by default. Includes left-toolbar PDF sidebar offset diagnostics (reason, rects, jumps).",
            render: (setting: Setting) => {
              setting.addToggle((toggle) =>
                toggle.setValue(this.host.settings.vaultDebugLog).onChange(async (value) => {
                  await this.persistPatch({ vaultDebugLog: value });
                })
              );
            }
          },
          {
            name: "Vault debug log path",
            desc: "Vault-relative location for the optional debug log. One JSON object per line.",
            render: (setting: Setting) => {
              this.addFolderPathInput(setting, {
                value: this.host.settings.vaultDebugLogPath,
                persist: async (vaultDebugLogPath) => this.persistPatch({ vaultDebugLogPath }),
                fileName: "debug.log"
              });
            }
          },
          {
            name: "Copy all logs",
            desc: "Copy the complete vault debug log. Enable vault debug log and reproduce an issue first to capture new events.",
            render: (setting: Setting) => {
              setting.addButton((button) =>
                button.setButtonText("Copy logs").onClick(async () => {
                  try {
                    const logs = await this.host.readAllLogs();
                    if (!logs) {
                      new Notice("No vault debug logs are available. Enable vault debug log and reproduce the issue first.");
                      return;
                    }
                    await navigator.clipboard.writeText(logs);
                    new Notice("All debug logs copied.");
                  } catch (error) {
                    console.error("Handwriting Natively could not copy logs", error);
                    new Notice("Could not copy logs. Check clipboard permission and try again.");
                  }
                })
              );
            }
          }
        ]
      },
      {
        name: "Support",
        searchable: false,
        render: (setting: Setting) => {
          const supportLinks = setting.controlEl.createDiv({ cls: "native-pdf-handwriting-support-links" });
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
      }
    ];
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
    options: {
      value: string;
      persist: (value: string) => Promise<void>;
      fileName?: string;
    }
  ): void {
    let input: HTMLInputElement | null = null;
    setting.addText((text) => {
      input = text.inputEl;
      text.setValue(options.value).onChange(async (value) => {
        await options.persist(value.trim());
      });
    });
    setting.addExtraButton((button) =>
      button.setIcon("search").setTooltip("Choose vault folder").onClick(() => {
        new FolderPicker(this.app, this.vaultFolders(), (folder) => {
          const selected = options.fileName
            ? folder ? `${folder}/${options.fileName}` : options.fileName
            : folder;
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
