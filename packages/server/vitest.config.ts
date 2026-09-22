import { defineConfig } from 'vitest/config'

// Server tests run in a Node environment (SQLite, child_process, git). Test
// files and fixtures live under test/, kept out of the tsc build (src only).
const { env } = process

/** Fork cap: 3 locally, or ZMRNG_VITEST_MAX_FORKS (the orchestrator sets 2 for workers). */
const MAX_FORKS = Number(env.ZMRNG_VITEST_MAX_FORKS ?? 3)

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Several server tests spawn real git worktree ops (taskManager) and
    // synchronous `python3` interpreters (seedHarness). Under the combined
    // validation gate's peak CPU load these can exceed the 5s default and
    // spuriously time out — a load-induced flake. A generous ceiling is a no-op
    // when the machine is idle and only prevents the false failure under load.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Bound the fork count. Vitest defaults to `cores - 1`, so every run claimed
    // the whole box regardless of what else was running; with several worker
    // validation gates in flight that oversubscribed a 6-core machine ~2x and
    // turned into load-induced flakes (the same lesson as testTimeout above, one
    // step further). Default 3 keeps a solo interactive run fast; the
    // orchestrator sets ZMRNG_VITEST_MAX_FORKS=2 for worker children.
    poolOptions: {
      forks: { maxForks: MAX_FORKS },
    },
  },
})
