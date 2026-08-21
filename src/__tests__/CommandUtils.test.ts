import { describe, expect, it } from "vitest";
import { stripShellPrefix } from "../CommandUtils";

describe("stripShellPrefix", () => {
    it("strips cd prefix by default", () => {
        expect(stripShellPrefix("cd /workspace/git/ezennin/codex-acp && npm test")).toBe("npm test");
        expect(stripShellPrefix("cd /workspace/git/ezennin/codex-acp\nnpm test")).toBe("npm test");
        expect(stripShellPrefix("bash -c 'cd /workspace && ls -la'")).toBe("ls -la");
        expect(stripShellPrefix("cd /tmp")).toBe("cd /tmp");
    });

    it("keeps cd when it matches cwd", () => {
        expect(
            stripShellPrefix("cd /workspace/git/ezennin/codex-acp && npm test", "/workspace/git/ezennin/codex-acp")
        ).toBe("cd /workspace/git/ezennin/codex-acp && npm test");
        expect(
            stripShellPrefix("cd /workspace/git/ezennin/codex-acp\nnpm test", "/workspace/git/ezennin/codex-acp/")
        ).toBe("cd /workspace/git/ezennin/codex-acp\nnpm test");
        expect(stripShellPrefix("cd /workspace/git/ezennin/codex-acp && npm test", "/tmp")).toBe("npm test");
        expect(stripShellPrefix("bash -c 'cd /workspace && ls -la'", "/workspace")).toBe("cd /workspace && ls -la");
    });
});
