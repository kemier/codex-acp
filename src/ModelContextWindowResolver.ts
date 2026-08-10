import {logger} from "./Logger";

/**
 * Resolver for a model's real context window (in tokens), sourced from the
 * gateway's `/v1/models` `context_length` field.
 *
 * Why this exists: the upstream codex binary's `ModelDownshift` pre-turn
 * compaction guard (`codex-rs/core/src/session/turn.rs`) is inert for every
 * proxy-routed model. `model_info_from_slug` (`models-manager/src/model_info.rs`)
 * hardcodes `context_window: Some(272_000)` for any slug not in codex's built-in
 * model table — which is ALL of our proxy models (deepseek/glm/qwen/kimi/mimo/
 * gpt-oss). codex-acp does not pass `model_context_window` in the Config sent to
 * codex, so `with_config_overrides` never overrides the 272k fallback. The
 * `ModelDownshift` condition `old_context_window > new_context_window` is then
 * `272000 > 272000 = false` for any proxy→proxy switch and the guard never fires
 * — an oversized history goes through to the backend under the new (smaller)
 * real window and the IDE context ring shows >100%.
 *
 * This resolver lets codex-acp learn the REAL window per model (e.g.
 * deepseek-v4-flash=262144, glm-5.2=196608, glm-5.1=131072) so a proactive
 * pre-turn compaction guard in `CodexAcpServer` can compact BEFORE forwarding
 * when the last prompt size exceeds the new model's real window. Mirrors
 * claude-code-acp's `loadModelContextWindows` / `getContextWindowForModel`
 * (`agent.ts:217/293`), the reference pattern.
 *
 * The map is keyed by the gateway `base_url` so that switching providers
 * (vscode-acp `providers/set`) re-fetches against the new gateway instead of
 * returning the old gateway's windows.
 */
export class ModelContextWindowResolver {
    /** Per-gateway cache: base_url → (model id → context_length). */
    private readonly cache = new Map<string, Map<string, number>>();
    /** Per-gateway "loaded" gate; only set on a SUCCEEDED non-empty fetch. */
    private readonly loaded = new Map<string, boolean>();
    /** Per-gateway in-flight fetch promise so concurrent callers share one request. */
    private readonly inFlight = new Map<string, Promise<Map<string, number>>>();
    /** Per-gateway last-success timestamp (ms), for TTL refresh. */
    private readonly fetchedAt = new Map<string, number>();

    private readonly fetchImpl: typeof fetch;
    private readonly now: () => number;
    /** Re-fetch if older than this (ms). 0 = never re-fetch once loaded. */
    private readonly ttlMs: number;

    constructor(opts?: {
        fetchImpl?: typeof fetch;
        now?: () => number;
        ttlMs?: number;
    }) {
        this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
        this.now = opts?.now ?? (() => Date.now());
        this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    }

    /**
     * Resolve the real context window for `modelId` from the gateway at
     * `baseUrl`. Returns `undefined` when the window is unknown (gateway not yet
     * fetched, model absent from `/v1/models`, or fetch failed). A `undefined`
     * return tells the caller to SKIP the proactive guard — without a real
     * window we cannot tell whether the history exceeds it, and the display cap
     * in `createUsageUpdate` is the only backstop. Never throws.
     */
    async resolve(baseUrl: string, modelId: string): Promise<number | undefined> {
        const normalized = normalizeBaseUrl(baseUrl);
        const map = await this.load(normalized);
        return map.get(modelId);
    }

    /**
     * Load (and cache) the model→window map for a gateway. Concurrent callers
     * share one in-flight fetch. A FAILED fetch (network error, non-200, empty
     * body) leaves the cache empty and retryable so a transiently-unreachable
     * gateway at process spawn does not freeze the map empty for the whole
     * session — the next caller retries.
     */
    private async load(normalizedBaseUrl: string): Promise<Map<string, number>> {
        const cached = this.cache.get(normalizedBaseUrl);
        const isLoaded = this.loaded.get(normalizedBaseUrl) === true;
        const age = this.fetchedAt.has(normalizedBaseUrl)
            ? this.now() - (this.fetchedAt.get(normalizedBaseUrl) as number)
            : Infinity;
        if (cached && isLoaded && age < this.ttlMs) {
            return cached;
        }

        const existing = this.inFlight.get(normalizedBaseUrl);
        if (existing) {
            return existing;
        }

        const promise = this.doFetch(normalizedBaseUrl)
            .finally(() => {
                this.inFlight.delete(normalizedBaseUrl);
            });
        this.inFlight.set(normalizedBaseUrl, promise);
        return promise;
    }

    private async doFetch(normalizedBaseUrl: string): Promise<Map<string, number>> {
        const url = `${normalizedBaseUrl}/models`;
        try {
            const resp = await this.fetchImpl(url, {
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!resp.ok) {
                logger.log(`ModelContextWindowResolver: /v1/models fetch failed (${resp.status}) for ${url}`);
                return EMPTY;
            }
            const body = await resp.json() as { data?: Array<{ id?: string; context_length?: number }> };
            const map = new Map<string, number>();
            if (Array.isArray(body.data)) {
                for (const m of body.data) {
                    if (
                        typeof m?.id === "string" &&
                        typeof m.context_length === "number" &&
                        m.context_length > 0
                    ) {
                        map.set(m.id, m.context_length);
                    }
                }
            }
            if (map.size === 0) {
                logger.log(`ModelContextWindowResolver: /v1/models returned no models for ${url}`);
                return EMPTY;
            }
            this.cache.set(normalizedBaseUrl, map);
            this.loaded.set(normalizedBaseUrl, true);
            this.fetchedAt.set(normalizedBaseUrl, this.now());
            logger.log(`ModelContextWindowResolver: loaded ${map.size} model context windows from ${url}`);
            return map;
        } catch (err) {
            logger.error(
                `ModelContextWindowResolver: could not fetch /v1/models from ${url}`,
                err,
            );
            return EMPTY;
        }
    }
}

const EMPTY = new Map<string, number>();

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FETCH_TIMEOUT_MS = 5000;

/**
 * Strip a trailing `/v1` (or trailing slashes) so that `${base}/models`
 * produces `${base}/v1/models` when the caller passes the proxy root, and does
 * NOT double up when the caller already includes `/v1`. The gateway
 * `config.base_url` is the OpenAI-compatible root and may or may not carry the
 * `/v1` suffix depending on how the provider was configured; normalize both
 * shapes to a root without a trailing slash.
 */
function normalizeBaseUrl(baseUrl: string): string {
    let url = baseUrl.trim();
    while (url.endsWith("/")) {
        url = url.slice(0, -1);
    }
    if (url.endsWith("/v1")) {
        url = url.slice(0, -3);
    }
    return url;
}
