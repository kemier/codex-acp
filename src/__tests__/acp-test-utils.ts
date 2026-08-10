import * as acp from "@agentclientprotocol/sdk";
import type {CreateElicitationResponse, McpServerStdio, RequestPermissionResponse} from "@agentclientprotocol/sdk";
import {CodexAcpClient} from '../CodexAcpClient';
import {CodexAppServerClient, type CodexConnectionEvent} from '../CodexAppServerClient';
import {startCodexConnection} from "../CodexJsonRpcConnection";
import {CodexAcpServer, type SessionState} from "../CodexAcpServer";
import {ModelContextWindowResolver} from "../ModelContextWindowResolver";
import type {AcpClientConnection} from "../ACPSessionConnection";
import type {ServerNotification} from "../app-server";
import type {MessageConnection} from "vscode-jsonrpc/node";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {AgentMode} from "../AgentMode";
import {DEFAULT_COLLABORATION_MODE} from "../CollaborationModeConfig";
import {expect, vi} from "vitest";
import type {Model, ReasoningEffortOption} from "../app-server/v2";

export type MethodCallEvent = { method: string; args: any[] };

export interface SmartMockConfig {
    returnValues?: Map<string, (args: any[]) => any>;
}

export function createSmartMock<T extends object>(
    onCall: (event: MethodCallEvent) => void,
    config?: SmartMockConfig
) {
    return new Proxy({} as T, {
        get(_, prop) {
            return (...args: any[]) => {
                onCall({ method: String(prop), args });
                const returnValueFn = config?.returnValues?.get(String(prop));
                if (returnValueFn) {
                    return returnValueFn(args);
                }
                return { mock: "Mocked return" };
            };
        }
    });
}

function normalizeAcpConnectionEvent(event: MethodCallEvent): MethodCallEvent {
    if (event.method === "request" && event.args[0] === acp.methods.client.session.requestPermission) {
        return {method: "requestPermission", args: [event.args[1]]};
    }
    if (event.method === "request" && event.args[0] === acp.methods.client.elicitation.create) {
        return {method: "createElicitation", args: [event.args[1]]};
    }
    if (event.method === "notify" && event.args[0] === acp.methods.client.elicitation.complete) {
        return {method: "completeElicitation", args: [event.args[1]]};
    }
    if (event.method === "notify" && event.args[0] === acp.methods.client.session.update) {
        return {method: "sessionUpdate", args: [event.args[1]]};
    }
    return event;
}

export interface TestFixture {
    getCodexAppServerClient(): CodexAppServerClient,
    getCodexAcpClient(): CodexAcpClient,
    getCodexAcpAgent(): CodexAcpServer,
    /** Stub resolver injected into the agent; configure via `.set(model, window)`. */
    getModelContextWindowResolver(): StubModelContextWindowResolver,

    onCodexConnectionEvent(handler: (event: CodexConnectionEvent) => void): void,
    getCodexConnectionEvents(ignoredFields: string[], options?: CodexConnectionDumpOptions): CodexConnectionEvent[],
    getCodexConnectionDump(ignoredFields: string[], options?: CodexConnectionDumpOptions): string,
    clearCodexConnectionDump(): void,

    onAcpConnectionEvent(handler: (event: MethodCallEvent) => void): void,
    getAcpConnectionEvents(ignoredFields: string[]): MethodCallEvent[],
    getAcpConnectionDump(ignoredFields: string[]): string,
    clearAcpConnectionDump(): void,

    /**
     * Tear down the fixture: kill the spawned codex child process (if any) and
     * remove its `CODEX_HOME` temp dir. MUST be called in `afterEach` by tests
     * that use `createTestFixture` (the real-binary path) — otherwise each test
     * leaks a `codex-acp-codex-home-*` dir (~8,160 inodes each), which exhausts
     * the `/tmp` tmpfs 1M-inode cap over a full suite and cascades into
     * `ENOSPC` failures in unrelated code paths (including the shell's AFS
     * module init, whose Tcl `[exec id -u]` creates a temp file in `/tmp`).
     * Safe to call on mock fixtures (no-op when there is no process/dir).
     * Returns a Promise so callers can `await fixture.dispose()` in
     * `afterEach` — this lets the codex child actually exit (releasing its
     * SQLite WAL handles) before the temp dir is removed.
     */
    dispose(): Promise<void>,
}

