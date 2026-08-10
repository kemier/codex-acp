import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerNotification } from '../../app-server';
import { createCodexMockTestFixture, createTestSessionState, type CodexMockTestFixture } from '../acp-test-utils';
import type { TokenUsageBreakdown } from '../../app-server/v2';

function createTokenUsageNotification(
    sessionId: string,
    tokenUsage: {
        total: TokenUsageBreakdown;
        last: TokenUsageBreakdown;
        modelContextWindow: number | null;
    }
): ServerNotification {
    return {
        method: 'thread/tokenUsage/updated',
        params: {
            threadId: sessionId,
            turnId: 'turn-id',
            tokenUsage,
        },
    };
}

describe('Token Usage Events', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });
    describe('PromptResponse usage', () => {
        function setupPromptWithTokenUsage(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            // awaitTurnCompleted sends notifications before resolving
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                // Send notifications during turn (after handler is registered)
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return codexAcpAgent;
        }

        it('should include token_count in PromptResponse on end_turn', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 5000,
                    inputTokens: 4000,
                    cachedInputTokens: 1000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 900,
                    reasoningOutputTokens: 100,
                },
                last: {
                    totalTokens: 2500,
                    inputTokens: 2000,
                    cachedInputTokens: 500,
                    cacheWriteInputTokens: 0,
                    outputTokens: 450,
                    reasoningOutputTokens: 50,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-end-turn.json'
            );
        });

        it('should include token_count in PromptResponse on cancelled', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 3000,
                    inputTokens: 2500,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 500,
                    reasoningOutputTokens: 0,
                },
                last: {
                    totalTokens: 1500,
                    inputTokens: 1200,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 300,
                    reasoningOutputTokens: 0,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification], "interrupted");

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-cancelled.json'
            );
        });

        it('should return null token_count when no token usage event received', async () => {
            const codexAcpAgent = setupPromptWithTokenUsage([]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-null.json'
            );
        });

        it('should use last token usage from multiple updates', async () => {
            const notifications: ServerNotification[] = [
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ];

            const codexAcpAgent = setupPromptWithTokenUsage(notifications);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-multiple-updates.json'
            );
        });
    });

    describe('session/update usage_update', () => {
        function setupPromptAndReturnEvents(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return async () => {
                await codexAcpAgent.prompt({
                    sessionId,
                    prompt: [{ type: 'text', text: 'test prompt' }],
                });
                return mockFixture.getAcpConnectionEvents([]);
            };
        }

        it('should emit usage_update with latest turn usage as a context proxy', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: {
                        totalTokens: 5000,
                        inputTokens: 4000,
                        cachedInputTokens: 1000,
                        cacheWriteInputTokens: 0,
                        outputTokens: 900,
                        reasoningOutputTokens: 100,
                    },
                    last: {
                        totalTokens: 2500,
                        inputTokens: 2000,
                        cachedInputTokens: 500,
                        cacheWriteInputTokens: 0,
                        outputTokens: 450,
                        reasoningOutputTokens: 50,
                    },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events[0], null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update.json');
        });

        it('should emit latest turn usage from multiple updates', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update-multiple.json');
        });

        it('should skip usage_update when model context window is unavailable', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 900, reasoningOutputTokens: 100 },
                    last: { totalTokens: 2500, inputTokens: 2000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 450, reasoningOutputTokens: 50 },
                    modelContextWindow: null,
                }),
            ])();

            expect(events).toEqual([]);
        });
    });

    describe('usage_update display cap (Part 2)', () => {
        function setupPromptAndReturnEvents(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return async () => {
                await codexAcpAgent.prompt({
                    sessionId,
                    prompt: [{ type: 'text', text: 'test prompt' }],
                });
                return mockFixture.getAcpConnectionEvents([]);
            };
        }

        it('should cap used at size when last.totalTokens exceeds modelContextWindow', async () => {
            // Simulates the model-switch overflow: the upstream codex binary
            // reports last.totalTokens=200000 against a real window of 196608
            // (GLM-5.2). Without the Math.min cap the ring would show ~102%.
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 200000, inputTokens: 180000, cachedInputTokens: 20000, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
                    last: { totalTokens: 200000, inputTokens: 180000, cachedInputTokens: 20000, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
                    modelContextWindow: 196608,
                }),
            ])();

            const usageUpdate = events.find(
                (e: any) => e.method === "sessionUpdate" && e.args?.[0]?.update?.sessionUpdate === "usage_update",
            );
            expect(usageUpdate).toBeDefined();
            const update = (usageUpdate as any).args[0].update;
            expect(update.used).toBe(196608); // capped, NOT 200000
            expect(update.size).toBe(196608);
        });

        it('should not cap when used is below size', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2500, inputTokens: 2000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 450, reasoningOutputTokens: 50 },
                    last: { totalTokens: 2500, inputTokens: 2000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 450, reasoningOutputTokens: 50 },
                    modelContextWindow: 128000,
                }),
            ])();

            const usageUpdate = events.find(
                (e: any) => e.method === "sessionUpdate" && e.args?.[0]?.update?.sessionUpdate === "usage_update",
            );
            expect(usageUpdate).toBeDefined();
            const update = (usageUpdate as any).args[0].update;
            expect(update.used).toBe(2500); // unchanged
            expect(update.size).toBe(128000);
        });
    });

    describe('proactive model-switch compaction guard (Part 1)', () => {
        function setupPromptWithPriorUsage(opts: {
            priorInputTokens: number;
            priorCachedInputTokens: number;
            modelId: string;
            notifications?: ServerNotification[];
        }) {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                for (const notification of (opts.notifications ?? [])) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: "completed", error: null }
                };
            });

            // The guard snapshots `lastTokenUsage` → `previousTurnTokenUsage` at
            // the START of session/prompt (CodexAcpServer.ts:1950), BEFORE
            // nulling `lastTokenUsage`. So to simulate "the prior turn left a
            // 200k prompt", we seed `lastTokenUsage` (NOT `previousTurnTokenUsage`)
            // — the prompt handler will snapshot it for the guard.
            const priorUsage: import('../../TokenCount').TokenCount = {
                totalTokens: opts.priorInputTokens + opts.priorCachedInputTokens,
                inputTokens: opts.priorInputTokens,
                cachedInputTokens: opts.priorCachedInputTokens,
                outputTokens: 0,
                reasoningOutputTokens: 0,
            };
            const sessionState = createTestSessionState({
                sessionId,
                currentModelId: opts.modelId,
                lastTokenUsage: priorUsage,
            });
            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(sessionState);

            // Configure the custom gateway so getGatewayBaseUrl() returns a URL
            // (the guard no-ops without one). The stub resolver ignores the URL.
            mockFixture.getCodexAcpClient().setProvider({
                providerId: "custom-gateway",
                apiType: "openai",
                baseUrl: "http://127.0.0.1:8317/v1",
            });

            const runCompactSpy = vi.spyOn(mockFixture.getCodexAcpClient(), 'runCompact').mockResolvedValue(undefined);

            return { codexAcpAgent, runCompactSpy, sessionState };
        }

        it('should compact before forwarding when prior prompt size exceeds the new model window', async () => {
            // DeepSeek-V4-Flash (262k) history grew to ~200k, then user switched
            // to GLM-5.2 (196608). The prior prompt (200k) exceeds GLM-5.2's
            // 90% threshold (177k) → guard compacts BEFORE sendPrompt.
            const { codexAcpAgent, runCompactSpy } = setupPromptWithPriorUsage({
                priorInputTokens: 180000,
                priorCachedInputTokens: 20000, // total prompt = 200000
                modelId: 'glm-5.2[high]',
            });
            mockFixture.getModelContextWindowResolver().set('glm-5.2', 196608);

            await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'next turn' }],
            });

            expect(runCompactSpy).toHaveBeenCalledTimes(1);
            expect(runCompactSpy).toHaveBeenCalledWith(sessionId);
            expect(mockFixture.getModelContextWindowResolver().resolveCalls).toBeGreaterThan(0);
        });

        it('should NOT compact when prior prompt size fits the new model window', async () => {
            // Same history (200k) but switching to DeepSeek (262k): 200k < 262k*0.9
            // → guard skips compaction.
            const { codexAcpAgent, runCompactSpy } = setupPromptWithPriorUsage({
                priorInputTokens: 180000,
                priorCachedInputTokens: 20000, // total prompt = 200000
                modelId: 'deepseek-v4-flash[high]',
            });
            mockFixture.getModelContextWindowResolver().set('deepseek-v4-flash', 262144);

            await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'next turn' }],
            });

            expect(runCompactSpy).not.toHaveBeenCalled();
        });

        it('should NOT compact when the model window is unknown (no spurious compaction)', async () => {
            // Without a real window we cannot tell whether the history exceeds
            // it — the guard must skip, falling back to the display cap only.
            const { codexAcpAgent, runCompactSpy } = setupPromptWithPriorUsage({
                priorInputTokens: 180000,
                priorCachedInputTokens: 20000,
                modelId: 'unknown-model[high]',
            });
            // No window seeded for 'unknown-model'.

            await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'next turn' }],
            });

            expect(runCompactSpy).not.toHaveBeenCalled();
        });

        it('should NOT compact when no prior turn usage exists (first turn)', async () => {
            // lastTokenUsage is null → the snapshot sets
            // previousTurnTokenUsage = null → guard returns early.
            const codexAcpAgent = mockFixture.getCodexAcpAgent();
            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockResolvedValue({
                threadId: sessionId,
                turn: { id: "turn-id", items: [], status: "completed", error: null }
            });
            const sessionState = createTestSessionState({
                sessionId,
                currentModelId: 'glm-5.2[high]',
                lastTokenUsage: null, // first turn: no prior usage
            });
            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(sessionState);
            mockFixture.getCodexAcpClient().setProvider({
                providerId: "custom-gateway",
                apiType: "openai",
                baseUrl: "http://127.0.0.1:8317/v1",
            });
            mockFixture.getModelContextWindowResolver().set('glm-5.2', 196608);
            const runCompactSpy = vi.spyOn(mockFixture.getCodexAcpClient(), 'runCompact').mockResolvedValue(undefined);

            await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'first turn' }],
            });

            expect(runCompactSpy).not.toHaveBeenCalled();
        });

        it('should NOT compact when no gateway is configured', async () => {
            // No setProvider call → getGatewayBaseUrl() returns null → guard
            // returns early without consulting the resolver.
            const codexAcpAgent = mockFixture.getCodexAcpAgent();
            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockResolvedValue({
                threadId: sessionId,
                turn: { id: "turn-id", items: [], status: "completed", error: null }
            });
            const sessionState = createTestSessionState({
                sessionId,
                currentModelId: 'glm-5.2[high]',
                lastTokenUsage: {
                    totalTokens: 200000,
                    inputTokens: 180000,
                    cachedInputTokens: 20000,
                    outputTokens: 0,
                    reasoningOutputTokens: 0,
                },
            });
            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(sessionState);
            mockFixture.getModelContextWindowResolver().set('glm-5.2', 196608);
            const runCompactSpy = vi.spyOn(mockFixture.getCodexAcpClient(), 'runCompact').mockResolvedValue(undefined);

            await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'next turn' }],
            });

            expect(runCompactSpy).not.toHaveBeenCalled();
        });
    });
});
