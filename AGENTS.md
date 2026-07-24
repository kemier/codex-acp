# Repository Guidelines

## Project Structure

- `src/` — ACP server implementation. Entry point: `src/index.ts`.
- `src/__tests__/` — Vitest suite (behavior-focused tests around ACP/Codex events).
- `src/app-server/` — generated Codex app-server API types (regenerate via `npm run generate-types`).
- `dist/bin/` — release-ready single-file executables and `*.zip` archives.
- `.github/workflows/ci.yml` — CI mirrors the local workflow: typecheck → tests → bundle.

## Coding Style & Naming Conventions

- Keep edits consistent with existing formatting.
- When adding env/config knobs, document them in `readme-dev.md`.
- When updating discriminated-union/event `switch` statements, do not add a trailing fallback like `return null` only to satisfy TypeScript.
- Handle each variant with an explicit `case`; if intentionally ignored, use an explicit no-op case.

## Related Repositories

| Repo | Path | Description |
|---|---|---|
| **vscode-acp** | `/workspace/git/ezennin/vscode-acp` | VS Code extension implementing ACP. Consumes this agent binary. Key file: `src/ui/ChatWebviewProvider.ts` (webview rendering, link parsing, session UI). |
| **codex** | `/workspace/git/ezennin/codex` | Codex CLI core (Rust). The actual agent engine spawned as `codex app-server`. Key crate: `codex-rs/app-server/`. |
| **ericai-proxy** | `/workspace/git/ezennin/ericai-proxy` | Rust proxy translating OpenAI Responses API ↔ Chat Completions API. Must flatten `ToolSpec::Namespace` tools into individual function tools. |
| **claude-code-acp** | `/workspace/git/ezennin/claude-code-acp` | ACP bridge for Claude Code CLI. Spawns `claude` with `--output-format stream-json`. Key files: `src/agent.ts` (ACP handlers + steer), `src/claude-runner.ts` (subprocess management). |
| **ericli** | `/workspace/git/ezennin/ericli` | EricAI CLI alternative to Codex. Talks to EricAI's vLLM backend. Provides `ericli acp` for ACP stdio. |

## Testing Guidelines

- Tests live under `src/__tests__/` and use Vitest.
- Favor event-driven assertions (see `src/__tests__/CodexACPAgent/*`).
- Prefer snapshot-based tests using `toMatchFileSnapshot()` over inline assertions.
- When snapshot response data drifts, prefer replacing that response payload with a stable placeholder over asserting fragile fields (except for 'model/list').
- Focus on behavior and outputs rather than implementation details.
- Use `/run-codex` skill (`.claude/skills/run-codex/`) to test with real Codex and observe actual events.

## Docs

- Codex app-server usage: see https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md when touching protocol/transport details, adding or consuming JSON-RPC methods, handling approvals/turn events, or updating generated schema/clients.
- App-server events: prefer `thread/*`, `turn/*`, and `item/*` event surfaces; avoid the deprecated `codex/event/*` API (planned removal). Keep implementations aligned with generated types in `src/app-server` (including `v2` exports).

## Architecture Overview

`codex-acp` is a bridge between ACP clients (VS Code extensions, Zed, JetBrains) and the Codex app-server. The runtime chain is:

```
ACP Client (vscode-acp)  ──stdio/JSON-RPC──>  codex-acp  ──stdio/JSON-RPC──>  codex app-server (Rust)
```

- `src/index.ts` — Entry point. Spawns `codex app-server` as a child process (via `CodexJsonRpcConnection`), then starts the ACP server.
- `src/CodexAcpServer.ts` — ACP server. Manages sessions, handles ACP requests (`session/new`, `session/load`, `prompt`, etc.). Each session has a `SessionState`.
- `src/CodexAcpClient.ts` — Thin client that calls the Codex app-server (create session, subscribe to events, run compact, etc.).
- `src/CodexEventHandler.ts` — Translates Codex app-server notifications (`item/started`, `item/completed`, `thread/*`, etc.) into ACP `session/update` events. One instance per prompt turn.
- `src/CodexCommands.ts` — Handles built-in slash commands (`/status`, `/compact`, `/review`, `/ps`, etc.) locally without sending them to the LLM.
- `src/CodexToolCallMapper.ts` — Maps Codex tool call items (shell, file change, MCP, etc.) to ACP tool call updates.
- `src/app-server/` — Generated TypeScript types for the Codex app-server JSON-RPC protocol.

## Adding a Slash Command

Slash commands like `/ps`, `/status`, `/compact` are handled locally in `CodexCommands.ts` — they never reach the LLM. To add a new one:

### 1. Register the command

Add it to `getBuiltinCommands()` in `src/CodexCommands.ts` so it appears in the ACP `available_commands_update` notification (clients show it in their slash popup):

```typescript
{
    name: "mycommand",
    description: "Does something useful.",
    input: null  // or { hint: "optional arg hint" }
}
```

### 2. Handle the command

Add a `case` in the `switch (commandName)` block inside `tryHandleCommand()`:

