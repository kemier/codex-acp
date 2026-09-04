/**
 * Slot KV cache save/restore via llama-server's slot API.
 *
 * Enables fast session resume by persisting the KV cache to disk
 * instead of re-prefilling the full conversation history on the
 * llama-server.
 *
 * Requires:
 *   - llama-server started with `--slot-save-path <dir>`
 *   - CODEX_LLAMA_SERVER_URL env var (e.g. "http://192.168.124.14:8008"), or
 *     fallback to the active provider's base_url in ~/.codex/config.toml
 *   - CODEX_SLOT_CACHE_ENABLED env var set to "true" (feature gate)
 *
 * Mirrors pi-acp's slot-cache (src/acp/slot-cache.ts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "./Logger";

const SAVE_TIMEOUT_MS = 30_000;
const RESTORE_TIMEOUT_MS = 60_000;
const SLOT_INFO_TIMEOUT_MS = 5_000;

type SlotCacheResult = {
    success: boolean;
    filename: string;
    nTokens: number;
    fileBytes: number;
    elapsedMs: number;
    error?: string;
};

export function isSlotCacheEnabled(): boolean {
    return process.env["CODEX_SLOT_CACHE_ENABLED"] === "true";
}

export function getLlamaServerUrl(): string | null {
    // Priority: env var > Codex config.toml (active provider's base_url).
    const envUrl = process.env["CODEX_LLAMA_SERVER_URL"];
    if (envUrl) {
        return envUrl.replace(/\/v1\/?$/, "");
    }
    try {
        const configPath = process.env["CODEX_CONFIG_PATH"]
            || path.join(os.homedir(), ".codex", "config.toml");
        const raw = fs.readFileSync(configPath, "utf-8");
        return extractLlamaServerBaseUrl(raw);
    } catch {
        // config missing or unreadable — fall through
    }
    return null;
}

/**
 * Extract the llama-server base URL (without /v1 suffix) from Codex
 * config.toml content. Resolves the top-level `model_provider` key into
 * the matching `[model_providers.<id>]` section and reads its `base_url`.
 *
 * Only top-level keys are considered for `model_provider` (lines before
 * any `[section]` header); `model_provider` keys inside `[profiles.*]` or
 * other sections are ignored.
 */
export function extractLlamaServerBaseUrl(configToml: string): string | null {
    const lines = configToml.split("\n");

    // Pass 1: top-level `model_provider` (before the first section header).
    let activeProvider: string | null = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[")) {
            break;
        }
        const providerId = trimmed.match(/^model_provider\s*=\s*"([A-Za-z0-9_-]+)"$/)?.[1];
        if (providerId !== undefined) {
            activeProvider = providerId;
        }
    }
    if (activeProvider === null) {
        return null;
    }

    // Pass 2: the [model_providers.<activeProvider>] section's base_url.
    let inTarget = false;
    for (const line of lines) {
        const trimmed = line.trim();
        const section = trimmed.match(/^\[(.+)\]$/);
        if (section) {
            inTarget = section[1] === `model_providers.${activeProvider}`;
            continue;
        }
        if (!inTarget) {
            continue;
        }
        const baseUrlValue = trimmed.match(/^base_url\s*=\s*"([^"]+)"$/)?.[1];
        if (baseUrlValue !== undefined) {
            return baseUrlValue.replace(/\/v1\/?$/, "");
        }
    }
    return null;
}

/**
 * Save the KV cache for a llama-server slot to a file.
 * @param slotId - The llama-server slot ID (0 for the default single slot)
 * @param filename - Base filename for the saved KV (e.g. session ID)
 * @returns Result with token count and file size
 */
