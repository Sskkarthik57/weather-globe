import { defineConfig } from 'vite';

// base './' makes the built site work from any sub-path (e.g. GitHub Pages /repo-name/)
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 900,
  },
  server: { port: 5173 },
});
