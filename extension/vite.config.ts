import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readdirSync, existsSync } from 'fs';

// Dynamically discover activity entry points under src/activities/
function activityEntries(): Record<string, string> {
  const activitiesDir = resolve(__dirname, 'src/activities');
  if (!existsSync(activitiesDir)) return {};

  return Object.fromEntries(
    readdirSync(activitiesDir)
      .filter((name) => existsSync(resolve(activitiesDir, name, 'index.ts')))
      .map((name) => [
        `activities/${name}/index`,
        resolve(activitiesDir, name, 'index.ts'),
      ])
  );
}

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Content Security Policy in MV3 forbids eval — keep this off
    minify: false,
    rollupOptions: {
      input: {
        'background/index': resolve(__dirname, 'src/background/index.ts'),
        'popup/index':      resolve(__dirname, 'src/popup/index.ts'),
        // Activities are built separately via vite.activities.config.ts
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
      '@': resolve(__dirname, 'src'),
    },
  },
});
