export interface PanState { x: number; y: number; active: boolean }

export class PanTool {
  private state: PanState = { x: 0, y: 0, active: false };
  begin(x: number, y: number): void { this.state = { x, y, active: true }; }
  move(x: number, y: number): { dx: number; dy: number } {
    if (!this.state.active) return { dx: 0, dy: 0 };
    const delta = { dx: x - this.state.x, dy: y - this.state.y };
    this.state = { x, y, active: true };
    return delta;
  }
  end(): void { this.state.active = false; }
  isActive(): boolean { return this.state.active; }
}
