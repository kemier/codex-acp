import type {
    FuzzyFileSearchSessionCompletedNotification,
    FuzzyFileSearchSessionUpdatedNotification,
    ServerNotification
} from "./app-server";
import type {SessionState} from "./CodexAcpServer";
import {type PlanEntry, RequestError} from "@agentclientprotocol/sdk";
import {ACPSessionConnection, type AcpClientConnection, type UpdateSessionEvent} from "./ACPSessionConnection";
import type {
    AccountRateLimitsUpdatedNotification,
    AgentMessageDeltaNotification,
    CodexErrorInfo,
    CommandExecutionOutputDeltaNotification,
    ConfigWarningNotification,
    ErrorNotification,
    ItemGuardianApprovalReviewCompletedNotification,
    ItemGuardianApprovalReviewStartedNotification,
    ItemCompletedNotification,
    ItemStartedNotification,
    ThreadItem,
    ModelReroutedNotification,
    PlanDeltaNotification,
    ReasoningSummaryPartAddedNotification,
    ReasoningSummaryTextDeltaNotification,
    ReasoningTextDeltaNotification,
    TerminalInteractionNotification,
    ThreadGoalClearedNotification,
    ThreadGoalUpdatedNotification,
    ThreadTokenUsageUpdatedNotification,
    TurnPlanUpdatedNotification,
    WarningNotification
} from "./app-server/v2";
import type { McpStartupCompleteEvent } from "./app-server";
import {toTokenCount} from "./TokenCount";
import {
    commandExecutionUsesTerminalOutput,
    createCollabAgentToolCallCompleteUpdate,
    createCollabAgentToolCallUpdate,
    createCommandExecutionUpdate,
    createContextCompactionCompleteUpdate,
    createContextCompactionStartUpdate,
    createDynamicToolCallUpdate,
    createFileChangeUpdate,
    createGuardianApprovalReviewToolCall,
    createGuardianApprovalReviewToolCallUpdate,
    createImageGenerationCompleteUpdate,
    createImageGenerationStartUpdate,
    createImageGenerationUpdate,
    createImageViewUpdate,
    createMcpRawInput,
    createMcpRawOutput,
    createFuzzyFileSearchComplete,
    createFuzzyFileSearchStartOrUpdate,
    createMcpToolCallUpdate,
    createSubAgentActivityUpdate,
    createWebSearchCompleteUpdate,
    createWebSearchStartUpdate,
    fuzzyFileSearchToolCallId,
} from "./CodexToolCallMapper";
import { stripShellPrefix } from "./CommandUtils";
import {createTerminalOutputMeta, type TerminalOutputMode} from "./TerminalOutputMode";
import {
    createCodexMessagePhaseMeta,
    createAgentTextMessageChunk,
    createAgentTextThoughtChunk,
} from "./ContentChunks";
import {sameThreadGoalSnapshot, toThreadGoalSnapshot} from "./ThreadGoalSnapshot";
import {logger} from "./Logger";

export { stripShellPrefix };

export type CompletedPlan = {
    itemId: string;
    text: string;
};

export class CodexEventHandler {

    private static readonly PLAN_UPDATE_INTERVAL_MS = 150;
    /**
     * Matches the transport-level stream disconnect error that codex core
     * reports as `codexErrorInfo: "other"` after its internal sampling retries
     * are exhausted — e.g. "stream disconnected before completion: error
     * sending request for url (http://127.0.0.1:8317/v1/responses)". The
     * local proxy (or the network) dropped the connection mid-turn; the whole
     * turn is worth retrying once the transport is back.
     */
    private static readonly STREAM_DISCONNECT_ERROR_RE =
        /stream disconnected before completion|error sending request for url|stream closed before response\.completed|websocket closed by server/i;

    private readonly sessionState: SessionState;
    private readonly supportsPlanUpdates: boolean;
    private failure: RequestError | null = null;
    private completedPlan: CompletedPlan | null = null;
    private readonly activeFuzzyFileSearchSessions = new Set<string>();
    private readonly activeGuardianApprovalReviews = new Set<string>();
    private readonly activeImageGenerationItems = new Set<string>();
    private readonly emittedImageViewItems = new Set<string>();
    private readonly planDeltaTextByItemId = new Map<string, string>();
    private readonly pendingPlanItemIds = new Set<string>();
    private readonly lastEmittedPlanTextByItemId = new Map<string, string>();
    private readonly session: ACPSessionConnection;
    private planUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    private planUpdateChain: Promise<void> = Promise.resolve();
    private disposed = false;
    private readonly seenReasoningDeltaItemIds = new Set<string>();
    private readonly terminalCommandIds = new Set<string>();
    private readonly terminalCommandOutputIds = new Set<string>();
    private readonly agentMessagePhases = new Map<string, string | null>();
    private readonly activeSubAgentActivities = new Set<string>();
    /**
     * Active overload-retry context for the current prompt. While non-null, a
     * `serverOverloaded` error notification records the failure (so the prompt
     * loop can retry with backoff) but surfaces only a one-line "retrying"
     * notice to the client — and only for the FIRST failed attempt; subsequent
     * attempts stay silent to avoid scrolling repeated notices. Cleared by
     * {@link resetForRetry} at each retry boundary.
     */
    private retryContext: { attempt: number; maxAttempts: number } | null = null;
    private retryNoticeEmitted = false;