export interface CodexConnectionDumpOptions {
    placeholderResponseMethods?: string[];
}

/**
 * Test-only stub for `ModelContextWindowResolver`. Returns `undefined` (no
 * window known → the proactive guard skips compaction) by default, so existing
 * tests that don't care about the guard behave exactly as before. Tests that
 * DO exercise the guard call `.set(modelId, window)` to seed a known window,
 * and can spy on `.resolve` / `.compactCalls` (via the agent's `runCompact`)
 * to assert compaction fired — all without touching the network.
 */
export class StubModelContextWindowResolver extends ModelContextWindowResolver {
    private readonly windows = new Map<string, number>();
    /** Number of times `resolve` was consulted (regardless of outcome). */
    public resolveCalls = 0;

    /** Seed a known context window for a model id. */
    set(modelId: string, window: number): this {
        this.windows.set(modelId, window);
        return this;
    }

    override async resolve(_baseUrl: string, modelId: string): Promise<number | undefined> {
        this.resolveCalls += 1;
        return this.windows.get(modelId);
    }
}

export interface AcpConnectionConfig {
    connection: AcpClientConnection;
    events: MethodCallEvent[];
    eventHandlers: ((event: MethodCallEvent) => void)[];
}

export interface ConnectionConfig {
    connection: MessageConnection;
    getExitCode: () => number | null;
    acpConnection?: AcpConnectionConfig;
    /**
     * Optional teardown hook invoked by `fixture.dispose()`. `createTestFixture`
     * (the real-binary path) supplies this to kill the spawned codex child and
     * remove its `CODEX_HOME` temp dir. Mock fixtures omit it (dispose is a
     * no-op). See `TestFixture.dispose` for why this matters. Async so the
     * hook can await the child's exit before removing the dir.
     */
    dispose?: () => Promise<void> | void;
}

