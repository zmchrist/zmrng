import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Load env from the repo root so the single root `.env` (VITE_WORKSPACE_URL,
  // etc.) is picked up, matching the committed root `.env.example`.
  envDir: '../..',
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': 'http://localhost:4500',
      '/ws': {
        target: 'ws://localhost:4500',
        ws: true,
      },
    },
  },
})
