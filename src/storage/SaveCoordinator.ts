export type CloseChoice = "save" | "discard" | "cancel";
export type CloseDecision = "close" | "prompt";

export interface SaveCoordinatorOptions {
  autosave: boolean;
  saveWhenClosing: boolean;
  save(): Promise<void>;
  scheduleAutosave?: () => void;
  discard?(): Promise<void> | void;
}

export class SaveCoordinator {
  private dirty = false;
  constructor(private readonly options: SaveCoordinatorOptions) {}

  markDirty(): void { this.dirty = true; }
  markSaved(): void { this.dirty = false; }
  hasUnsavedChanges(): boolean { return this.dirty; }

  completedCommand(): void {
    this.markDirty();
    if (!this.options.autosave) return;
    if (this.options.scheduleAutosave) this.options.scheduleAutosave();
    else void this.options.save().then(() => this.markSaved()).catch(() => undefined);
  }

  async manualSave(): Promise<void> { await this.options.save(); this.markSaved(); }

  closeDecision(): CloseDecision {
    if (!this.dirty) return "close";
    if (this.options.autosave && this.options.saveWhenClosing) return "close";
    return "prompt";
  }

  async prepareClose(choice?: CloseChoice): Promise<boolean> {
    if (!this.dirty) return true;
    if (this.options.autosave && this.options.saveWhenClosing) { await this.manualSave(); return true; }
    if (!choice || choice === "cancel") return false;
    if (choice === "save") { await this.manualSave(); return true; }
    await this.options.discard?.();
    this.dirty = false;
    return true;
  }
}
