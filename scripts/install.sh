#!/usr/bin/env bash
set -euo pipefail

# Build codex-acp and install to ~/.local/bin
# Usage: ./scripts/install.sh
#
# This script:
#   1. Builds codex-acp (single bundled dist/index.js)
#   2. Installs it as ~/.local/bin/codex-acp
#
# The vscode-acp extension resolves `codex-acp` from PATH, so ~/.local/bin
# must be on PATH (it is by default on this server).

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

# Install to LOCAL_BIN
mkdir -p "$LOCAL_BIN"
TARGET="$LOCAL_BIN/codex-acp"

cp "$BUILT" "$TARGET"
chmod +x "$TARGET"

 # Also sync to npm-global if it exists (it's first on PATH)
 NPM_GLOBAL_DIR="$HOME/.npm-global/lib/node_modules/@agentclientprotocol/codex-acp"
 if [[ -d "$NPM_GLOBAL_DIR" ]]; then
   cp "$BUILT" "$NPM_GLOBAL_DIR/dist/index.js"
   echo "   Also synced to: $NPM_GLOBAL_DIR/dist/index.js"
 fi

echo "✅ Installed codex-acp v$VERSION to $TARGET"
echo ""
echo "   Verify: $(which codex-acp 2>/dev/null || echo 'codex-acp not on PATH')"
echo "   Version: $("$TARGET" --version 2>&1 | head -1)"
echo ""
echo "✅ Done! Reload VS Code to use the new codex-acp."
