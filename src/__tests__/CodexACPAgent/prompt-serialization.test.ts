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

describe("steer echo", () => {
    const source = fs.readFileSync(
        path.resolve(__dirname, "../../CodexAcpServer.ts"),
        "utf8",
    );

    /**
     * session/steer is a notification, so a client cannot tell acceptance from
     * silent refusal — steer() returns early when there is no currentTurnId and
     * nothing reaches the client. vscode-acp keeps a steered message queued until
     * the agent confirms receipt, so without an echo it could not steer this agent
     * automatically: the message would be lost or re-sent at turn end. ericli and
     * claude-code already echo, which is why they got the automatic path first.
     */
    it("echoes the accepted text so the client can confirm delivery", () => {
        const idx = source.indexOf("Steer succeeded");
        expect(idx).toBeGreaterThan(0);
        const after = source.slice(idx, idx + 1200);
        expect(after).toContain("createUserMessageChunk({type: \"text\", text: params.text})");
        expect(after).toContain("new ACPSessionConnection(this.connection, params.sessionId)");
    });

    it("echoes only after turnSteer resolved, never on the failure path", () => {
        const steerAt = source.indexOf("async steer(");
        const body = source.slice(steerAt, steerAt + 2200);
        const turnSteer = body.indexOf("await this.codexAcpClient.turnSteer(");
        const echo = body.indexOf("createUserMessageChunk");
        const failure = body.indexOf('logger.error("Steer failed"');
        expect(turnSteer).toBeGreaterThan(0);
        expect(echo).toBeGreaterThan(turnSteer);
        expect(echo).toBeLessThan(failure);
    });

    it("a failing echo cannot break the steer", () => {
        const steerAt = source.indexOf("async steer(");
        const body = source.slice(steerAt, steerAt + 2200);
        expect(body).toContain('logger.error("Steer echo failed", echoErr)');
    });
});
