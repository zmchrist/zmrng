import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Web tests render React components, so they run in jsdom with the same React
// plugin the app build uses. CSS Modules resolve through Vite as usual.
export default defineConfig({
  plugins: [react()],
  test: {
    // Force test mode regardless of the parent shell's NODE_ENV. On the VPS/cora
    // box the orchestrator runs with NODE_ENV=production, which the stop-validate
    // hook inherits; without this the React plugin loads React's production build
    // (no React.act) and every Testing Library render fails. Tests must always run
    // in test mode.
    env: { NODE_ENV: 'test' },
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: true,
  },
})