    constructor(
        connection: AcpClientConnection,
        sessionState: SessionState,
        supportsPlanUpdates = false,
    ) {
        this.sessionState = sessionState;
        this.supportsPlanUpdates = supportsPlanUpdates;
        this.session = new ACPSessionConnection(connection, sessionState.sessionId);
    }

    getFailure(): RequestError | null {
        return this.failure;
    }

    /**
     * Resets the per-turn state between retry attempts of the same prompt.
     * A failed turn (e.g. upstream 503 overload) may have recorded a failure
     * and partial per-item state; clearing them prevents a retried turn from
     * being suppressed by dedup sets or carrying a stale failure forward.
     */
    resetForRetry(): void {
        this.failure = null;
        this.completedPlan = null;
        this.cancelPlanUpdateTimer();
        this.pendingPlanItemIds.clear();
        this.planDeltaTextByItemId.clear();
        this.lastEmittedPlanTextByItemId.clear();
        this.seenReasoningDeltaItemIds.clear();
        this.agentMessagePhases.clear();
        this.terminalCommandIds.clear();
        this.terminalCommandOutputIds.clear();
        this.activeFuzzyFileSearchSessions.clear();
        this.activeGuardianApprovalReviews.clear();
        this.activeImageGenerationItems.clear();
        this.emittedImageViewItems.clear();
        this.activeSubAgentActivities.clear();
        this.retryContext = null;
        // NOTE: retryNoticeEmitted intentionally survives resetForRetry() —
        // it is per-prompt (the handler is recreated for each prompt), and we
        // want the one-line "retrying" notice to appear only once across all
        // retry attempts of the same prompt, not once per attempt.
    }

    /**
     * Sets the overload-retry context for the upcoming turn attempt. While
     * active, a `serverOverloaded` error is surfaced to the client as a short
     * "retrying" notice (not the raw error) and the failure is recorded so the
     * prompt loop can retry. The notice is emitted only once per prompt —
     * later attempts in the same retry loop stay silent. Cleared automatically
     * by {@link resetForRetry}.
     */
    setRetryContext(attempt: number, maxAttempts: number): void {
        this.retryContext = { attempt, maxAttempts };
    }

    /**
     * Returns true when the recorded failure is a server overload (503 /
     * "model at capacity") — the case the prompt loop retries with backoff.
     */
    isServerOverloadedFailure(): boolean {
        if (this.failure === null) return false;
        const data = this.failure.data;
        if (data === null || typeof data !== "object") return false;
        const info = (data as { codexErrorInfo?: unknown }).codexErrorInfo;
        return info === "serverOverloaded";
    }

    /**
     * Returns true when the recorded failure is a transport-level stream
     * disconnect — e.g. "stream disconnected before completion: error sending
     * request for url" after the local proxy was restarted or the network
     * blipped. Core retries the sampling request internally with backoff; when
     * those retries are exhausted it reports `codexErrorInfo: "other"` with a
     * message matching {@link STREAM_DISCONNECT_ERROR_RE}. The prompt loop
     * treats this like a server overload and retries the whole turn.
     */
    isStreamDisconnectFailure(): boolean {
        if (this.failure === null) return false;
        const data = this.failure.data;
        if (data === null || typeof data !== "object") return false;
        const message = (data as { message?: unknown }).message;
        return typeof message === "string"
            && CodexEventHandler.STREAM_DISCONNECT_ERROR_RE.test(message);
    }

    /**
     * True when the recorded failure is transient and the prompt loop should
     * retry the turn with backoff (server overload OR transport-level stream
     * disconnect).
     */
    isRetryableTransientFailure(): boolean {
        return this.isServerOverloadedFailure() || this.isStreamDisconnectFailure();
    }

    takeCompletedPlan(): CompletedPlan | null {
        const plan = this.completedPlan;
        this.completedPlan = null;
        return plan;
    }

    async handleNotification(notification: ServerNotification) {
        const updateEvent = await this.createUpdateEvent(notification);
        if (updateEvent) {
            await this.session.update(updateEvent);
        }
    }

    async flushPendingPlanUpdates(): Promise<void> {
        this.cancelPlanUpdateTimer();
        do {
            const itemIds = [...this.pendingPlanItemIds];
            this.pendingPlanItemIds.clear();
            await Promise.all(itemIds.map(itemId => {
                const text = this.planDeltaTextByItemId.get(itemId) ?? "";
                return text.length > 0
                    ? this.enqueuePlanSnapshot(itemId, text)
                    : Promise.resolve();
            }));
            await this.planUpdateChain;
        } while (this.pendingPlanItemIds.size > 0);
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        await this.flushPendingPlanUpdates();
        this.disposed = true;
        this.cancelPlanUpdateTimer();
        this.pendingPlanItemIds.clear();
        this.planDeltaTextByItemId.clear();
        this.lastEmittedPlanTextByItemId.clear();
    }