export function createBaseTestFixture(config: ConnectionConfig): TestFixture {
    const acpConnectionEvents = config.acpConnection?.events ?? [];
    const acpEventHandlers = config.acpConnection?.eventHandlers ?? [];
    const acpConnection = config.acpConnection?.connection ?? createSmartMock<AcpClientConnection>((event) => {
        const normalizedEvent = normalizeAcpConnectionEvent(event);
        acpConnectionEvents.push(normalizedEvent);
        acpEventHandlers.forEach(handler => handler(normalizedEvent));
    });

    const codexAppServerClient = new CodexAppServerClient(config.connection);
    const codexAcpClient = new CodexAcpClient(codexAppServerClient);
    // Inject a stub resolver so the proactive model-switch compaction guard
    // never makes real network calls against the fixture gateway
    // (https://www.example.com). Tests that exercise the guard configure
    // windows via `fixture.getModelContextWindowResolver().set(...)`.
    const modelContextWindowResolver = new StubModelContextWindowResolver();
    const codexAcpAgent = new CodexAcpServer(
        acpConnection,
        codexAcpClient,
        undefined,
        config.getExitCode,
        undefined,
        modelContextWindowResolver,
    );

    const transportEvents: CodexConnectionEvent[] = [];
    const codexEventHandlers: ((event: CodexConnectionEvent) => void)[] = [];
    codexAppServerClient.onClientTransportEvent((event) => {
        transportEvents.push(event);
        codexEventHandlers.forEach(handler => handler(event));
    });

    // Tracks whether dispose() has run, to make it idempotent (afterEach +
    // an explicit call should not double-kill / double-rm).
    let disposed = false;

    const fixture: TestFixture = {
        getCodexAcpAgent(): CodexAcpServer {
            return codexAcpAgent;
        },
        getCodexAcpClient(): CodexAcpClient {
            return codexAcpClient;
        },
        getModelContextWindowResolver(): StubModelContextWindowResolver {
            return modelContextWindowResolver;
        },
        getCodexConnectionEvents(ignoredFields: string[], options?: CodexConnectionDumpOptions): CodexConnectionEvent[] {
            const placeholderResponseMethods = new Set(options?.placeholderResponseMethods ?? []);
            const pendingRequestMethods: string[] = [];

            return transportEvents.flatMap((event) => {
                switch (event.eventType) {
                    case "request":
                        pendingRequestMethods.push(event.method);
                        break;
                    case "response":
                        const requestMethod = pendingRequestMethods.shift();
                        if (requestMethod && placeholderResponseMethods.has(requestMethod)) {
                            return [{
                                eventType: "response" as const,
                                placeholder: requestMethod,
                            } as CodexConnectionEvent];
                        }
                        break;
                }

                return [anonymizeValue(event, [], new Set(ignoredFields)) as CodexConnectionEvent];
            });
        },
        getCodexConnectionDump(ignoredFields: string[], options?: CodexConnectionDumpOptions): string {
            const filteredEvents = this.getCodexConnectionEvents(ignoredFields, options);
            return createArrayDump(filteredEvents, []);
        },
        onCodexConnectionEvent(handler: (event: CodexConnectionEvent) => void): void {
            codexEventHandlers.push(handler);
        },
        getCodexAppServerClient(): CodexAppServerClient {
            return codexAppServerClient;
        },
        clearCodexConnectionDump(): void {
            transportEvents.splice(0, transportEvents.length);
        },
        onAcpConnectionEvent(handler: (event: MethodCallEvent) => void): void {
            acpEventHandlers.push(handler);
        },
        getAcpConnectionEvents(ignoredFields: string[]): MethodCallEvent[] {
            return acpConnectionEvents.map(event => anonymizeValue(event, [], new Set(ignoredFields)) as MethodCallEvent);
        },
        getAcpConnectionDump(ignoredFields: string[]): string {
            return createArrayDump(this.getAcpConnectionEvents(ignoredFields), []);
        },
        clearAcpConnectionDump() {
            acpConnectionEvents.splice(0, acpConnectionEvents.length);
        },
        async dispose(): Promise<void> {
            // Guard against double-dispose (afterEach + an explicit call).
            if (disposed) {
                return;
            }
            disposed = true;
            // Kill the codex child process FIRST and await its exit so it
            // isn't writing into CODEX_HOME (and holding SQLite WAL handles)
            // when we rmSync the dir — that was the ENOTEMPTY/EBUSY race that
            // leaked ~8 dirs per run.
            try {
                await config.dispose?.();
            } catch {
                // Best-effort: a failing dispose hook must not mask test failures.
            }
        }
    };
    // Register so `disposeAllTestFixtures()` (called from afterEach) can drain
    // ALL fixtures — including local ones a test created inside its body that
    // aren't reachable via the shared `fixture` variable.
    createdFixtures.add(fixture);
    return fixture;
}

/**
 * Registry of every fixture created via `createTestFixture`/`createBaseTestFixture`
 * in the current test process. Many tests create MULTIPLE local fixtures (e.g.
 * `authFixture`, `keyFixture`, `envFixture`) in addition to the shared
 * `beforeEach` fixture; without tracking, only the shared one gets disposed in
 * `afterEach` and the rest leak their codex process + CODEX_HOME dir.
 * `disposeAllTestFixtures()` drains this set — call it from `afterEach` (or a
 * global teardown) to guarantee no fixture leaks, regardless of how many a
 * single test created.
 */
const createdFixtures = new Set<TestFixture>();

/**
 * Dispose every fixture created since the last call. Intended for `afterEach`
 * (or a global `afterAll` fallback): even if a test forgets to dispose a local
 * fixture, this drains them all. Idempotent per-fixture (double-dispose is a
 * no-op). Returns a Promise so callers can `await disposeAllTestFixtures()`.
 */
export async function disposeAllTestFixtures(): Promise<void> {
    const pending = Array.from(createdFixtures);
    createdFixtures.clear();
    await Promise.all(pending.map((f) => f.dispose()));
}

/**
 * Creates a test fixture with a real Codex connection.
 * Use for integration tests that need to interact with the actual Codex binary.
 */
