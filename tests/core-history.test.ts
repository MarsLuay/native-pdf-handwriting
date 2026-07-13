import { describe, expect, it, vi } from "vitest";
import type { InkStroke } from "../src/model";
import { InkSession } from "../src/ink/InkSession";
import { AddStrokeCommand, DeleteStrokesCommand, ReplaceStrokesCommand, translateStrokes } from "../src/history/AnnotationCommands";
import { CommandHistory } from "../src/history/CommandHistory";

const stroke: InkStroke = { id: "s", page: 1, tool: "pen", color: "#000000", width: 2, opacity: 1, inputType: "pen", points: [{ x: 1, y: 2, pressure: 1, time: 0 }], createdAt: "now", updatedAt: "now" };

describe("annotation command history", () => {
  it("undoes and redoes add, delete, and transform commands", () => {
    const changed = vi.fn(); const session = new InkSession(); const history = new CommandHistory(changed);
    history.execute(new AddStrokeCommand(session, stroke));
    expect(session.all()).toHaveLength(1);
    history.undo(); expect(session.all()).toHaveLength(0);
    history.redo(); expect(session.all()).toHaveLength(1);
    const moved = translateStrokes([stroke], 3, 4, "later");
    history.execute(new ReplaceStrokesCommand(session, [stroke], moved));
    expect(session.all()[0]?.points[0]).toMatchObject({ x: 4, y: 6 });
    history.undo(); expect(session.all()[0]?.points[0]).toMatchObject({ x: 1, y: 2 });
    history.execute(new DeleteStrokesCommand(session, [stroke]));
    expect(session.all()).toHaveLength(0); history.undo(); expect(session.all()).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(7);
  });
});
