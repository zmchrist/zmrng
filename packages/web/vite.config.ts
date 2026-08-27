import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Emit the STT/TTS Web Workers as ES modules so their runtime `import.meta`
  // and dynamic `import()` (the voice ML stack is loaded from a CDN at runtime —
  // see src/voice/*Worker.ts) work in both dev and the production build. The ML
  // libs are intentionally NOT bundled by Vite/Rolldown: bundling transformers.js
  // makes its internal CJS `require('onnxruntime-web/wasm')` execute in the ES
  // worker, which has no `require`. Loading from jsDelivr `/+esm` avoids that.
  worker: {
    format: 'es',
  },
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
