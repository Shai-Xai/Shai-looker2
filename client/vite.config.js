import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3045',
    },
  },
  // Keep function/class names through minification so production stack traces
  // (and the error screen) read "at FilterDropdown" instead of "at r" — makes
  // prod crashes diagnosable. Source maps emitted for the same reason.
  esbuild: { keepNames: true },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
