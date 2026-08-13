export function stripShellPrefix(command: string): string {
    let withoutShell = command.replace(/^(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/, "");
    if (withoutShell.startsWith("'") && withoutShell.endsWith("'")) {
        withoutShell = withoutShell.slice(1, -1);
    }
    // Strip leading `cd <dir> && <cmd>` or bare `cd <dir>\n<cmd>` prefix so the
    // tool-call title shows the real command, not the cd wrapper. Codex often
    // prefixes commands with `cd <cwd> && <cmd>` on one line, or `cd <dir>` on
    // its own line followed by the command. Without this, the title renders as
    // `cd /workspace/... && grep -n ...` with the meaningful part pushed off.
    // The full command (including cd) is preserved in rawInput.
    const nl = withoutShell.indexOf("\n");
    const firstLine = (nl === -1 ? withoutShell : withoutShell.slice(0, nl)).trim();
    const rest = nl === -1 ? "" : withoutShell.slice(nl + 1);
    // `cd <dir> && <inline rest>` — cd and the command share the first line.
    const cdAnd = firstLine.match(/^cd\s+(\S[^&]*?)\s*&&\s*(.+)$/);
    if (cdAnd && cdAnd[2]) {
        const inline = cdAnd[2].trim();
        return rest ? `${inline}\n${rest}` : inline;
    }
    // Bare `cd <dir>` on its own line — the command starts on the next line.
    const cdOnly = firstLine.match(/^cd\s+(\S.*)$/);
    if (cdOnly && rest.trim()) {
        return rest.replace(/^\n+/, "");
    }
    return withoutShell;
}
