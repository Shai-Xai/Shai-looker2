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
    rollupOptions: {
      output: {
        // Split the single app chunk into app + echarts + the rest of the
        // vendor tree. Smaller chunks lower peak build memory (the prod
        // sourcemap is large) and cut the initial load. echarts is a clean leaf
        // (nothing else imports it), so it splits without a circular chunk; the
        // interdependent React ecosystem stays together in one `vendor` chunk to
        // avoid cross-chunk init cycles.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('echarts')) return 'echarts';
          // These are dynamically imported (SegmentManager xlsx export, EventOps
          // OCR/QR scanner) and only on admin/EventOps flows. Returning undefined
          // keeps them OUT of the eagerly-loaded `vendor` chunk so they follow
          // their dynamic importers into lazy chunks — otherwise every client
          // phone downloads ~430KB of spreadsheet/OCR/camera code at first paint.
          if (/[\\/]node_modules[\\/](xlsx|tesseract\.js|html5-qrcode|qrcode)[\\/]/.test(id)) return undefined;
          return 'vendor';
        },
      },
    },
  },
});
