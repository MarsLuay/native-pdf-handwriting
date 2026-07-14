export interface Command {
  readonly label?: string;
  execute(): void;
  undo(): void;
}

export class CommandHistory {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  constructor(private readonly changed?: () => void) {}

  execute(command: Command): void { command.execute(); this.undoStack.push(command); this.redoStack = []; this.changed?.(); }
  undo(): boolean {
    const command = this.undoStack.pop(); if (!command) return false;
    command.undo(); this.redoStack.push(command); this.changed?.(); return true;
  }
  redo(): boolean {
    const command = this.redoStack.pop(); if (!command) return false;
    command.execute(); this.undoStack.push(command); this.changed?.(); return true;
  }
  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
  clear(): void { this.undoStack = []; this.redoStack = []; }
}

