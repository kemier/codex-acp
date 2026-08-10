// noinspection ES6RedundantAwait

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type {McpServerStdio} from "@agentclientprotocol/sdk";
import {startCodexConnection} from "../../CodexJsonRpcConnection";
import {createBaseTestFixture, removeDirectoryWithRetry, type TestFixture} from "../acp-test-utils";

describe('MCP config merge across configured MCP servers and ACP request', { timeout: 40_000 }, () => {

    let codexHome: string;
    let projectPath: string;
    let fixture: TestFixture;
    let codexProcess: import("node:child_process").ChildProcess;

    beforeEach(() => {
        vi.clearAllMocks();

        const globalConfig = `
[mcp_servers.shared-mcp]
url = "https://example.com/mcp"
`;

        const projectConfig = `
[mcp_servers.project-mcp]
url = "https://example.com/mcp"
`;

        codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-mcp-merge-"));
        fs.writeFileSync(path.join(codexHome, "config.toml"), globalConfig, "utf8");
        projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-mcp-project-"));
        fs.mkdirSync(path.join(projectPath, ".codex"));
        fs.writeFileSync(path.join(projectPath, ".codex", "config.toml"), projectConfig, "utf8");

        const codexConnection = startCodexConnection(undefined, {
            ...process.env,
            CODEX_HOME: codexHome,
        });
        codexProcess = codexConnection.process;

        fixture = createBaseTestFixture({
            connection: codexConnection.connection,
            getExitCode: () => codexConnection.process.exitCode,
            dispose: async () => {
                // Kill the child so it releases its SQLite handles before the
                // dir is removed (otherwise rmSync hits EBUSY and leaks). See
                // createTestFixture's dispose for the same pattern.
                try {
                    if (!codexProcess.killed) {
                        codexProcess.kill("SIGTERM");
                    }
                } catch {
                    // already exited
                }
                await new Promise<void>((resolve) => {
                    if (codexProcess.exitCode !== null || codexProcess.signalCode !== null) {
                        return resolve();
                    }
                    const to = setTimeout(() => {
                        try {
                            if (codexProcess.exitCode === null && codexProcess.signalCode === null) {
                                codexProcess.kill("SIGKILL");
                            }
                        } catch {
                            // already gone
                        }
                        resolve();
                    }, 2000);
                    codexProcess.once("exit", () => {
                        clearTimeout(to);
                        resolve();
                    });
                });
                // Now that the child has exited and released its SQLite WAL
                // handles, remove the CODEX_HOME dir. (The afterEach used to do
                // this, but the dir must be removed AFTER the process exits,
                // which is here — afterEach runs the dispose hook first.)
                removeDirectoryWithRetry(codexHome);
            },
        });
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        // dispose() kills the codex child + removes codexHome; the projectPath
        // dir has no process, just remove it. disposeAllTestFixtures would also
        // work, but this file creates exactly one fixture so a direct dispose
        // is sufficient and clearer.
        await fixture.dispose();
        removeDirectoryWithRetry(projectPath);
    });

    it('should preserve the global url-based MCP when ACP passes a command-type MCP with the same name', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);

        const conflictingMcp: McpServerStdio = {
            name: "shared-mcp",
            command: "./node_modules/.bin/mcp-hello-world",
            args: ["example"],
            env: [{name: "example", value: "example"}],
        };

        const newSessionResponse = await codexAcpAgent.newSession({
            cwd: "",
            mcpServers: [conflictingMcp],
        });
        fixture.clearAcpConnectionDump();

        await codexAcpAgent.prompt({
            sessionId: newSessionResponse.sessionId,
            prompt: [{type: "text", text: "/mcp"}],
        });

        const transportDump = fixture.getAcpConnectionDump([]);
        expect(transportDump).contain("Configured MCP servers:");
        expect(transportDump).contain("- shared-mcp");
    });

    it('should preserve a project url-based MCP when ACP passes a command-type MCP with the same name', async () => {
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});
        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);

        const conflictingMcp = {
            name: "project-mcp",
            command: "./node_modules/.bin/mcp-hello-world",
            args: ["example"],
            env: [{name: "example", value: "example"}],
        };

        await expect(codexAcpAgent.newSession({
            cwd: projectPath,
            mcpServers: [conflictingMcp],
        })).resolves.toBeDefined();
    });

    it('should not filter the conflicting ACP MCP when config filtering is disabled', async () => {
        vi.stubEnv("DISABLE_MCP_CONFIG_FILTERING", "true");
        const codexAcpAgent = fixture.getCodexAcpAgent();
        await codexAcpAgent.initialize({protocolVersion: 1});

        fixture.getCodexAcpClient().authRequired = vi.fn().mockResolvedValue(false);

        const conflictingMcp: McpServerStdio = {
            name: "shared-mcp",
            command: "./node_modules/.bin/mcp-hello-world",
            args: ["example"],
            env: [{name: "example", value: "example"}],
        };

        await expect(codexAcpAgent.newSession({
            cwd: "",
            mcpServers: [conflictingMcp],
        })).rejects.toMatchObject({
            data: expect.stringContaining("url is not supported for stdio"),
        });
    });
});