    private async createUpdateEvent(notification: ServerNotification): Promise<UpdateSessionEvent | null> {
        /*
        TODO split UpdateSessionEvent to improve completion
        createUpdateEvent({
            sessionUpdate: "" , <- completion of UpdateSessionEvent["sessionUpdate"]
            params: {}, <- quickfix to generate required fields (rest of)
        });
         */
        switch (notification.method) {
            case "item/agentMessage/delta":
                return await this.createTextEvent(notification.params);
            case "item/plan/delta":
                return this.createPlanDeltaEvent(notification.params);
            case "item/started":
                return await this.createItemEvent(notification.params);
            case "item/completed":
                return await this.completeItemEvent(notification.params);
            case "turn/plan/updated":
                return await this.updatePlan(notification.params);
            case "error":
                return await this.createErrorEvent(notification.params);
            case "turn/started":
                this.sessionState.currentTurnId = notification.params.turn.id;
                return null;
            case "turn/completed":
                await this.flushPendingPlanUpdates();
                this.clearPlanTurnState();
                this.sessionState.currentTurnId = null;
                return null;
            case "thread/tokenUsage/updated":
                return this.createUsageUpdate(notification.params);
            case "thread/name/updated":
                this.sessionState.sessionTitle = notification.params.threadName ?? null;
                this.sessionState.sessionTitleSource = notification.params.threadName == null
                    ? "unset"
                    : "explicit";
                return {
                    sessionUpdate: "session_info_update",
                    title: notification.params.threadName ?? null,
                };
            case "thread/status/changed":
                return this.createCodexSessionInfoUpdate({
                    threadStatus: notification.params.status,
                });
            case "thread/archived":
                return this.createCodexSessionInfoUpdate({
                    archived: true,
                });
            case "thread/unarchived":
                return this.createCodexSessionInfoUpdate({
                    archived: false,
                });
            case "thread/closed":
                return this.createCodexSessionInfoUpdate({
                    closed: true,
                });
            case "item/commandExecution/outputDelta":
                return this.createCommandOutputDeltaEvent(notification.params);
            case "item/mcpToolCall/progress":
                return this.createMcpToolProgressEvent(notification.params);
            case "account/rateLimits/updated":
                this.handleRateLimitsUpdated(notification.params);
                return null;
            case "configWarning":
                return await this.createConfigWarningEvent(notification.params);
            case "warning":
                if (this.isModelMetadataFallbackWarning(notification.params)) {
                    return null;
                }
                return this.createWarningEvent(notification.params);
            case "guardianWarning":
                return null;
            case "item/autoApprovalReview/started":
                return this.handleGuardianApprovalReviewStarted(notification.params);
            case "item/autoApprovalReview/completed":
                return this.handleGuardianApprovalReviewCompleted(notification.params);
            case "thread/compacted":
                return this.createContextCompactedEvent();
            case "item/reasoning/summaryTextDelta":
                return this.createReasoningDeltaEvent(notification.params);
            case "item/reasoning/textDelta":
                return this.createReasoningDeltaEvent(notification.params);
            case "item/reasoning/summaryPartAdded":
                return this.createReasoningSectionBreakEvent(notification.params);
            case "model/rerouted":
                return this.createModelReroutedEvent(notification.params);
            case "fuzzyFileSearch/sessionUpdated":
                return this.handleFuzzyFileSearchSessionUpdated(notification.params);
            case "fuzzyFileSearch/sessionCompleted":
                return this.handleFuzzyFileSearchSessionCompleted(notification.params);
            case "thread/goal/updated":
                return this.createThreadGoalUpdatedEvent(notification.params);
            case "thread/goal/cleared":
                return this.createThreadGoalClearedEvent(notification.params);
            case "item/commandExecution/terminalInteraction":
                return this.createTerminalInteractionEvent(notification.params);
            // ignored events
            case "thread/deleted":
            case "thread/environment/connected":
            case "thread/environment/disconnected":
            case "command/exec/outputDelta":
            case "hook/started":
            case "hook/completed":
            case "turn/diff/updated":
            case "turn/moderationMetadata":
            case "item/fileChange/outputDelta":
            case "item/fileChange/patchUpdated":
            case "account/updated":
            case "fs/changed":
            case "mcpServer/startupStatus/updated":
            case "serverRequest/resolved":
            case "model/verification":
            case "model/safetyBuffering/updated":
            case "windows/worldWritableWarning":
            case "thread/realtime/started":
            case "thread/realtime/itemAdded":
            case "thread/realtime/transcript/delta":
            case "thread/realtime/transcript/done":
            case "thread/realtime/outputAudio/delta":
            case "thread/realtime/sdp":
            case "thread/realtime/error":
            case "thread/realtime/closed":
            case "windowsSandbox/setupCompleted":
            case "account/login/completed":
            case "skills/changed":
            case "deprecationNotice":
            case "mcpServer/oauthLogin/completed":
            case "externalAgentConfig/import/completed":
            case "rawResponseItem/completed":
            case "rawResponse/completed":
            case "thread/started":
            case "remoteControl/status/changed":
            case "app/list/updated":
            case "thread/settings/updated":
            case "externalAgentConfig/import/progress":
            case "process/outputDelta":
            case "process/exited":
                return null;
        }
    }

    private createCodexSessionInfoUpdate(codexMetadata: Record<string, unknown>): UpdateSessionEvent {
        return {
            sessionUpdate: "session_info_update",
            _meta: {
                codex: codexMetadata,
            },
        };
    }

