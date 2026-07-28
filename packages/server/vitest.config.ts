import { defineConfig } from 'vitest/config'

// Server tests run in a Node environment (SQLite, child_process, git). Test
// files and fixtures live under test/, kept out of the tsc build (src only).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
