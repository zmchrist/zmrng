import { defineConfig } from 'vitest/config'

// Server tests run in a Node environment (SQLite, child_process, git). Test
// files and fixtures live under test/, kept out of the tsc build (src only).
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
  },
})
