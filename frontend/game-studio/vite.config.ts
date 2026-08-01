import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: projectRoot,
  base: '/game-studio/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
  },
  server: {
    port: 5178,
    fs: { allow: [path.resolve(projectRoot, '../..')] },
    proxy: { '/api': 'http://localhost:3000' },
  },
});
