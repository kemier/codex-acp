import { isAbsolute as isAbsolutePath, relative as relativePath, resolve as resolvePath } from "node:path";

/**
 * Strip a login-shell wrapper and a `cd` preamble from a command so the
 * tool-call title shows the work, not the navigation. The full command
 * (including the cd) stays in rawInput.
 *
 * What happens to the `cd` depends on where it points, relative to `cwd`:
 *  - the session cwd itself → STRIPPED. That is where commands run by default,
 *    so `cd /long/path/to/repo && grep …` is pure noise in a one-line title.
 *  - a directory INSIDE the session cwd → KEPT, rewritten relative:
 *    `cd /repo/src/ui && npm test` becomes `cd src/ui && npm test`. The location
 *    carries information here, and the relative form is what a reader needs.
 *  - anywhere else (another repo, /tmp, …) → STRIPPED; the command is the point.
 *
 * Both `cd <dir> && <cmd>` and `cd <dir>; <cmd>` are recognised, plus a bare
 * `cd <dir>` followed by the command on the next line.
 *
 * Kept in sync with vscode-acp's src/utils/toolTitle.ts and pi-acp /
 * claude-code-acp, so a row looks the same whichever agent produced it and the
 * client's normalization is a no-op on an already-normalized title.
 */
export function stripShellPrefix(command: string, cwd?: string): string {
    let withoutShell = command.replace(/^(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/, "");
    if (withoutShell.startsWith("'") && withoutShell.endsWith("'")) {
        withoutShell = withoutShell.slice(1, -1);
    }
    const nl = withoutShell.indexOf("\n");
    const firstLine = (nl === -1 ? withoutShell : withoutShell.slice(0, nl)).trim();
    const rest = nl === -1 ? "" : withoutShell.slice(nl + 1);
    // `cd <dir> && <cmd>` / `cd <dir>; <cmd>` — cd and the command share the
    // first line. Codex emits the `&&` form; other agents use `;`.
    const cdAnd = firstLine.match(/^cd\s+(\S[^;&]*?)\s*(&&|;)\s*(.+)$/);
    if (cdAnd && cdAnd[3]) {
        const target = (cdAnd[1] ?? "").trim();
        const separator = cdAnd[2] === ";" ? ";" : " &&";
        const inline = cdAnd[3].trim();
        const sub = subdirOfCwd(target, cwd);
        if (sub) {
            const joined = `cd ${sub}${separator} ${inline}`;
            return rest ? `${joined}\n${rest}` : joined;
        }
        return rest ? `${inline}\n${rest}` : inline;
    }
    // Bare `cd <dir>` on its own line — the command starts on the next line.
    const cdOnly = firstLine.match(/^cd\s+(\S.*)$/);
    if (cdOnly && rest.trim()) {
        // Always stripped, even for a subdirectory: clients render only the FIRST
        // line of a title, so keeping "cd src" would hide the command. The
        // single-line && / ; form keeps the relative cd — there both fit.
        return rest.replace(/^\n+/, "");
    }
    return withoutShell;
}

/**
 * Relative path when `target` is a directory INSIDE `cwd`, else null.
 *
 * `cwd` itself returns null: running in the session directory is the default and
 * needs no announcement. A relative target is resolved against `cwd`, never
 * against process.cwd(), so re-applying this to an already-normalized title is a
 * no-op wherever the process was started.
 */
function subdirOfCwd(target: string, cwd?: string): string | null {
    if (!cwd) {
        return null;
    }
    try {
        const base = resolvePath(cwd);
        const abs = isAbsolutePath(target) ? resolvePath(target) : resolvePath(base, target);
        const rel = relativePath(base, abs);
        if (!rel || rel === "." || rel.startsWith("..") || isAbsolutePath(rel)) {
            return null;
        }
        return rel;
    } catch {
        return null;
    }
}