    private async createTextEvent(event: AgentMessageDeltaNotification): Promise<UpdateSessionEvent> {
        const phase = this.agentMessagePhases.get(event.itemId) ?? null;
        return createAgentTextMessageChunk(event.delta, this.currentTurnMessageId(event.itemId), createCodexMessagePhaseMeta(phase));
    }

    private async createConfigWarningEvent(event: ConfigWarningNotification): Promise<UpdateSessionEvent> {
        const detailsText = event.details ? `\n\n${event.details}` : "";
        return createAgentTextMessageChunk(`Config warning: ${event.summary}${detailsText}\n\n`);
    }

    private createWarningEvent(event: WarningNotification): UpdateSessionEvent {
        return createAgentTextMessageChunk(`Warning: ${event.message}\n\n`);
    }

    private isModelMetadataFallbackWarning(event: WarningNotification): boolean {
        return /Model metadata for .* not found\. Defaulting to fallback metadata/.test(event.message);
    }

    private createModelReroutedEvent(event: ModelReroutedNotification): UpdateSessionEvent {
        return createAgentTextThoughtChunk(`Model rerouted from ${event.fromModel} to ${event.toModel} (${event.reason}).\n\n`);
    }

    private createThreadGoalUpdatedEvent(event: ThreadGoalUpdatedNotification): UpdateSessionEvent | null {
        this.sessionState.goalRevision += 1;
        const goalSnapshot = toThreadGoalSnapshot(event.goal);
        if (sameThreadGoalSnapshot(this.sessionState.currentGoal, goalSnapshot)) {
            return null;
        }
        this.sessionState.currentGoal = goalSnapshot;

        return this.createCodexSessionInfoUpdate({
            goal: goalSnapshot,
        });
    }

    private createThreadGoalClearedEvent(_event: ThreadGoalClearedNotification): UpdateSessionEvent | null {
        this.sessionState.goalRevision += 1;
        if (this.sessionState.currentGoal === null) {
            return null;
        }
        this.sessionState.currentGoal = null;

        return this.createCodexSessionInfoUpdate({
            goal: null,
        });
    }

    private createReasoningDeltaEvent(
        event: ReasoningSummaryTextDeltaNotification | ReasoningTextDeltaNotification
    ): UpdateSessionEvent {
        this.seenReasoningDeltaItemIds.add(event.itemId);
        return this.createAgentThoughtEvent(event.delta, this.currentTurnMessageId(event.itemId));
    }

    private createPlanDeltaEvent(event: PlanDeltaNotification): null {
        if (event.delta.length === 0) {
            return null;
        }
        const text = this.planDeltaTextByItemId.get(event.itemId) ?? "";
        const updatedText = text + event.delta;
        this.planDeltaTextByItemId.set(event.itemId, updatedText);
        if (this.supportsPlanUpdates) {
            this.pendingPlanItemIds.add(event.itemId);
            this.schedulePlanUpdate();
        }
        return null;
    }

    private createReasoningSectionBreakEvent(event: ReasoningSummaryPartAddedNotification): UpdateSessionEvent {
        this.seenReasoningDeltaItemIds.add(event.itemId);
        return this.createAgentThoughtEvent("\n\n", this.currentTurnMessageId(event.itemId));
    }

    /**
     * Stable messageId for the CURRENT turn's streaming chunks.
     *
     * Codex creates a distinct `item.id` per output item, so text before a
     * tool call and text after it carry different item ids. vscode-acp's
     * bubble reattach (text→tool→text = one assistant message) keys on
     * messageId: with per-item ids the reattach never matches and the
     * continuation renders as a NEW bubble (e.g. "The" alone, then the rest).
     *
     * Using a turn-scoped id makes all `agent_message_chunk` /
     * `agent_thought_chunk` deltas of one turn share one messageId, so
     * vscode-acp keeps text before and after a tool call in a single bubble.
     * Falls back to the item id when no turn is active (warnings, config
     * notices, non-turn events) so those never fuse across turns.
     */
    private currentTurnMessageId(itemId: string): string {
        const turnId = this.sessionState.currentTurnId;
        return turnId ? `turn-${turnId}` : itemId;
    }

    private createAgentThoughtEvent(text: string, messageId: string): UpdateSessionEvent {
        return createAgentTextThoughtChunk(text, messageId);
    }

