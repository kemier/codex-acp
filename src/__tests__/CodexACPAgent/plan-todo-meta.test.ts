import { describe, it, expect } from "vitest";
import * as fs from "fs";

/**
 * update_plan is a checklist, and must not be labelled a plan.
 *
 * Codex's own app-server says so where it builds the notification this handler
 * consumes:
 *
 *   // `update_plan` is a todo/checklist tool; it is not related to plan-mode updates
 *   (codex-rs/app-server/src/bespoke_event_handling.rs)
 *
 * The tool NAME is legacy: the exec layer models the same data as
 * TodoList / TodoItem { completed }, and this repo's own test for it is called
 * "keeps turn plan updates as ACP checklist updates".
 *
 * That matters beyond vocabulary, because codex ALSO has a real plan-mode, which
 * arrives separately as sessionUpdate "plan_update" with markdown content. A client
 * titling the checklist bar "Plan" collides with the one thing that genuinely is a
 * plan — exactly the confusion the upstream comment exists to prevent.
 */

const src = fs.readFileSync(new URL("../../CodexEventHandler.ts", import.meta.url), "utf8");

/** Brace-matched body of a method. */
function bodyOf(signature: string): string {
    const at = src.indexOf(signature);
    expect(at).toBeGreaterThan(0);
    const open = src.indexOf("{", src.indexOf(")", at));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === "{") { depth++; }
        else if (src[i] === "}") {
            depth--;
            if (depth === 0) { return src.slice(at, i + 1); }
        }
    }
    throw new Error(`unbalanced braces after ${signature}`);
}

describe("plan vs checklist labelling", () => {
    it("the checklist carries the neutral todo hint", () => {
        const body = bodyOf("private async updatePlan(");
        expect(body).toContain('sessionUpdate: "plan"');
        expect(body).toContain('_meta: { acp: { plan: { kind: "todo", title: "Todos" } } }');
    });

    it("plan-mode is NOT tagged as a todo list", () => {
        // createPlanUpdateEvent carries plan-mode markdown — a real plan. Tagging it
        // would relabel the one thing on this channel that is not a checklist.
        const body = bodyOf("private createPlanUpdateEvent(");
        expect(body).toContain('sessionUpdate: "plan_update"');
        expect(body).not.toContain('kind: "todo"');
    });

    it("only the checklist path is tagged", () => {
        expect((src.match(/kind: "todo"/g) ?? []).length).toBe(1);
    });
});
