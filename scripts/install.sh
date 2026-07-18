#!/usr/bin/env bash
set -euo pipefail

# Build codex-acp and install to ~/.local/bin via symlink
# Usage: ./scripts/install.sh
#
# This script:
#   1. Builds codex-acp (single bundled dist/index.js with @openai/codex external)
#   2. Symlinks ~/.local/bin/codex-acp -> repo dist/index.js
#
# A symlink (not a copy) is required because the bundle resolves `@openai/codex`
# at runtime via createRequire(import.meta.url), relative to the script's real
# path. The repo's dist/index.js sits next to node_modules/@openai/codex, so the
# symlink resolves correctly. A bare copy would fail with MODULE_NOT_FOUND.
#
# The vscode-acp extension resolves `codex-acp` from PATH, so ~/.local/bin
# must be on PATH (it is by default on this machine).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LOCAL_BIN="${LOCAL_BIN:-$HOME/.local/bin}"

echo "📦 Building codex-acp from $REPO_DIR..."
cd "$REPO_DIR"
npm run build

BUILT="$REPO_DIR/dist/index.js"
if [[ ! -f "$BUILT" ]]; then
  echo "❌ Build output not found: $BUILT"
  exit 1
fi

VERSION=$(node -p "require('$REPO_DIR/package.json').version")
echo "   Built version: $VERSION"
echo "   Output: $BUILT"

# Install to LOCAL_BIN as a SYMLINK (not a copy). The bundle resolves
# `@openai/codex` at runtime via createRequire(import.meta.url), which looks
# relative to the script's real location. A bare copy in ~/.local/bin has no
# node_modules sibling and fails with MODULE_NOT_FOUND, so we point back at the
# repo's dist/index.js (which lives next to node_modules/@openai/codex).
mkdir -p "$LOCAL_BIN"
TARGET="$LOCAL_BIN/codex-acp"

ln -sf "$BUILT" "$TARGET"

# Also sync to npm-global if it exists (it's first on PATH)
NPM_GLOBAL_DIR="$HOME/.npm-global/lib/node_modules/@agentclientprotocol/codex-acp"
if [[ -d "$NPM_GLOBAL_DIR" ]]; then
  ln -sf "$BUILT" "$NPM_GLOBAL_DIR/dist/index.js"
  echo "   Also symlinked to: $NPM_GLOBAL_DIR/dist/index.js"
fi

echo "✅ Installed codex-acp v$VERSION -> $TARGET"
echo ""
echo "   Verify: $(which codex-acp 2>/dev/null || echo 'codex-acp not on PATH')"
echo "   Version: $("$TARGET" --version 2>&1 | head -1)"
echo ""
echo "✅ Done! Reload VS Code to use the new codex-acp."
