import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { TurnCompletedNotification } from "../../app-server/v2";
import type { SessionState } from "../../CodexAcpServer";
import type { UpdateSessionEvent } from "../../ACPSessionConnection";
import {
    createCodexMockTestFixture,
    createTestSessionState,
} from "../acp-test-utils";

/**
 * Regression test for premature `end_turn` in codex-acp sessions when the
 * local proxy drops the WebSocket mid-turn ("stream disconnected before
 * completion: error sending request for url ..."). Before this fix the
 * failure was reported as `codexErrorInfo: "other"`, which the prompt loop
 * treated as non-retryable and surfaced immediately — the user saw "end_turn"
 * with no reply and had to type "go on".
 */
describe("CodexAcpServer - stream disconnect retry", () => {
    let savedAttempts: string | undefined;
    let savedBaseDelay: string | undefined;

    beforeEach(() => {
        savedAttempts = process.env["CODEX_ACP_OVERLOAD_RETRY_ATTEMPTS"];
        savedBaseDelay = process.env["CODEX_ACP_OVERLOAD_RETRY_BASE_DELAY_MS"];
        // Fast, deterministic retries for tests.
        process.env["CODEX_ACP_OVERLOAD_RETRY_ATTEMPTS"] = "3";
        process.env["CODEX_ACP_OVERLOAD_RETRY_BASE_DELAY_MS"] = "1";
    });

    afterEach(() => {
        if (savedAttempts === undefined) {
            delete process.env["CODEX_ACP_OVERLOAD_RETRY_ATTEMPTS"];
        } else {
            process.env["CODEX_ACP_OVERLOAD_RETRY_ATTEMPTS"] = savedAttempts;
        }
        if (savedBaseDelay === undefined) {
            delete process.env["CODEX_ACP_OVERLOAD_RETRY_BASE_DELAY_MS"];
        } else {
            process.env["CODEX_ACP_OVERLOAD_RETRY_BASE_DELAY_MS"] = savedBaseDelay;
        }
    });

    function createTurn(status: "inProgress" | "completed"): TurnCompletedNotification["turn"] {
        return {
            id: "turn-id",
            items: [],
            itemsView: "notLoaded" as const,
            status,
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
        };
    }

    const DISCONNECT_MESSAGE =
        "stream disconnected before completion: error sending request for url " +
        "(http://127.0.0.1:8317/v1/responses)";

    function sendDisconnect(mockFixture: ReturnType<typeof createCodexMockTestFixture>, sessionId: string) {
        mockFixture.sendServerNotification({
            method: "error",
            params: {
                threadId: sessionId,
                turnId: "turn-id",
                willRetry: false,
                error: {
                    message: DISCONNECT_MESSAGE,
                    codexErrorInfo: "other",
                    additionalDetails: null,
                },
            },
        });
    }

    it("retries a stream-disconnect failure (codexErrorInfo 'other') and succeeds", async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const sessionState = createTestSessionState({
            sessionId: "stream-disconnect-retry-session",
            account: { type: "apiKey" },
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        const runTurnSpy = vi.spyOn(codexAppServerClient, "runTurn").mockResolvedValue({
            threadId: sessionState.sessionId,
            turn: createTurn("completed"),
        });

        const promptPromise = codexAcpAgent.prompt({
            sessionId: sessionState.sessionId,
            prompt: [{ type: "text", text: "test" }],
        });

        await vi.waitFor(() => {
            expect(runTurnSpy).toHaveBeenCalledTimes(1);
        });
        sendDisconnect(mockFixture, sessionState.sessionId);

        // The retry backoff elapses (1ms) and the second attempt runs.
        await vi.waitFor(() => {
            expect(runTurnSpy).toHaveBeenCalledTimes(2);
        });

        const result = await promptPromise;
        expect(runTurnSpy).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            stopReason: "end_turn",
        });
    });

    it("surfaces the error after stream-disconnect retries are exhausted", async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const sessionState = createTestSessionState({
            sessionId: "stream-disconnect-exhausted-session",
            account: { type: "apiKey" },
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        const runTurnSpy = vi.spyOn(codexAppServerClient, "runTurn").mockResolvedValue({
            threadId: sessionState.sessionId,
            turn: createTurn("completed"),
        });

        const promptPromise = codexAcpAgent.prompt({
            sessionId: sessionState.sessionId,
            prompt: [{ type: "text", text: "test" }],
        });

        const failTurn = async (n: number) => {
            await vi.waitFor(() => {
                expect(runTurnSpy).toHaveBeenCalledTimes(n);
            });
            sendDisconnect(mockFixture, sessionState.sessionId);
        };

        await failTurn(1);
        await failTurn(2);
        await failTurn(3);

        let result: unknown;
        try {
            result = await promptPromise;
        } catch (error) {
            result = error;
        }

        expect(runTurnSpy).toHaveBeenCalledTimes(3);
        expect(result).toMatchObject({
            code: -32603,
            data: {
                message: DISCONNECT_MESSAGE,
                codexErrorInfo: "other",
            },
        });
    });

    it("emits the stream-disconnect retry notice exactly once", async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const sessionState = createTestSessionState({
            sessionId: "stream-disconnect-notice-session",
            account: { type: "apiKey" },
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        const sessionUpdates: UpdateSessionEvent[] = [];
        mockFixture.onAcpConnectionEvent((event) => {
            if (event.method === "sessionUpdate" && event.args[0]?.update) {
                sessionUpdates.push(event.args[0].update as UpdateSessionEvent);
            }
        });

        const runTurnSpy = vi.spyOn(codexAppServerClient, "runTurn").mockResolvedValue({
            threadId: sessionState.sessionId,
            turn: createTurn("completed"),
        });

        const promptPromise = codexAcpAgent.prompt({
            sessionId: sessionState.sessionId,
            prompt: [{ type: "text", text: "test" }],
        });

        const failTurn = async (n: number) => {
            await vi.waitFor(() => {
                expect(runTurnSpy).toHaveBeenCalledTimes(n);
            });
            sendDisconnect(mockFixture, sessionState.sessionId);
        };

        await failTurn(1);
        await failTurn(2);
        await failTurn(3);

        let result: unknown;
        try {
            result = await promptPromise;
        } catch (error) {
            result = error;
        }

        expect(runTurnSpy).toHaveBeenCalledTimes(3);
        expect(result).toMatchObject({
            code: -32603,
            data: {
                codexErrorInfo: "other",
            },
        });

        const notices = sessionUpdates
            .filter((update): update is Extract<UpdateSessionEvent, { sessionUpdate: "agent_message_chunk" }> => (
                update.sessionUpdate === "agent_message_chunk"
            ))
            .flatMap((update) => update.content.type === "text" ? [update.content.text] : [])
            .filter((text) => text.includes("retrying with backoff"));
        expect(notices).toHaveLength(1);
        expect(notices[0]).toEqual(
            "The connection dropped mid-stream — retrying with backoff (attempt 1/3).\n\n",
        );
    });
});