export function createTestFixture(): TestFixture {
    const pathToCodex = path.resolve(process.cwd(), "node_modules", ".bin", process.platform === 'win32' ? "codex.cmd" : "codex");
    if (!fs.existsSync(pathToCodex)) {
        throw new Error(`Codex binary not found at ${pathToCodex}. Did you run 'npm install'?`);
    }

    const codexHome = createTestCodexHome();
    const codexConnection = startCodexConnection(pathToCodex, {
        ...process.env,
        CODEX_HOME: codexHome,
    });
    const codexProcess = codexConnection.process;
    // Best-effort cleanup of the process + temp dir. The `exit` listener
    // remains as a fallback, but relying on it alone leaks when vitest tears
    // down the worker before the child exits. `fixture.dispose()` (called in
    // afterEach) kills the child deterministically, THEN removes the dir.
    codexProcess.on("exit", () => {
        removeDirectoryWithRetry(codexHome);
    });

    return createBaseTestFixture({
        connection: codexConnection.connection,
        getExitCode: () => codexConnection.process.exitCode,
        dispose: async () => {
            // Kill first so the child isn't writing into CODEX_HOME during
            // rmSync (which causes ENOTEMPTY races). SIGTERM lets codex flush.
            try {
                if (!codexProcess.killed) {
                    codexProcess.kill("SIGTERM");
                }
            } catch {
                // Process may have already exited; ignore.
            }
            // Await the child's actual exit (with a timeout) so it releases
            // its SQLite WAL handles before we remove the dir. If it doesn't
            // exit gracefully, escalate to SIGKILL.
            await waitForProcessExit(codexProcess, 2000);
            removeDirectoryWithRetry(codexHome);
        },
    });
}

function createTestCodexHome(): string {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-acp-codex-home-"));
    writeCodexHomeConfig(codexHome);
    return codexHome;
}

export function writeCodexHomeConfig(
    codexHome: string,
    extras: Record<string, string> = {},
    mcpServers: McpServerStdio[] = [],
): void {
    const entries: Record<string, string> = {
        cli_auth_credentials_store: "file",
        ...extras,
    };
    let body = Object.entries(entries)
        .map(([key, value]) => `${key} = "${value}"`)
        .join("\n");
    for (const server of mcpServers) {
        body += `\n\n[mcp_servers."${escapeTOML(server.name)}"]`;
        body += `\ncommand = "${escapeTOML(server.command)}"`;
        const argsToml = server.args.map(a => `"${escapeTOML(a)}"`).join(", ");
        body += `\nargs = [${argsToml}]`;
        if (server.env && server.env.length > 0) {
            const envPairs = server.env
                .map(e => `${e.name} = "${escapeTOML(e.value)}"`)
                .join(", ");
            body += `\nenv = {${envPairs}}`;
        }
    }
    fs.writeFileSync(path.join(codexHome, "config.toml"), body, "utf8");
}

function escapeTOML(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function removeDirectoryWithRetry(directory: string): void {
    // Retry with backoff because the codex child may still be releasing file
    // handles (SQLite WAL/SHM) for a few ms after exit. The original loop spun
    // 5 attempts instantly (<1ms) and gave up while EBUSY was still transient
    // → leaked the whole CODEX_HOME dir (~8,160 inodes each).
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            fs.rmSync(directory, { recursive: true, force: true });
            return;
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            // Retry only on transient errors that indicate the dir/files are
            // still in use; bail on anything else (e.g. ENOENT = already gone).
            if (err.code !== "ENOTEMPTY" && err.code !== "EBUSY" && err.code !== "EPERM") {
                return;
            }
            // Backoff: 0,10,20,40,80,160,320,640,1280,2560 ms ≈ 5s total max.
            const delay = attempt === 0 ? 0 : 10 * (2 ** (attempt - 1));
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
        }
    }
}

/**
 * Wait (up to `timeoutMs`) for a spawned child process to exit. If it doesn't
 * exit gracefully within the timeout, escalate to SIGKILL so it can't hold
 * open file handles (e.g. SQLite WAL files in CODEX_HOME) indefinitely.
 * Resolves immediately if the process has already exited.
 */
function waitForProcessExit(proc: import("node:child_process").ChildProcess, timeoutMs: number): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) {
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };
        proc.once("exit", finish);
        // Fallback: if the child ignores SIGTERM, force-kill and resolve.
        const timer = setTimeout(() => {
            try {
                if (proc.exitCode === null && proc.signalCode === null && !proc.killed) {
                    proc.kill("SIGKILL");
                }
            } catch {
                // already gone
            }
            // Give SIGKILL a brief moment to take effect, then resolve
            // regardless so dispose never hangs the test run.
            setTimeout(finish, 200);
        }, timeoutMs);
        // If exit fires, clear the fallback timer.
        proc.once("exit", () => clearTimeout(timer));
    });
}

