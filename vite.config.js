import { defineConfig } from 'vite';
import { syntaxCatalog } from './syntax.mjs';
export default defineConfig({
  plugins: [syntaxCatalog()],
  base: './',
  build: { target: 'esnext', chunkSizeWarningLimit: 2500, outDir: 'dist', sourcemap: false },
  worker: { format: 'es' },
});