```typescript
case "mycommand": {
    const session = new ACPSessionConnection(this.connection, sessionId);
    await session.update(createAgentTextMessageChunk("Result text here."));
    return { handled: true };

```

If the command needs data from the session, store it on `SessionState` (in `CodexAcpServer.ts`) and populate it from `CodexEventHandler.ts` notifications.

### 3. Track state (if needed)

If the command queries runtime state (like `/ps` tracking background terminals):

- Add a field to `SessionState` in `src/CodexAcpServer.ts`
- Initialize it when creating `SessionState` (search for `sessionTitleSource:` to find all creation sites)
- Update it in `CodexEventHandler.ts` when relevant notifications arrive

Example — `/ps` tracks background processes:

```typescript
// SessionState field
backgroundProcesses: Map<string, { command: string; processId: string | null }>;

// CodexEventHandler — on item/started with unifiedExec source
this.sessionState.backgroundProcesses.set(key, { command, processId });

// CodexEventHandler — on item/completed
this.sessionState.backgroundProcesses.delete(key);
```

## Build and Install

### Build

```bash
npm run build        # esbuild -> dist/index.js (single bundled ESM file)
```

The build produces a single self-contained `dist/index.js` with no runtime dependencies (everything is bundled except `@openai/codex` which is resolved at runtime via `CODEX_PATH` or the bundled npm package).

## Mid-Turn Steering

codex-acp supports mid-turn steering via the custom `_ericli/session/steer`
ACP notification. When the vscode-acp client sends this notification during
an active turn, codex-acp translates it to a native Codex `turn/steer` RPC
request, which injects the user's message into the active LLM turn at the
next iteration boundary — without cancelling the turn.

**Flow:**
1. vscode-acp sends `_ericli/session/steer` notification `{ sessionId, text }`
2. `CodexAcpServer.steer()` looks up `sessionState.currentTurnId`
3. `CodexAcpClient.turnSteer()` calls `CodexAppServerClient.turnSteer()` → `turn/steer` RPC
4. Codex core injects the message via `steer_input()` — LLM sees it as live guidance

Key files:
- `src/AcpExtensions.ts` — `STEER_NOTIFICATION` constant
- `src/CodexAcpServer.ts` — `steer()` method
- `src/CodexAcpClient.ts` — `turnSteer()` wrapper
- `src/CodexAppServerClient.ts` — `turnSteer()` RPC call
- `src/index.ts` — `.onNotification(STEER_NOTIFICATION, ...)` registration

### Install to local bin

From the `codex-acp` repo:

```bash
cd ~/projects/codex-acp
./scripts/install.sh
```

This script:
1. Builds codex-acp (`node build.mjs` -> `dist/index.js`, with `@openai/codex` external)
2. Symlinks `~/.local/bin/codex-acp` -> the repo's `dist/index.js`

A **symlink** (not a copy) is required: the bundle resolves `@openai/codex` at
runtime via `createRequire(import.meta.url)`, relative to the script's real
location. The repo's `dist/index.js` lives next to `node_modules/@openai/codex`,
so the symlink resolves correctly. A bare copy has no `node_modules` sibling and
fails with `MODULE_NOT_FOUND`.

### Manual install

```bash
cd ~/projects/codex-acp
npm run build
ln -sf "$(pwd)/dist/index.js" ~/.local/bin/codex-acp
```

### Verify

```bash
codex-acp --version   # should print @agentclientprotocol/codex-acp <version>
```

### PATH resolution

This machine resolves `codex-acp` from `PATH` in this order:

1. `/opt/homebrew/bin/codex-acp` -> brew package (has nested `node_modules/@openai/codex`)
2. `~/.local/bin/codex-acp` -> symlink to the repo's `dist/index.js` (set up by `installscript.sh`)

Both resolve `@openai/codex` correctly. The install script points `~/.local/bin` at the repo build so it always tracks the latest source.

## Full deploy workflow (codex-acp + vscode-acp)

```bash
# 1. Build and install codex-acp
cd /workspace/git/ezennin/codex-acp
./scripts/install.sh

# 2. Build and install vscode-acp extension
npm run package && npx vsce package && ./scripts/install-vscode-server.sh

# 3. Reload VS Code: Ctrl+Shift+P -> Reload Window
```

## Key Dependencies

- `@agentclientprotocol/sdk` — ACP protocol SDK (server, types, JSON-RPC)
- `@openai/codex` — Codex CLI binary (spawned as `codex app-server`)
- `vscode-jsonrpc` — JSON-RPC connection to the Codex app-server
- `esbuild` — Bundler (via `build.mjs`)

## Environment Variables

See `readme-dev.md` for the full list. Key ones:

- `CODEX_PATH` — Path to the Codex binary (default: bundled `@openai/codex/bin/codex.js`)
- `CODEX_CONFIG` — JSON config merged into session config
- `MODEL_PROVIDER` — Model provider for new sessions
- `APP_SERVER_LOGS` — Directory for adapter logs