export interface CodexMockTestFixture extends TestFixture {
    sendServerNotification(notification: ServerNotification | Record<string, unknown>): void,
    sendServerRequest<T>(method: string, params: unknown): Promise<T>,
    setPermissionResponse(response: RequestPermissionResponse): void,
    setElicitationResponse(response: CreateElicitationResponse | Promise<CreateElicitationResponse>): void,
}

/**
 * Creates a test fixture with a mock Codex connection.
 * Use for unit tests that don't need a real Codex binary.
 * Provides `sendServerNotification()` to simulate server notifications.
 * Provides `sendServerRequest()` to simulate server-initiated requests (e.g., approval requests).
 * Provides `setPermissionResponse()` to control ACP permission dialog responses.
 */
export function createCodexMockTestFixture(): CodexMockTestFixture {
    let unhandledNotificationHandler: ((notification: any) => void) | null = null;
    const requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

    // State for controlling permission responses
    const permissionState: { response: RequestPermissionResponse } = {
        response: { outcome: { outcome: 'cancelled' } }
    };
    const elicitationState: { response: CreateElicitationResponse | Promise<CreateElicitationResponse> } = {
        response: { action: 'cancel' }
    };

    const mockCodexConnection = {
        sendRequest: () => Promise.resolve(undefined),
        onUnhandledNotification: (handler: (notification: any) => void) => {
            unhandledNotificationHandler = handler;
        },
        onNotification: () => {},
        onRequest: (type: { method: string }, handler: (params: unknown) => Promise<unknown>) => {
            requestHandlers.set(type.method, handler);
        },
        end: () => {},
    } as unknown as MessageConnection;

    // Create ACP connection with configurable permission response
    const acpConnectionEvents: MethodCallEvent[] = [];
    const acpEventHandlers: ((event: MethodCallEvent) => void)[] = [];
    const returnValues = new Map<string, (args: any[]) => any>();
    returnValues.set('request', (args) => {
        if (args[0] === acp.methods.client.session.requestPermission) {
            return permissionState.response;
        }
        if (args[0] === acp.methods.client.elicitation.create) {
            return elicitationState.response;
        }
        return { mock: "Mocked return" };
    });
    returnValues.set('requestPermission', () => permissionState.response);

    const acpConnection = createSmartMock<AcpClientConnection>((event) => {
        const normalizedEvent = normalizeAcpConnectionEvent(event);
        acpConnectionEvents.push(normalizedEvent);
        acpEventHandlers.forEach(handler => handler(normalizedEvent));
    }, { returnValues });

    const baseFixture = createBaseTestFixture({
        connection: mockCodexConnection,
        getExitCode: () => null,
        acpConnection: {
            connection: acpConnection,
            events: acpConnectionEvents,
            eventHandlers: acpEventHandlers,
        }
    });

    return {
        ...baseFixture,
        sendServerNotification(notification: ServerNotification | Record<string, unknown>): void {
            if (unhandledNotificationHandler) {
                unhandledNotificationHandler(notification);
            }
        },
        async sendServerRequest<T>(method: string, params: unknown): Promise<T> {
            const handler = requestHandlers.get(method);
            if (!handler) {
                throw new Error(`No handler registered for ${method}`);
            }
            return await handler(params) as T;
        },
        setPermissionResponse(response: RequestPermissionResponse): void {
            permissionState.response = response;
        },
        setElicitationResponse(response: CreateElicitationResponse | Promise<CreateElicitationResponse>): void {
            elicitationState.response = response;
        },
    };
}

export function createObjectDump(obj: any, anonymizedFields: string[] = []) {
    return JSON.stringify(anonymizeValue(obj, [], new Set(anonymizedFields)), null, 2);
}

export function createArrayDump(objects: any[], anonymizedFields: string[]): string {
    return objects.map(event => createObjectDump(event, anonymizedFields)).join("\n");
}

