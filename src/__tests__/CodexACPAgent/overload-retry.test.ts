import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { TurnCompletedNotification } from "../../app-server/v2";
import type { SessionState } from "../../CodexAcpServer";
import type { UpdateSessionEvent } from "../../ACPSessionConnection";
import {
    createCodexMockTestFixture,
    createTestSessionState,
} from "../acp-test-utils";

function retryNoticeTexts(updates: UpdateSessionEvent[]): string[] {
    return updates
        .filter((update): update is Extract<UpdateSessionEvent, { sessionUpdate: "agent_message_chunk" }> => (
            update.sessionUpdate === "agent_message_chunk"
        ))
        .flatMap((update) => update.content.type === "text" ? [update.content.text] : [])
        .filter((text) => text.includes("retrying with backoff"));
}

describe("CodexAcpServer - server overload retry", () => {
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

    it("retries a serverOverloaded failure on the same model and succeeds", async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const sessionState = createTestSessionState({
            sessionId: "overload-retry-session",
            account: { type: "apiKey" },
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        // First attempt: turn completes but an error notification reported
        // serverOverloaded. Second attempt: clean success.
        const runTurnSpy = vi.spyOn(codexAppServerClient, "runTurn").mockResolvedValueOnce({
            threadId: sessionState.sessionId,
            turn: createTurn("completed"),
        }).mockResolvedValueOnce({
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

        // First attempt reports overload.
        mockFixture.sendServerNotification({
            method: "error",
            params: {
                threadId: sessionState.sessionId,
                turnId: "turn-id",
                willRetry: false,
                error: {
                    message: "Selected model is at capacity. Please try a different model.",
                    codexErrorInfo: "serverOverloaded",
                    additionalDetails: null,
                },
            },
        });

        // Let the retry backoff elapse (1ms) and the second attempt run.
        await vi.waitFor(() => {
            expect(runTurnSpy).toHaveBeenCalledTimes(2);
        });

        const result = await promptPromise;
        expect(runTurnSpy).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            stopReason: "end_turn",
        });
    });

    it("surfaces the error after retries are exhausted", async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const sessionState = createTestSessionState({
            sessionId: "overload-exhausted-session",
            account: { type: "apiKey" },
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        // 3 attempts (env), each reports serverOverloaded → exhausted.
        const runTurnSpy = vi.spyOn(codexAppServerClient, "runTurn")
            .mockResolvedValue({
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
            mockFixture.sendServerNotification({
                method: "error",
                params: {
                    threadId: sessionState.sessionId,
                    turnId: "turn-id",
                    willRetry: false,
                    error: {
                        message: "Selected model is at capacity. Please try a different model.",
                        codexErrorInfo: "serverOverloaded",
                        additionalDetails: null,
                    },
                },
            });
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
            message: "Internal error",
            data: {
                message: "Selected model is at capacity. Please try a different model.",
                codexErrorInfo: "serverOverloaded",
            },
        });
    });

    it("does not retry non-overload failures", async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const sessionState = createTestSessionState({
            sessionId: "non-overload-session",
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
        mockFixture.sendServerNotification({
            method: "error",
            params: {
                threadId: sessionState.sessionId,
                turnId: "turn-id",
                willRetry: false,
                error: {
                    message: "Internal error",
                    codexErrorInfo: "internalServerError",
                    additionalDetails: null,
                },
            },
        });

        let result: unknown;
        try {
            result = await promptPromise;
        } catch (error) {
            result = error;
        }

        expect(runTurnSpy).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            code: -32603,
            data: {
                codexErrorInfo: "internalServerError",
            },
        });
    });

    it("emits the retrying notice exactly once across multiple attempts and not on the final failed attempt", async () => {
        const mockFixture = createCodexMockTestFixture();
        const codexAcpAgent = mockFixture.getCodexAcpAgent();
        const codexAppServerClient = mockFixture.getCodexAppServerClient();
        const sessionState = createTestSessionState({
            sessionId: "overload-notice-once-session",
            account: { type: "apiKey" },
        });
        vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

        const sessionUpdates: UpdateSessionEvent[] = [];
        mockFixture.onAcpConnectionEvent((event) => {
            if (event.method === "sessionUpdate" && event.args[0]?.update) {
                sessionUpdates.push(event.args[0].update as UpdateSessionEvent);
            }
        });

        // 3 attempts (env), each reports serverOverloaded → exhausted.
        const runTurnSpy = vi.spyOn(codexAppServerClient, "runTurn")
            .mockResolvedValue({
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
            mockFixture.sendServerNotification({
                method: "error",
                params: {
                    threadId: sessionState.sessionId,
                    turnId: "turn-id",
                    willRetry: false,
                    error: {
                        message: "Selected model is at capacity. Please try a different model.",
                        codexErrorInfo: "serverOverloaded",
                        additionalDetails: null,
                    },
                },
            });
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
                codexErrorInfo: "serverOverloaded",
            },
        });

        // The one-line "retrying with backoff (attempt 1/3)" notice should be
        // emitted exactly once — not once per failed attempt — and the final
        // exhausted attempt must NOT add another notice text (the raw error is
        // surfaced via the thrown RequestError instead).
        const notices = retryNoticeTexts(sessionUpdates);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toEqual(
            "The model is at capacity — retrying with backoff (attempt 1/3).\n\n",
        );
    });
});
