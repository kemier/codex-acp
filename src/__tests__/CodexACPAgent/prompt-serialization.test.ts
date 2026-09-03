import {describe, expect, it} from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * One turn per session.
 *
 * A client may send another prompt while a turn is still running: vscode-acp
 * force-ends a turn locally when its cancel goes unacknowledged for 5s and then
 * drains its queue. prompt() reset sessionState.currentTurnId unconditionally,
 * which orphaned the previous turn — currentTurnId is what cancel() and steer()
 * resolve against, so the old turn kept streaming with nothing able to stop it.
 *
 * The same defect in ericli let two tool loops interleave into one history
 * (session 772c8501: prompt id=6 ran 18 minutes while ids 7 and 8 ran inside it).
 * There the second prompt overwrote the abort controller; here it overwrites the
 * turn id.
 */
describe("prompt serialization", () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, "../../CodexAcpServer.ts"),
        "utf8",
    );

    it("interrupts a running turn before resetting the turn id", () => {
        const guard = source.indexOf('await this.interruptSessionTurn(sessionState, "New prompt", true)');
        expect(guard).toBeGreaterThan(0);
        // Must be guarded — interrupting when idle would log a spurious request.
        const before = source.slice(guard - 200, guard);
        expect(before).toContain("if (sessionState.currentTurnId)");
        // And must run BEFORE the reset that would orphan it.
        const reset = source.indexOf("sessionState.currentTurnId = null;", guard);
        expect(reset).toBeGreaterThan(guard);
    });

    it("declares the interrupt reason so the log names it", () => {
        expect(source).toContain('"Cancel" | "Close" | "Plan mode switch" | "New prompt"');
    });

    it("still resolves the interrupted turn, so its promise does not leak", () => {
        // resolveInterruptedTurn=true — the pending prompt for the old turn must
        // settle, otherwise the client waits forever for a turn nobody will finish.
        expect(source).toContain('this.interruptSessionTurn(sessionState, "New prompt", true)');
    });
});
