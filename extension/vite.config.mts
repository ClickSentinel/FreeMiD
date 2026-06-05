import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'test/**/*.{test,spec}.{ts,tsx}'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Content Security Policy in MV3 forbids eval — keep this off
    minify: false,
    rollupOptions: {
      input: {
        'background/index': resolve(here, 'src/background/index.ts'),
        'popup/index': resolve(here, 'src/popup/index.ts'),
        // Activities are built separately via scripts/build-activities.mjs
        // so they get IIFE format (self-contained, no shared chunks).
      },
      output: {
        // Flat chunk names so Chrome can import them from the extension root
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name].[ext]',
        // Do NOT code-split activities — each must be a single self-contained file
        manualChunks: undefined,
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(here, 'src'),
    },
  },
});