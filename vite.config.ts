import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const repoRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // One bundle is fine for an app served from localhost; Tiptap + ProseMirror make it ~650 kB.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    host: '127.0.0.1',
    port: 5555,
    strictPort: true,
    // Keep the original Host header so the API's Host allowlist accepts proxied requests.
    proxy: { '/api': { target: 'http://127.0.0.1:5556', changeOrigin: false } },
  },
  test: {
    root: repoRoot,
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'web/src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
  },
})
