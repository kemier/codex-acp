import {describe, it, expect, vi, beforeEach} from 'vitest';
import {ModelContextWindowResolver} from '../ModelContextWindowResolver';

/**
 * Minimal fetch double: returns a Response-like object from a queued handler.
 * Tests register the response (or error) for the next fetch call.
 */
function makeFetchDouble() {
    const calls: {url: string}[] = [];
    let next: ((url: string) => Promise<{ok: boolean; status: number; json: () => Promise<unknown>}> | never) | null = null;
    const fetchImpl = vi.fn(async (url: string) => {
        calls.push({url});
        if (!next) {
            throw new Error(`unexpected fetch to ${url}`);
        }
        const handler = next;
        next = null;
        return handler(url);
    });
    const enqueue = (resp: {ok: boolean; status: number; json: () => Promise<unknown>}) => {
        next = () => Promise.resolve(resp);
    };
    const enqueueError = (err: unknown) => {
        next = () => {
            throw err;
        };
    };
    return {fetchImpl, calls, enqueue, enqueueError};
}

function modelsResponse(data: Array<{id: string; context_length: number}>) {
    return {
        ok: true,
        status: 200,
        json: async () => ({data}),
    };
}

describe('ModelContextWindowResolver', () => {
    let clock = 0;
    let fetchDouble: ReturnType<typeof makeFetchDouble>;

    beforeEach(() => {
        clock = 0;
        fetchDouble = makeFetchDouble();
    });

    it('fetches /v1/models and returns the context_length for a model', async () => {
        fetchDouble.enqueue(modelsResponse([
            {id: 'glm-5.2', context_length: 196608},
            {id: 'deepseek-v4-flash', context_length: 262144},
        ]));
        const resolver = new ModelContextWindowResolver({
            fetchImpl: fetchDouble.fetchImpl as any,
            now: () => clock,
        });

        const window = await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2');

        expect(window).toBe(196608);
        expect(fetchDouble.calls).toHaveLength(1);
        expect(fetchDouble.calls[0]!.url).toBe('http://127.0.0.1:8317/models');
    });

    it('caches across calls — second resolve does not refetch within TTL', async () => {
        fetchDouble.enqueue(modelsResponse([{id: 'glm-5.2', context_length: 196608}]));
        const resolver = new ModelContextWindowResolver({
            fetchImpl: fetchDouble.fetchImpl as any,
            now: () => clock,
            ttlMs: 10_000,
        });

        await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2');
        clock += 5_000; // within TTL
        const window = await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2');

        expect(window).toBe(196608);
        expect(fetchDouble.calls).toHaveLength(1); // no second fetch
    });

    it('re-fetches after the TTL expires', async () => {
        fetchDouble.enqueue(modelsResponse([{id: 'glm-5.2', context_length: 196608}]));
        const resolver = new ModelContextWindowResolver({
            fetchImpl: fetchDouble.fetchImpl as any,
            now: () => clock,
            ttlMs: 10_000,
        });

        await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2');
        clock += 11_000; // TTL expired
        fetchDouble.enqueue(modelsResponse([{id: 'glm-5.2', context_length: 200000}])); // updated
        const window = await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2');

        expect(window).toBe(200000);
        expect(fetchDouble.calls).toHaveLength(2);
    });

    it('returns undefined for an unknown model (no spurious compaction)', async () => {
        fetchDouble.enqueue(modelsResponse([{id: 'glm-5.2', context_length: 196608}]));
        const resolver = new ModelContextWindowResolver({
            fetchImpl: fetchDouble.fetchImpl as any,
            now: () => clock,
        });

        const window = await resolver.resolve('http://127.0.0.1:8317/v1', 'unknown-model');

        expect(window).toBeUndefined();
    });

    it('uses exact id match — the proxy advertises short ids matching the ACP picker', async () => {
        // The proxy /v1/models serves short ids (deepseek-v4-flash, glm-5.2, …)
        // that match what the ACP model picker sends, so exact match suffices.
        // No fuzzy/prefix matching is performed — it would risk matching the
        // wrong model (e.g. "glm-5.1" vs "glm-5.2").
        fetchDouble.enqueue(modelsResponse([
            {id: 'deepseek-v4-flash', context_length: 262144},
            {id: 'glm-5.2', context_length: 196608},
            {id: 'glm-5.1', context_length: 131072},
        ]));
        const resolver = new ModelContextWindowResolver({
            fetchImpl: fetchDouble.fetchImpl as any,
            now: () => clock,
        });

        expect(await resolver.resolve('http://127.0.0.1:8317/v1', 'deepseek-v4-flash')).toBe(262144);
        expect(await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2')).toBe(196608);
        expect(await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.1')).toBe(131072);
        // A near-match must NOT resolve (no false positives).
        expect(await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.3')).toBeUndefined();
        expect(fetchDouble.calls).toHaveLength(1); // cached after first fetch
    });

    it('returns undefined (not throw) when fetch fails — stays retryable', async () => {
        fetchDouble.enqueueError(new Error('ECONNREFUSED'));
        const resolver = new ModelContextWindowResolver({
            fetchImpl: fetchDouble.fetchImpl as any,
            now: () => clock,
        });

        const window = await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2');

        expect(window).toBeUndefined();
        // A failed fetch must NOT mark the cache loaded — the next caller retries.
        fetchDouble.enqueue(modelsResponse([{id: 'glm-5.2', context_length: 196608}]));
        const window2 = await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2');
        expect(window2).toBe(196608);
        expect(fetchDouble.calls).toHaveLength(2);
    });

    it('returns undefined when /v1/models returns non-200', async () => {
        fetchDouble.enqueue({ok: false, status: 503, json: async () => ({})});
        const resolver = new ModelContextWindowResolver({
            fetchImpl: fetchDouble.fetchImpl as any,
            now: () => clock,
        });

        const window = await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2');

        expect(window).toBeUndefined();
    });

    it('returns undefined when /v1/models returns an empty data array', async () => {
        fetchDouble.enqueue(modelsResponse([]));
        const resolver = new ModelContextWindowResolver({
            fetchImpl: fetchDouble.fetchImpl as any,
            now: () => clock,
        });

        const window = await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2');

        expect(window).toBeUndefined();
    });

    it('normalizes a base_url with a trailing /v1 suffix', async () => {
        fetchDouble.enqueue(modelsResponse([{id: 'glm-5.2', context_length: 196608}]));
        const resolver = new ModelContextWindowResolver({
            fetchImpl: fetchDouble.fetchImpl as any,
            now: () => clock,
        });

        await resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2');

        // /v1 suffix stripped, then /models appended → /v1/models (not /v1/v1/models)
        expect(fetchDouble.calls[0]!.url).toBe('http://127.0.0.1:8317/models');
    });

    it('normalizes a base_url with trailing slashes', async () => {
        fetchDouble.enqueue(modelsResponse([{id: 'glm-5.2', context_length: 196608}]));
        const resolver = new ModelContextWindowResolver({
            fetchImpl: fetchDouble.fetchImpl as any,
            now: () => clock,
        });

        await resolver.resolve('http://127.0.0.1:8317/v1///', 'glm-5.2');

        expect(fetchDouble.calls[0]!.url).toBe('http://127.0.0.1:8317/models');
    });

    it('caches per-gateway — switching providers re-fetches', async () => {
        fetchDouble.enqueue(modelsResponse([{id: 'glm-5.2', context_length: 196608}]));
        const resolver = new ModelContextWindowResolver({
            fetchImpl: fetchDouble.fetchImpl as any,
            now: () => clock,
            ttlMs: 60_000,
        });

        await resolver.resolve('http://gateway-a:8317/v1', 'glm-5.2');
        // Different gateway base → must refetch even though TTL hasn't expired.
        fetchDouble.enqueue(modelsResponse([{id: 'glm-5.2', context_length: 131072}]));
        const window = await resolver.resolve('http://gateway-b:8317/v1', 'glm-5.2');

        expect(window).toBe(131072);
        expect(fetchDouble.calls).toHaveLength(2);
    });

    it('shares a single in-flight fetch across concurrent callers', async () => {
        fetchDouble.enqueue(modelsResponse([{id: 'glm-5.2', context_length: 196608}]));
        const resolver = new ModelContextWindowResolver({
            fetchImpl: fetchDouble.fetchImpl as any,
            now: () => clock,
        });

        // Three concurrent resolves for the same gateway — one fetch.
        const [a, b, c] = await Promise.all([
            resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2'),
            resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2'),
            resolver.resolve('http://127.0.0.1:8317/v1', 'glm-5.2'),
        ]);

        expect(a).toBe(196608);
        expect(b).toBe(196608);
        expect(c).toBe(196608);
        expect(fetchDouble.calls).toHaveLength(1);
    });
});
