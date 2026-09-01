import { describe, expect, it } from "vitest";
import { stripShellPrefix } from "../CommandUtils";

const CWD = "/workspace/git/ezennin/codex-acp";

describe("stripShellPrefix", () => {
    it("strips cd prefix by default", () => {
        expect(stripShellPrefix(`cd ${CWD} && npm test`)).toBe("npm test");
        expect(stripShellPrefix(`cd ${CWD}\nnpm test`)).toBe("npm test");
        expect(stripShellPrefix("bash -c 'cd /workspace && ls -la'")).toBe("ls -la");
        expect(stripShellPrefix("cd /tmp")).toBe("cd /tmp");
    });

    it("strips the cd when it targets the session cwd", () => {
        // The session already runs there — announcing it wastes the one line the
        // client renders.
        expect(stripShellPrefix(`cd ${CWD} && npm test`, CWD)).toBe("npm test");
        expect(stripShellPrefix(`cd ${CWD}\nnpm test`, `${CWD}/`)).toBe("npm test");
        expect(stripShellPrefix("bash -c 'cd /workspace && ls -la'", "/workspace")).toBe("ls -la");
    });

    it("keeps a cd into a subdirectory, rewritten relative", () => {
        expect(stripShellPrefix(`cd ${CWD}/src && npm test`, CWD)).toBe("cd src && npm test");
        expect(stripShellPrefix(`cd ${CWD}/src/__tests__; ls`, CWD)).toBe("cd src/__tests__; ls");
        // Newline form: stripped even for a subdirectory (only line 1 is rendered).
        expect(stripShellPrefix(`cd ${CWD}/src\nnpm test`, CWD)).toBe("npm test");
    });

    it("strips a cd that points outside the session cwd", () => {
        expect(stripShellPrefix(`cd ${CWD} && npm test`, "/tmp")).toBe("npm test");
        expect(stripShellPrefix("cd /workspace/git/ezennin/vscode-acp && ls", CWD)).toBe("ls");
        expect(stripShellPrefix("cd ../vscode-acp && ls", CWD)).toBe("ls");
    });

    it("is idempotent on an already-normalized relative title", () => {
        // The client (vscode-acp) applies the same rule; a second pass must not
        // strip the subdirectory the first pass deliberately kept.
        expect(stripShellPrefix("cd src && npm test", CWD)).toBe("cd src && npm test");
        expect(stripShellPrefix("cd src/__tests__; ls", CWD)).toBe("cd src/__tests__; ls");
    });

    it("handles the semicolon form like &&", () => {
        expect(stripShellPrefix("cd /tmp; ls -la", CWD)).toBe("ls -la");
        expect(stripShellPrefix(`cd ${CWD}; npm test`, CWD)).toBe("npm test");
    });
});