    private async createItemEvent(event: ItemStartedNotification): Promise<UpdateSessionEvent | null> {
        switch (event.item.type) {
            case "fileChange":
                return await createFileChangeUpdate(event.item);
           case "commandExecution": {
               // Track background terminal processes for /ps
               if (event.item.source === "unifiedExecStartup" || event.item.source === "unifiedExecInteraction") {
                   const key = event.item.processId ?? event.item.id;
                   this.sessionState.backgroundProcesses.set(key, {
                       command: event.item.command,
                       processId: event.item.processId,
                   });
               }
               if (commandExecutionUsesTerminalOutput(event.item)) {
                    this.terminalCommandIds.add(event.item.id);
                } else {
                    this.terminalCommandIds.delete(event.item.id);
                    this.terminalCommandOutputIds.delete(event.item.id);
                }
                return await createCommandExecutionUpdate(event.item);
            }
            case "mcpToolCall":
                return await createMcpToolCallUpdate(event.item);
            case "dynamicToolCall":
                return await createDynamicToolCallUpdate(event.item);
            case "webSearch":
                return createWebSearchStartUpdate(event.item);
            case "imageView":
                this.emittedImageViewItems.add(event.item.id);
                return createImageViewUpdate(event.item);
            case "imageGeneration":
                this.activeImageGenerationItems.add(event.item.id);
                return createImageGenerationStartUpdate(event.item);
            case "collabAgentToolCall":
                return createCollabAgentToolCallUpdate(event.item);
            case "agentMessage":
                this.rememberAgentMessagePhase(event.item);
                return null;
            case "contextCompaction":
                return createContextCompactionStartUpdate(event.item);
            case "subAgentActivity":
                this.activeSubAgentActivities.add(event.item.id);
                return createSubAgentActivityUpdate(event.item, "in_progress", "tool_call");
            case "sleep":
            case "userMessage":
            case "hookPrompt":
            case "reasoning":
            case "enteredReviewMode":
            case "exitedReviewMode":
            case "plan":
                return null;
        }
    }

    private async completeItemEvent(event: ItemCompletedNotification): Promise<UpdateSessionEvent | null> {
        switch (event.item.type) {
            case "fileChange":
            case "dynamicToolCall":
                return {
                    sessionUpdate: "tool_call_update",
                    toolCallId: event.item.id,
                    status: event.item.status === "completed" ? "completed" : "failed",
                }
            case "mcpToolCall":
                return {
                    sessionUpdate: "tool_call_update",
                    toolCallId: event.item.id,
                    status: event.item.status === "completed" ? "completed" : "failed",
                    rawInput: createMcpRawInput(event.item.server, event.item.tool, event.item.arguments),
                    rawOutput: createMcpRawOutput(event.item.result, event.item.error),
                }
           case "commandExecution":
               // Remove from background processes tracking when completed
               if (event.item.source === "unifiedExecStartup" || event.item.source === "unifiedExecInteraction") {
                   const key = event.item.processId ?? event.item.id;
                   this.sessionState.backgroundProcesses.delete(key);
               }
               return this.completeCommandExecutionEvent(event.item);
            case "imageView":
                if (this.emittedImageViewItems.delete(event.item.id)) {
                    return null;
                }
                return createImageViewUpdate(event.item);
            case "imageGeneration":
                if (this.activeImageGenerationItems.delete(event.item.id)) {
                    return createImageGenerationCompleteUpdate(event.item);
                }
                return createImageGenerationUpdate(event.item, { terminalStatus: true });
            case "reasoning":
                if (this.seenReasoningDeltaItemIds.delete(event.item.id)) {
                    return null;
                }
                return this.createCompletedReasoningEvent(event.item);
            case "webSearch":
                return createWebSearchCompleteUpdate(event.item);
            case "collabAgentToolCall":
                return createCollabAgentToolCallCompleteUpdate(event.item);
            case "agentMessage":
                this.rememberAgentMessagePhase(event.item);
                return null;
            case "plan": {
                const deltaText = this.planDeltaTextByItemId.get(event.item.id) ?? "";
                return await this.createCompletedPlanEvent(event.item, deltaText);
            }
            case "exitedReviewMode":
                return this.createExitedReviewModeEvent(event.item);
            case "contextCompaction":
                return createContextCompactionCompleteUpdate(event.item);
            //ignored types
            case "subAgentActivity": {
                const sessionUpdate = this.activeSubAgentActivities.delete(event.item.id)
                    ? "tool_call_update"
                    : "tool_call";
                return createSubAgentActivityUpdate(event.item, "completed", sessionUpdate);
            }
            case "sleep":
            case "userMessage":
            case "hookPrompt":
            case "enteredReviewMode":
                return null;

        }
    }

    private rememberAgentMessagePhase(item: ThreadItem & { type: "agentMessage" }): void {
        this.agentMessagePhases.set(item.id, item.phase);
    }

    private createCompletedReasoningEvent(item: ThreadItem & { type: "reasoning" }): UpdateSessionEvent | null {
        const parts = item.summary.length > 0 ? item.summary : item.content;
        const text = parts.filter(part => part.length > 0).join("\n\n");
        if (text.length === 0) {
            return null;
        }
        return this.createAgentThoughtEvent(text, this.currentTurnMessageId(item.id));
    }

    private async createCompletedPlanEvent(
        item: ThreadItem & { type: "plan" },
        deltaText: string,
    ): Promise<UpdateSessionEvent | null> {
        const text = item.text.length > 0 ? item.text : deltaText;
        this.pendingPlanItemIds.delete(item.id);
        if (this.pendingPlanItemIds.size === 0) {
            this.cancelPlanUpdateTimer();
        }
        this.planDeltaTextByItemId.delete(item.id);
        if (text.length === 0) {
            return null;
        }
        this.completedPlan = {itemId: item.id, text};
        if (this.supportsPlanUpdates) {
            await this.enqueuePlanSnapshot(item.id, text);
            return null;
        }
        return this.createPlanTextEvent(text, this.currentTurnMessageId(item.id));
    }

