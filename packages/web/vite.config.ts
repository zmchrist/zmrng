import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // The voice ML stack (transformers.js + kokoro-js) bundles onnxruntime-web,
  // which loads its WASM runtime via a dynamic import. Vite's dep pre-bundler
  // rewrites those imports into `.vite/deps`, which 404s ORT's wasm glue and
  // breaks model init — so exclude the whole stack from optimization. The
  // workers additionally pin ORT's `wasmPaths` to a served CDN URL (see
  // src/voice/*Worker.ts).
  optimizeDeps: {
    exclude: ['@huggingface/transformers', 'onnxruntime-web', 'kokoro-js'],
  },
  // Emit the STT/TTS Web Workers as ES modules so their dynamic ORT imports and
  // `import.meta` (used by kokoro-js) work in both dev and the production build.
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