function anonymizeValue(value: any, path: string[], fieldsToAnonymize: Set<string>): any {
    if (value === null || typeof value !== "object") {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item, index) => anonymizeValue(item, [...path, String(index)], fieldsToAnonymize));
    }

    return Object.fromEntries(
        Object.entries(value).map(([key, val]) => {
            const nextPath = [...path, key];
            const pathKey = nextPath.join(".");
            if (fieldsToAnonymize.has(key) || fieldsToAnonymize.has(pathKey)) {
                return [key, key];
            }
            return [key, anonymizeValue(val, nextPath, fieldsToAnonymize)];
        })
    );
}

/**
 * Creates a default SessionState for use in tests.
 * Override specific fields as needed.
 */
export function createTestSessionState(overrides?: Partial<SessionState>): SessionState {
    return {
        currentTurnId: null,
        lastTokenUsage: null,
        totalTokenUsage: null,
        previousTurnTokenUsage: null,
        modelContextWindow: null,
        rateLimits: null,
        account: null,
        authConfigured: overrides?.account !== undefined ? overrides.account !== null : false,
        authProvider: null,
        cwd: "/test/cwd",
        additionalDirectories: [],
        sessionId: "session-id",
        currentModelId: "model-id[effort]",
        availableModels: [],
        supportedReasoningEfforts: [],
        supportedInputModalities: ["text", "image"],
        agentMode: AgentMode.DEFAULT_AGENT_MODE,
        collaborationMode: DEFAULT_COLLABORATION_MODE,
        fastModeEnabled: false,
        currentModelSupportsFast: false,
        terminalOutputMode: "terminal_output_delta",
        goalRevision: 0,
        sessionTitle: null,
        sessionTitleSource: "unknown",
        backgroundProcesses: new Map(),
        ...overrides,
    };
}

export function createTestModel(overrides?: Partial<Model>): Model {
    const id = overrides?.id ?? "model-id";
    const defaultEffort: ReasoningEffortOption = {reasoningEffort: "medium", description: "Balanced"};
    return {
        id,
        model: id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: id,
        description: `${id} model`,
        hidden: false,
        supportedReasoningEfforts: [defaultEffort],
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
        ...overrides,
    };
}

export function setupPromptTestSession(sessionOverrides?: Partial<SessionState>) {
    const mockFixture = createCodexMockTestFixture();
    const sessionState = createTestSessionState(sessionOverrides);

    vi.spyOn(mockFixture.getCodexAcpAgent(), "getSessionState").mockReturnValue(sessionState);
    const turnStartSpy = mockPromptTurn(mockFixture, sessionState.sessionId);

    return {mockFixture, sessionState, turnStartSpy};
}

export function mockPromptTurn(fixture: CodexMockTestFixture, sessionId: string) {
    const codexAppServerClient = fixture.getCodexAppServerClient();
    const turnStartSpy = vi.spyOn(codexAppServerClient, "turnStart").mockResolvedValue({
        turn: {
            id: "turn-id",
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
        }
    });
    vi.spyOn(codexAppServerClient, "awaitTurnCompleted").mockResolvedValue({
        threadId: sessionId,
        turn: {
            id: "turn-id",
            items: [],
            itemsView: "notLoaded",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
        }
    });

    return turnStartSpy;
}

export async function setupPromptAndSendNotifications(
    fixture: CodexMockTestFixture,
    sessionId: string,
    sessionState: SessionState,
    notifications: ServerNotification[]
): Promise<void> {
    const codexAcpAgent = fixture.getCodexAcpAgent();
    const codexAppServerClient = fixture.getCodexAppServerClient();
    const turn = { id: "turn-id", items: [], status: "inProgress" as const, error: null };

    codexAppServerClient.turnStart = vi.fn().mockResolvedValue({
        turn,
    });
    codexAppServerClient.awaitTurnCompleted = vi.fn().mockResolvedValue({
        threadId: sessionId,
        turn: { ...turn, status: "completed" },
    });

    vi.spyOn(codexAcpAgent, "getSessionState").mockReturnValue(sessionState);

    await codexAcpAgent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "test prompt" }],
    });

    fixture.clearAcpConnectionDump();

    for (const notification of notifications) {
        fixture.sendServerNotification(notification);
    }
    await fixture.getCodexAcpClient().waitForSessionNotifications(sessionId);

    await vi.waitFor(() => {
        const dump = fixture.getAcpConnectionDump([]);
        expect(dump.length).toBeGreaterThan(0);
    });
}