    private schedulePlanUpdate(): void {
        if (this.disposed || this.planUpdateTimer !== null) return;
        this.planUpdateTimer = setTimeout(() => {
            this.planUpdateTimer = null;
            void this.flushPendingPlanUpdates().catch(error => {
                logger.error("Failed to flush throttled plan updates", error);
            });
        }, CodexEventHandler.PLAN_UPDATE_INTERVAL_MS);
    }

    private cancelPlanUpdateTimer(): void {
        if (this.planUpdateTimer === null) return;
        clearTimeout(this.planUpdateTimer);
        this.planUpdateTimer = null;
    }

    private enqueuePlanSnapshot(itemId: string, text: string): Promise<void> {
        const send = async () => {
            if (this.lastEmittedPlanTextByItemId.get(itemId) === text) return;
            await this.session.update(this.createPlanUpdateEvent(text, itemId));
            this.lastEmittedPlanTextByItemId.set(itemId, text);
        };
        const result = this.planUpdateChain.then(send);
        this.planUpdateChain = result.catch(() => {});
        return result;
    }

    private clearPlanTurnState(): void {
        this.cancelPlanUpdateTimer();
        this.pendingPlanItemIds.clear();
        this.planDeltaTextByItemId.clear();
        this.lastEmittedPlanTextByItemId.clear();
    }

    private createPlanUpdateEvent(text: string, planId: string): UpdateSessionEvent {
        return {
            sessionUpdate: "plan_update",
            plan: {
                type: "markdown",
                planId,
                content: text,
            },
        };
    }

    private createPlanTextEvent(text: string, messageId: string): UpdateSessionEvent {
        return createAgentTextMessageChunk(
            text,
            messageId,
            createCodexMessagePhaseMeta("final_answer"),
        );
    }

    private createExitedReviewModeEvent(item: ThreadItem & { type: "exitedReviewMode" }): UpdateSessionEvent | null {
        const text = item.review.trim();
        if (text.length === 0) {
            return null;
        }
        return createAgentTextMessageChunk(text);
    }

    private createContextCompactedEvent(): UpdateSessionEvent {
        return createAgentTextMessageChunk("*Context compacted to fit the model's context window.*\n\n");
    }

    private createCommandOutputDeltaEvent(event: CommandExecutionOutputDeltaNotification): UpdateSessionEvent {
        if (this.terminalCommandIds.has(event.itemId) && event.delta.length > 0) {
            this.terminalCommandOutputIds.add(event.itemId);
        }
        return this.createCommandOutputEvent(event.itemId, event.delta, this.commandOutputMode(event.itemId));
    }

