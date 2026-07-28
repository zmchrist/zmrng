import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Web tests render React components, so they run in jsdom with the same React
// plugin the app build uses. CSS Modules resolve through Vite as usual.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: true,
  },
})
