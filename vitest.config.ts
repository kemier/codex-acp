import {defineConfig} from "vitest/config";

// Scope test discovery to src/ so vitest does not traverse gitignored,
// symlinked skill directories (e.g. .codex/skills/**) that happen to live in
// the working tree but are unrelated to this repo's own test suite.
export default defineConfig({
    test: {
        include: ["src/**/*.test.{ts,tsx,mjs,js}"],
    },
});
