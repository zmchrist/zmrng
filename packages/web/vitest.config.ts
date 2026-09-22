import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Web tests render React components, so they run in jsdom with the same React
// plugin the app build uses. CSS Modules resolve through Vite as usual.
const { env } = process

/** Fork cap: 3 locally, or ZMRNG_VITEST_MAX_FORKS (the orchestrator sets 2 for workers). */
const MAX_FORKS = Number(env.ZMRNG_VITEST_MAX_FORKS ?? 3)

export default defineConfig({
  plugins: [react()],
  test: {
    // Force test mode regardless of the parent shell's NODE_ENV. On the VPS/cora
    // box the orchestrator runs with NODE_ENV=production, which the stop-validate
    // hook inherits; without this the React plugin loads React's production build
    // (no React.act) and every Testing Library render fails. Tests must always run
    // in test mode.
    env: { NODE_ENV: 'test' },
    // Bound the fork count. Vitest defaults to `cores - 1`, so every run claimed
    // the whole box regardless of what else was running; with several worker
    // validation gates in flight that oversubscribed a 6-core machine ~2x and
    // turned into load-induced flakes (a suite failing only because the box was
    // busy). Default 3 keeps a solo interactive run fast; the
    // orchestrator sets ZMRNG_VITEST_MAX_FORKS=2 for worker children.
    poolOptions: {
      forks: { maxForks: MAX_FORKS },
    },
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: true,
  },
})
