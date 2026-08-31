import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // The shell never talks to a connector directly — every request goes
    // through the backend so no credential reaches the browser.
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