    private createCommandOutputEvent(
        itemId: string,
        data: string,
        terminalOutputMode: TerminalOutputMode
    ): UpdateSessionEvent {
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: itemId,
            _meta: createTerminalOutputMeta(terminalOutputMode, itemId, data),
        }
    }

    private createTerminalInteractionEvent(event: TerminalInteractionNotification): UpdateSessionEvent {
        return this.createCommandOutputDeltaEvent({
            threadId: event.threadId,
            turnId: event.turnId,
            itemId: event.itemId,
            delta: `\n${event.stdin}\n`,
        });
    }

    private commandOutputMode(itemId: string): TerminalOutputMode {
        if (this.sessionState.terminalOutputMode === "terminal_output" && !this.terminalCommandIds.has(itemId)) {
            return "terminal_output_delta";
        }
        return this.sessionState.terminalOutputMode;
    }

    private createMcpToolProgressEvent(event: { itemId: string, message: string }): UpdateSessionEvent {
        const logDelta = event.message.trim();
        return {
            sessionUpdate: "tool_call_update",
            toolCallId: event.itemId,
            _meta: {
                mcp_output_delta: {
                    data: logDelta,
                }
            }
        };
    }

    static createMcpStartupUpdates(event: McpStartupCompleteEvent): UpdateSessionEvent[] {
        const failedUpdates = event.failed.map((server: McpStartupCompleteEvent["failed"][number]) => this.createMcpStartupToolCallUpdate(
            server.server,
            `[codex-acp forwarded startup error] MCP server \`${server.server}\` failed to start: ${server.error}`
        ));
        const cancelledUpdates = event.cancelled.map((server: McpStartupCompleteEvent["cancelled"][number]) => this.createMcpStartupToolCallUpdate(
            server,
            `[codex-acp forwarded startup error] MCP server \`${server}\` startup was cancelled.`
        ));

        return [...failedUpdates, ...cancelledUpdates];
    }

    private static createMcpStartupToolCallUpdate(serverName: string, message: string): UpdateSessionEvent {
        return {
            sessionUpdate: "tool_call",
            toolCallId: this.getMcpStartupToolCallId(serverName),
            kind: "other",
            title: `mcp__${serverName}__startup`,
            status: "failed",
            content: [{
                type: "content",
                content: {
                    type: "text",
                    text: message,
                },
            }],
        };
    }

    private static getMcpStartupToolCallId(serverName: string): string {
        return `mcp_startup.${encodeURIComponent(serverName)}`;
    }

    private completeCommandExecutionEvent(item: ThreadItem & { "type": "commandExecution" }): UpdateSessionEvent {
        const update: UpdateSessionEvent = {
            sessionUpdate: "tool_call_update",
            toolCallId: item.id,
            status: item.status === "completed" ? "completed" : "failed",
            rawOutput: {
                formatted_output: item.aggregatedOutput ?? "",
                exit_code: item.exitCode
            },
        };

        const commandHadTerminal = this.terminalCommandIds.delete(item.id);
        const commandHadOutput = this.terminalCommandOutputIds.delete(item.id);
        if (!commandHadTerminal) {
            return update;
        }
        const terminalMeta: Record<string, unknown> = {};
        if (!commandHadOutput && item.aggregatedOutput) {
            Object.assign(
                terminalMeta,
                createTerminalOutputMeta(this.sessionState.terminalOutputMode, item.id, item.aggregatedOutput)
            );
        }
        terminalMeta["terminal_exit"] = {
            exit_code: item.exitCode,
            signal: null,
            terminal_id: item.id
        };
        return {
            ...update,
            _meta: terminalMeta,
        };
    }

    private async updatePlan(event: TurnPlanUpdatedNotification): Promise<UpdateSessionEvent> {
        const plan: PlanEntry[] = event.plan.map(value => ({
                status: value.status == "inProgress" ? "in_progress" : value.status,
                content: value.step,
                priority: "medium"
            })
        );
        return {
            sessionUpdate: "plan",
            entries: plan,
            // update_plan is a checklist, not a strategy — the app-server says so
            // where it builds this notification:
            //
            //   // `update_plan` is a todo/checklist tool; it is not related to
            //   // plan-mode updates
            //   (codex-rs/app-server/src/bespoke_event_handling.rs)
            //
            // The tool NAME is legacy; the exec layer models the same data as
            // TodoList/TodoItem { completed }. A client titling this bar "Plan"
            // therefore collides with plan-mode, which IS a plan and arrives
            // separately as sessionUpdate "plan_update" (see createPlanUpdateEvent).
            //
            // Adapter-neutral hint, shared with the other adapters. A
            // client that ignores _meta renders exactly as before.
            _meta: { acp: { plan: { kind: "todo", title: "Todos" } } },
        } as UpdateSessionEvent;
    }

    private async createErrorEvent(params: ErrorNotification): Promise<UpdateSessionEvent | null> {
        const error = params.error.codexErrorInfo;
        if (params.willRetry) {
            return this.createCodexSessionInfoUpdate({
                error: {
                    ...params.error,
                    turnId: params.turnId,
                    willRetry: true,
                },
            });
        } else if (this.isTransientRetryableError(error, params.error.message) && this.retryContext !== null) {
            // Retryable transient failure (upstream 503 "model at capacity",
            // or a transport-level stream disconnect — proxy restart /
            // network blip that exhausted core's internal sampling retries):
            // record the failure so prompt() can retry with backoff, but only
            // surface a subtle notice to the client — the raw error would be
            // replaced by the eventual successful response anyway. The
            // server-side retry loop emits the final error text only after
            // retries are exhausted.
            this.failure = RequestError.internalError(
                this.createTurnErrorData(params.error),
            );
            if (!this.retryNoticeEmitted) {
                this.retryNoticeEmitted = true;
                const maxAttempts = this.retryContext.maxAttempts;
                return createAgentTextMessageChunk(
                    maxAttempts > 1
                        ? `${this.retryNoticePrefix(params.error)} — retrying with backoff ` +
                          `(attempt ${this.retryContext.attempt}/${maxAttempts}).\n\n`
                        : `${this.retryNoticePrefix(params.error)} — retrying with backoff…\n\n`,
                );
            }
            return null;
        } else if (error === "usageLimitExceeded") {
            this.failure = RequestError.internalError(
                this.createTurnErrorData(params.error),
            );
        } else if (this.isAuthenticationRequiredError(error)) {
            this.failure = this.sessionState.authConfigured
                ? RequestError.internalError(this.createTurnErrorData(params.error))
                : RequestError.authRequired(this.createTurnErrorData(params.error), params.error.message);
        }
        // All other non-retryable errors (e.g. upstream 503 after retry
        // exhaustion, responseTooManyFailedAttempts, internal_server_error,
        // bad_request, sandbox_error, "other") must set this.failure so the
        // prompt throws an error instead of returning end_turn with 0 tokens.
        // Without this, vscode-acp sees a successful turn and the user gets
        // no indication that the model call failed.
        if (!this.failure) {
            this.failure = RequestError.internalError(
                this.createTurnErrorData(params.error),
            );
        }
        return createAgentTextMessageChunk(`${params.error.message}\n\n`);
    }

    /**
     * True when the failed turn is a transient failure worth retrying with
     * backoff: `serverOverloaded` (upstream 503) or a transport-level stream
     * disconnect ("stream disconnected before completion ... error sending
     * request for url"), which codex core reports as `codexErrorInfo: "other"`.
     */
    private isTransientRetryableError(
        error: CodexErrorInfo | null,
        message: string,
    ): boolean {
        return error === "serverOverloaded"
            || CodexEventHandler.STREAM_DISCONNECT_ERROR_RE.test(message);
    }

    private retryNoticePrefix(error: ErrorNotification["error"]): string {
        return error.codexErrorInfo === "serverOverloaded"
            ? "The model is at capacity"
            : "The connection dropped mid-stream";
    }

    private isAuthenticationRequiredError(error: CodexErrorInfo | null): boolean {
        return error === "unauthorized" || this.getHttpStatusCode(error) === 401;
    }

    private getHttpStatusCode(error: CodexErrorInfo | null): number | null {
        if (error !== null && typeof error === "object") {
            if ("httpConnectionFailed" in error) {
                return error.httpConnectionFailed.httpStatusCode;
            } else if ("responseStreamConnectionFailed" in error) {
                return error.responseStreamConnectionFailed.httpStatusCode;
            } else if ("responseStreamDisconnected" in error) {
                return error.responseStreamDisconnected.httpStatusCode;
            } else if ("responseTooManyFailedAttempts" in error) {
                return error.responseTooManyFailedAttempts.httpStatusCode;
            }
        }
        return null;
    }

    private createTurnErrorData(error: ErrorNotification["error"]): {
        message: string;
        codexErrorInfo?: CodexErrorInfo;
        additionalDetails?: string;
    } {
        const data: {
            message: string;
            codexErrorInfo?: CodexErrorInfo;
            additionalDetails?: string;
        } = {
            message: error.additionalDetails ?? error.message,
        };
        if (error.codexErrorInfo !== null) {
            data.codexErrorInfo = error.codexErrorInfo;
        }
        if (error.additionalDetails !== null) {
            data.additionalDetails = error.additionalDetails;
        }
        return data;
    }

    private handleTokenUsageUpdated(params: ThreadTokenUsageUpdatedNotification): void {
        this.sessionState.lastTokenUsage = toTokenCount(params.tokenUsage.last);
        this.sessionState.totalTokenUsage = toTokenCount(params.tokenUsage.total);
        this.sessionState.modelContextWindow = params.tokenUsage.modelContextWindow;
    }

    private createUsageUpdate(params: ThreadTokenUsageUpdatedNotification): UpdateSessionEvent | null {
        this.handleTokenUsageUpdated(params);

        const used = this.sessionState.lastTokenUsage?.totalTokens;
        const size = this.sessionState.modelContextWindow;
        if (used == null || size == null || size <= 0) {
            return null;
        }

        // Cap `used` at `size` so the IDE context ring never shows >100%.
        // The upstream codex binary's `ModelDownshift` pre-turn compaction guard
        // (codex-rs/core/src/session/turn.rs) is inert for proxy-routed models:
        // `model_info_from_slug` hardcodes `context_window: 272_000` for every
        // unknown slug, so `old_context_window > new_context_window` is always
        // false and the guard never fires on a large→small model switch. The
        // oversized history then goes through under the new (smaller) real
        // window, and the `ThreadTokenUsageUpdated` notification can carry
        // `last.totalTokens` > `modelContextWindow`. Capping here mirrors
        // claude-code-acp (`agent.ts: Math.min(estimated, contextWindow)`) and
        // keeps the display honest-to-the-window even when the upstream guard
        // misses. The proactive compaction in `SessionManager.sendPrompt`
        // prevents the overflow itself; this cap is the display backstop.
        const cappedUsed = Math.min(used, size);

        return {
            sessionUpdate: "usage_update",
            used: cappedUsed,
            size,
        };
    }

    private handleRateLimitsUpdated(params: AccountRateLimitsUpdatedNotification): void {
        if (!this.sessionState.rateLimits) {
            this.sessionState.rateLimits = new Map();
        }
        const limitId = params.rateLimits.limitId ?? params.rateLimits.limitName ?? "unknown";
        this.sessionState.rateLimits.set(limitId, {
            limitId: limitId,
            limitName: params.rateLimits.limitName ?? limitId,
            snapshot: params.rateLimits,
        });
    }

    private handleFuzzyFileSearchSessionUpdated(
        params: FuzzyFileSearchSessionUpdatedNotification
    ): UpdateSessionEvent {
        const toolCallId = fuzzyFileSearchToolCallId(params.sessionId);
        const started = !this.activeFuzzyFileSearchSessions.has(toolCallId);
        this.activeFuzzyFileSearchSessions.add(toolCallId);
        return createFuzzyFileSearchStartOrUpdate(params, started);
    }

    private handleFuzzyFileSearchSessionCompleted(
        params: FuzzyFileSearchSessionCompletedNotification
    ): UpdateSessionEvent {
        const toolCallId = fuzzyFileSearchToolCallId(params.sessionId);
        this.activeFuzzyFileSearchSessions.delete(toolCallId);
        return createFuzzyFileSearchComplete(params);
    }

    private handleGuardianApprovalReviewStarted(
        params: ItemGuardianApprovalReviewStartedNotification
    ): UpdateSessionEvent {
        if (this.activeGuardianApprovalReviews.has(params.reviewId)) {
            return createGuardianApprovalReviewToolCallUpdate(params);
        }
        this.activeGuardianApprovalReviews.add(params.reviewId);
        return createGuardianApprovalReviewToolCall(params);
    }

    private handleGuardianApprovalReviewCompleted(
        params: ItemGuardianApprovalReviewCompletedNotification
    ): UpdateSessionEvent {
        if (this.activeGuardianApprovalReviews.delete(params.reviewId)) {
            return createGuardianApprovalReviewToolCallUpdate(params);
        }
        return createGuardianApprovalReviewToolCall(params);
    }
}