export async function saveSlotCache(
    slotId: number,
    filename: string,
): Promise<SlotCacheResult> {
    const base = getLlamaServerUrl();
    if (!base) {
        return {
            success: false,
            filename,
            nTokens: 0,
            fileBytes: 0,
            elapsedMs: 0,
            error: "CODEX_LLAMA_SERVER_URL not set and no base_url in config.toml",
        };
    }

    const t0 = Date.now();
    try {
        const res = await fetch(`${base}/slots/${slotId}?action=save`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({filename}),
            signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
        });

        if (!res.ok) {
            const body = await res.text().catch(() => "");
            return {
                success: false,
                filename,
                nTokens: 0,
                fileBytes: 0,
                elapsedMs: Date.now() - t0,
                error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
            };
        }

        const data = (await res.json()) as Record<string, unknown>;
        return {
            success: true,
            filename: (data["filename"] as string) ?? filename,
            nTokens: (data["n_saved"] as number) ?? 0,
            fileBytes: (data["n_written"] as number) ?? 0,
            elapsedMs: Date.now() - t0,
        };
    } catch (e) {
        const err = e as Error | undefined;
        return {
            success: false,
            filename,
            nTokens: 0,
            fileBytes: 0,
            elapsedMs: Date.now() - t0,
            error: err?.message ?? String(e),
        };
    }
}

/**
 * Restore the KV cache for a llama-server slot from a file.
 * @param slotId - The llama-server slot ID (0 for the default single slot)
 * @param filename - Base filename of the saved KV
 * @returns Result with token count and file size
 */
export async function restoreSlotCache(
    slotId: number,
    filename: string,
): Promise<SlotCacheResult> {
    const base = getLlamaServerUrl();
    if (!base) {
        return {
            success: false,
            filename,
            nTokens: 0,
            fileBytes: 0,
            elapsedMs: 0,
            error: "CODEX_LLAMA_SERVER_URL not set and no base_url in config.toml",
        };
    }

    const t0 = Date.now();
    try {
        const res = await fetch(`${base}/slots/${slotId}?action=restore`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({filename}),
            signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS),
        });

        if (!res.ok) {
            const body = await res.text().catch(() => "");
            return {
                success: false,
                filename,
                nTokens: 0,
                fileBytes: 0,
                elapsedMs: Date.now() - t0,
                error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
            };
        }

        const data = (await res.json()) as Record<string, unknown>;
        return {
            success: true,
            filename: (data["filename"] as string) ?? filename,
            nTokens: (data["n_restored"] as number) ?? 0,
            fileBytes: (data["n_read"] as number) ?? 0,
            elapsedMs: Date.now() - t0,
        };
    } catch (e) {
        const err = e as Error | undefined;
        return {
            success: false,
            filename,
            nTokens: 0,
            fileBytes: 0,
            elapsedMs: Date.now() - t0,
            error: err?.message ?? String(e),
        };
    }
}

/**
 * Get the current slot info from llama-server.
 * Uses the `/slots` list endpoint — the single-slot `GET /slots/{id}`
 * endpoint returns 404 on some llama-server builds.
 * Returns null if the slot endpoint is unreachable (feature effectively off).
 */
export async function getSlotInfo(slotId: number = 0): Promise<{
    id: number;
    nPromptTokens: number;
    nPromptTokensCache: number;
    isProcessing: boolean;
} | null> {
    const base = getLlamaServerUrl();
    if (!base) {
        return null;
    }

    try {
        const res = await fetch(`${base}/slots`, {
            method: "GET",
            signal: AbortSignal.timeout(SLOT_INFO_TIMEOUT_MS),
        });
        if (!res.ok) {
            return null;
        }
        const data = (await res.json()) as Array<Record<string, unknown>>;
        const slot = data.find((entry) => entry["id"] === slotId);
        if (!slot) {
            return null;
        }
        return {
            id: (slot["id"] as number) ?? slotId,
            nPromptTokens: (slot["n_prompt_tokens"] as number) ?? 0,
            nPromptTokensCache: (slot["n_prompt_tokens_cache"] as number) ?? 0,
            isProcessing: (slot["is_processing"] as boolean) ?? false,
        };
    } catch {
        logger.log(`[slot-cache] slot info request failed for slot ${slotId}`);
        return null;
    }
}
