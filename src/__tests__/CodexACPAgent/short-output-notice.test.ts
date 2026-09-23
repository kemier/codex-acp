import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerNotification } from "../../app-server";
import type { SessionState } from "../../CodexAcpServer";
import { AgentMode } from "../../AgentMode";
import {
    createCodexMockTestFixture,
    createTestSessionState,
    setupPromptAndSendNotifications,
    type CodexMockTestFixture
} from "../acp-test-utils";

/**
 * Regression coverage for the GLM-on-proxy "short-output end_turn" pattern:
 * the model runs real tool calls (commits, deploys) but ends the turn with
 * little or no acknowledgement text, so from the UI it looks like codex
 * "gave up" and the user is forced to type "go on". CodexEventHandler now
 * detects this shape at `turn/completed` and emits a visible plain-text
 * notice (a warning, not a speculative re-prompt — see the method doc for why
 * a silent nudge would be unsafe: cold KV cache + possible double-execution
 * of side-effecting work).
 */
describe("CodexEventHandler - short-output end_turn notice", () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = "test-session-id";
    const turnId = "turn-1";

    const sessionState: SessionState = createTestSessionState({
        sessionId,
        currentModelId: "model-id[effort]",
        agentMode: AgentMode.DEFAULT_AGENT_MODE,
    });

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });

    /** All the ACP sessionUpdate notifications emitted for this turn. */
    function sessionUpdates() {
        return mockFixture.getAcpConnectionEvents([]).filter(
            (e) => e.method === "sessionUpdate",
        );
    }

    /** The text of every agent_message_chunk emitted this turn. */
    function agentMessageTexts() {
        return sessionUpdates()
            .map((e) => e.args[0]?.update)
            .filter((u) => u?.sessionUpdate === "agent_message_chunk")
            .map((u) => u.content?.text ?? "");
    }

    it("emits a notice when the turn ran tools but delivered no assistant text", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "turn/started",
                params: { threadId: sessionId, turn: { id: turnId } },
            },
            // Two real tool calls (the GLM case: commits + a deploy).
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId,
                    startedAtMs: 0,
                    item: {
                        type: "commandExecution",
                        id: "cmd-1",
                        command: ["git", "commit", "-m", "add branch name"],
                        cwd: "/test/cwd",
                        status: "inProgress",
                    },
                },
            },
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId,
                    startedAtMs: 5,
                    item: {
                        type: "commandExecution",
                        id: "cmd-2",
                        command: ["npx", "vsce", "package"],
                        cwd: "/test/cwd",
                        status: "inProgress",
                    },
                },
            },
            // NO agentMessage delta at all — the model said nothing.
            {
                method: "turn/completed",
                params: { threadId: sessionId, turn: { id: turnId } },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        const texts = agentMessageTexts();
        const notice = texts.find((t) => /Turn ended after 2 tool call/.test(t));
        expect(notice).toBeDefined();
        expect(notice).toMatch(/no visible reply/);
        expect(notice).toMatch(/Send "go on"/);
    });

    it("emits a notice when the turn ran tools but delivered only a few characters", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "turn/started",
                params: { threadId: sessionId, turn: { id: turnId } },
            },
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId,
                    startedAtMs: 0,
                    item: {
                        type: "commandExecution",
                        id: "cmd-1",
                        command: ["git", "commit", "-m", "add branch name"],
                        cwd: "/test/cwd",
                        status: "inProgress",
                    },
                },
            },
            // A tiny (sub-threshold) acknowledgement.
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId,
                    startedAtMs: 1,
                    item: {
                        type: "agentMessage",
                        id: "tiny-message",
                        text: "",
                        phase: "final_answer",
                        memoryCitation: null,
                    },
                },
            },
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId,
                    itemId: "tiny-message",
                    delta: "Done.",
                },
            },
            {
                method: "turn/completed",
                params: { threadId: sessionId, turn: { id: turnId } },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        const texts = agentMessageTexts();
        const notice = texts.find((t) => /Turn ended after 1 tool call/.test(t));
        expect(notice).toBeDefined();
        expect(notice).toMatch(/only 5 character\(s\) of reply/);
        expect(notice).toMatch(/may have truncated/);
    });

    it("does NOT emit a notice when the turn ran tools and produced substantive text", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "turn/started",
                params: { threadId: sessionId, turn: { id: turnId } },
            },
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId,
                    startedAtMs: 0,
                    item: {
                        type: "commandExecution",
                        id: "cmd-1",
                        command: ["git", "commit", "-m", "add branch name"],
                        cwd: "/test/cwd",
                        status: "inProgress",
                    },
                },
            },
            // A real summary (well above the 40-char threshold).
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId,
                    itemId: "final-message",
                    delta: "I added the branch name to the banner and committed the change.",
                },
            },
            {
                method: "turn/completed",
                params: { threadId: sessionId, turn: { id: turnId } },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        expect(agentMessageTexts().find((t) => /Turn ended after/.test(t))).toBeUndefined();
    });

    it("does NOT emit a notice when the turn produced no tools (e.g. a refusal)", async () => {
        const notifications: ServerNotification[] = [
            {
                method: "turn/started",
                params: { threadId: sessionId, turn: { id: turnId } },
            },
            // No tool calls; a short refusal message.
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId,
                    itemId: "refusal",
                    delta: "I can't do that.",
                },
            },
            {
                method: "turn/completed",
                params: { threadId: sessionId, turn: { id: turnId } },
            },
        ];

        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, notifications);

        expect(agentMessageTexts().find((t) => /Turn ended after/.test(t))).toBeUndefined();
    });

    it("resets the per-turn counters so a subsequent clean turn stays silent", async () => {
        // Turn A: short-output (tools + no text) → notice expected.
        const turnA: ServerNotification[] = [
            { method: "turn/started", params: { threadId: sessionId, turn: { id: "turn-A" } } },
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-A",
                    startedAtMs: 0,
                    item: {
                        type: "commandExecution",
                        id: "cmd-A",
                        command: ["git", "commit", "-m", "x"],
                        cwd: "/test/cwd",
                        status: "inProgress",
                    },
                },
            },
            { method: "turn/completed", params: { threadId: sessionId, turn: { id: "turn-A" } } },
        ];
        await setupPromptAndSendNotifications(mockFixture, sessionId, sessionState, turnA);
        expect(agentMessageTexts().find((t) => /Turn ended after/.test(t))).toBeDefined();

        // Turn B: same tools, but this time a full summary → no notice. The
        // counters from Turn A must NOT leak into Turn B (the turn/started
        // reset must have fired). We re-run a full prompt so a fresh handler
        // isn't the thing resetting state — the reset-under-test is the
        // turn/started branch within the SAME handler instance.
        const turnB: ServerNotification[] = [
            { method: "turn/started", params: { threadId: sessionId, turn: { id: "turn-B" } } },
            {
                method: "item/started",
                params: {
                    threadId: sessionId,
                    turnId: "turn-B",
                    startedAtMs: 0,
                    item: {
                        type: "commandExecution",
                        id: "cmd-B",
                        command: ["git", "commit", "-m", "y"],
                        cwd: "/test/cwd",
                        status: "inProgress",
                    },
                },
            },
            {
                method: "item/agentMessage/delta",
                params: {
                    threadId: sessionId,
                    turnId: "turn-B",
                    itemId: "final-B",
                    delta: "I added the branch name to the banner and committed the change.",
                },
            },
            { method: "turn/completed", params: { threadId: sessionId, turn: { id: "turn-B" } } },
        ];
        mockFixture.clearAcpConnectionDump();
        for (const notification of turnB) {
            mockFixture.sendServerNotification(notification);
        }
        await mockFixture.getCodexAcpClient().waitForSessionNotifications(sessionId);
        await vi.waitFor(() => {
            expect(mockFixture.getAcpConnectionDump([]).length).toBeGreaterThan(0);
        });

        expect(agentMessageTexts().find((t) => /Turn ended after/.test(t))).toBeUndefined();
    });
});
