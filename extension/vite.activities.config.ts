/**
 * Vite config for activity content scripts only.
 *
 * Activities are injected by Chrome via executeScript({files:[...]}) which
 * runs them as classic scripts — ES module imports silently fail in that
 * context. Building with format:'iife' forces Rollup to inline all
 * dependencies (including Presence.ts) into every activity file so each
 * one is fully self-contained.
 */
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readdirSync, existsSync } from 'fs';

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
    emptyOutDir: false, // don't wipe the ESM build (background, popup)
    minify: false,
    rollupOptions: {
      input: activityEntries(),
      output: {
        // IIFE = no code splitting, all deps inlined per file
        format: 'iife',
        entryFileNames: '[name].js',
        // Activities don't export anything — dummy name satisfies Rollup
        name: 'FreeMiDActivity',
      },
    },
  },
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
});
