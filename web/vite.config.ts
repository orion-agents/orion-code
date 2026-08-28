import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web-client', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    assetsDir: 'assets',
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
});
