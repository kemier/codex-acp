import type {ContentBlock} from "@agentclientprotocol/sdk";
import type {UpdateSessionEvent} from "./ACPSessionConnection";

type AcpMeta = Record<string, unknown>;

export function createCodexMessagePhaseMeta(phase: string | null | undefined): AcpMeta | undefined {
    if (!phase) {
        return undefined;
    }
    return { codex: { phase } };
}

export function createUserMessageChunk(content: ContentBlock, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "user_message_chunk",
            messageId,
            content,
            ...(meta ? { _meta: meta } : {}),
        };
    }
    return {
        sessionUpdate: "user_message_chunk",
        content,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function createAgentMessageChunk(content: ContentBlock, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "agent_message_chunk",
            messageId,
            content,
            ...(meta ? { _meta: meta } : {}),
        };
    }
    return {
        sessionUpdate: "agent_message_chunk",
        content,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function createAgentThoughtChunk(content: ContentBlock, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    if (messageId) {
        return {
            sessionUpdate: "agent_thought_chunk",
            messageId,
            content,
            ...(meta ? { _meta: meta } : {}),
        };
    }
    return {
        sessionUpdate: "agent_thought_chunk",
        content,
        ...(meta ? { _meta: meta } : {}),
    };
}

export function createAgentTextMessageChunk(text: string, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    return createAgentMessageChunk({type: "text", text}, messageId, meta);
}

/**
 * Slash-command output: a transient SNAPSHOT (tool/process list, /status, /mcp),
 * not conversation.
 *
 * Without a marker a client cannot tell it apart from the assistant's own text,
 * so a command answered mid-turn gets adopted by the running turn. In vscode-acp's
 * compact mode the new messageId commits the in-flight bubble and
 * moveAssistantIntoFold() then demotes the command's answer into that turn's
 * COLLAPSED fold — it shows up inside an unrelated turn instead of next to the
 * command. Reported against ericli's /goal clear and /a2a register; the same
 * webview path renders codex-acp's /ps, /status, /skills and /mcp output, so it
 * applies here identically.
 *
 * ACP reserves _meta on ContentChunk for exactly this. `commandOutput: true` tells
 * the client to render a standalone transient row and keep it out of persisted
 * history — matching the fact that this output is a live snapshot that should not
 * survive a reload.
 */
export function createCommandOutputChunk(text: string, messageId?: string): UpdateSessionEvent {
    return createAgentTextMessageChunk(text, messageId, {commandOutput: true});
}

export function createAgentTextThoughtChunk(text: string, messageId?: string, meta?: AcpMeta): UpdateSessionEvent {
    return createAgentThoughtChunk({type: "text", text}, messageId, meta);
}
