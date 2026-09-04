import {describe, expect, it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {extractLlamaServerBaseUrl, getLlamaServerUrl, isSlotCacheEnabled} from "../SlotCache";

describe("extractLlamaServerBaseUrl", () => {
    it("resolves the active provider's base_url from the top-level model_provider", () => {
        const toml = [
            'model_provider = "llama-direct"',
            'model = "qwen38-27b"',
            "disable_response_storage = true",
            "",
            '[model_providers.llama-direct]',
            'name = "llama-direct"',
            'base_url = "http://192.168.124.14:8008/v1"',
            'wire_api = "responses"',
            "experimental_bearer_token = \"local\"",
        ].join("\n");
        expect(extractLlamaServerBaseUrl(toml)).toBe("http://192.168.124.14:8008");
    });

    it("strips a bare /v1 suffix", () => {
        const toml = [
            'model_provider = "vllm"',
            "",
            '[model_providers.vllm]',
            'base_url = "http://127.0.0.1:8000/v1"',
        ].join("\n");
        expect(extractLlamaServerBaseUrl(toml)).toBe("http://127.0.0.1:8000");
    });

    it("keeps base_urls without a /v1 suffix untouched", () => {
        const toml = [
            'model_provider = "p"',
            "",
            '[model_providers.p]',
            'base_url = "http://host:9999"',
        ].join("\n");
        expect(extractLlamaServerBaseUrl(toml)).toBe("http://host:9999");
    });

    it("ignores model_provider keys inside [profiles.*] sections", () => {
        const toml = [
            'model_provider = "a"',
            "",
            "[profiles.other]",
            'model_provider = "b"',
            "",
            "[model_providers.b]",
            'base_url = "http://wrong:1/v1"',
            "",
            "[model_providers.a]",
            'base_url = "http://right:2/v1"',
        ].join("\n");
        expect(extractLlamaServerBaseUrl(toml)).toBe("http://right:2");
    });

    it("returns null when the active provider section is missing", () => {
        const toml = [
            'model_provider = "missing"',
            "",
            "[model_providers.other]",
            'base_url = "http://wrong:1/v1"',
        ].join("\n");
        expect(extractLlamaServerBaseUrl(toml)).toBe(null);
    });

    it("returns null when no model_provider is set", () => {
        const toml = [
            "[model_providers.vllm]",
            'base_url = "http://host:1/v1"',
        ].join("\n");
        expect(extractLlamaServerBaseUrl(toml)).toBe(null);
    });
});

describe("isSlotCacheEnabled", () => {
    it("is off by default", () => {
        const saved = process.env["CODEX_SLOT_CACHE_ENABLED"];
        delete process.env["CODEX_SLOT_CACHE_ENABLED"];
        try {
            expect(isSlotCacheEnabled()).toBe(false);
        } finally {
            if (saved === undefined) {
                delete process.env["CODEX_SLOT_CACHE_ENABLED"];
            } else {
                process.env["CODEX_SLOT_CACHE_ENABLED"] = saved;
            }
        }
    });

    it("is on only when set to exactly \"true\"", () => {
        const saved = process.env["CODEX_SLOT_CACHE_ENABLED"];
        try {
            process.env["CODEX_SLOT_CACHE_ENABLED"] = "true";
            expect(isSlotCacheEnabled()).toBe(true);
            process.env["CODEX_SLOT_CACHE_ENABLED"] = "TRUE";
            expect(isSlotCacheEnabled()).toBe(false);
            process.env["CODEX_SLOT_CACHE_ENABLED"] = "1";
            expect(isSlotCacheEnabled()).toBe(false);
        } finally {
            if (saved === undefined) {
                delete process.env["CODEX_SLOT_CACHE_ENABLED"];
            } else {
                process.env["CODEX_SLOT_CACHE_ENABLED"] = saved;
            }
        }
    });
});

describe("getLlamaServerUrl", () => {
    it("prefers CODEX_LLAMA_SERVER_URL and strips /v1", () => {
        const savedUrl = process.env["CODEX_LLAMA_SERVER_URL"];
        const savedPath = process.env["CODEX_CONFIG_PATH"];
        try {
            delete process.env["CODEX_CONFIG_PATH"];
            process.env["CODEX_LLAMA_SERVER_URL"] = "http://192.168.124.14:8008/v1";
            expect(getLlamaServerUrl()).toBe("http://192.168.124.14:8008");
        } finally {
            if (savedUrl === undefined) {
                delete process.env["CODEX_LLAMA_SERVER_URL"];
            } else {
                process.env["CODEX_LLAMA_SERVER_URL"] = savedUrl;
            }
            if (savedPath === undefined) {
                delete process.env["CODEX_CONFIG_PATH"];
            } else {
                process.env["CODEX_CONFIG_PATH"] = savedPath;
            }
        }
    });

    it("falls back to CODEX_CONFIG_PATH config.toml", () => {
        const savedUrl = process.env["CODEX_LLAMA_SERVER_URL"];
        const savedPath = process.env["CODEX_CONFIG_PATH"];
        const tmp = path.join(
            os.tmpdir(),
            `codex-slotcache-${Date.now()}-${Math.random().toString(16).slice(2)}.toml`,
        );
        fs.writeFileSync(tmp, [
            'model_provider = "llama-direct"',
            "",
            "[model_providers.llama-direct]",
            'base_url = "http://10.0.0.1:9000/v1"',
        ].join("\n"));
        try {
            delete process.env["CODEX_LLAMA_SERVER_URL"];
            process.env["CODEX_CONFIG_PATH"] = tmp;
            expect(getLlamaServerUrl()).toBe("http://10.0.0.1:9000");
        } finally {
            fs.unlinkSync(tmp);
            if (savedUrl === undefined) {
                delete process.env["CODEX_LLAMA_SERVER_URL"];
            } else {
                process.env["CODEX_LLAMA_SERVER_URL"] = savedUrl;
            }
            if (savedPath === undefined) {
                delete process.env["CODEX_CONFIG_PATH"];
            } else {
                process.env["CODEX_CONFIG_PATH"] = savedPath;
            }
        }
    });

    it("returns null when neither env var nor config file exist", () => {
        const savedUrl = process.env["CODEX_LLAMA_SERVER_URL"];
        const savedPath = process.env["CODEX_CONFIG_PATH"];
        try {
            delete process.env["CODEX_LLAMA_SERVER_URL"];
            process.env["CODEX_CONFIG_PATH"] = "/nonexistent/codex-config.toml";
            expect(getLlamaServerUrl()).toBe(null);
        } finally {
            if (savedUrl === undefined) {
                delete process.env["CODEX_LLAMA_SERVER_URL"];
            } else {
                process.env["CODEX_LLAMA_SERVER_URL"] = savedUrl;
            }
            if (savedPath === undefined) {
                delete process.env["CODEX_CONFIG_PATH"];
            } else {
                process.env["CODEX_CONFIG_PATH"] = savedPath;
            }
        }
    });
});
