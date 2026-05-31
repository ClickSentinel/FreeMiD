#!/usr/bin/env node
/**
 * Build all activities as standalone IIFE bundles.
 *
 * Chrome's executeScript({files:[...]}) runs scripts in classic-script mode,
 * so activities cannot have top-level `import` statements. We build each
 * activity separately with format:'iife' so Rollup inlines all dependencies
 * (including Presence.ts) into a single self-contained file.
 */
import { build, loadEnv } from 'vite';
import { resolve, dirname } from 'path';
import { readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, '..');
const srcDir    = resolve(root, 'src/activities');

// Load .env so VITE_* vars are substituted in activity bundles
const env = loadEnv('production', root, '');

const activities = readdirSync(srcDir).filter((name) =>
  existsSync(resolve(srcDir, name, 'index.ts'))
);

for (const name of activities) {
  const entryFile = resolve(srcDir, name, 'index.ts');
  const outName   = `activities/${name}/index`;

  console.log(`[activities] building ${name}…`);

  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    build: {
      outDir:      resolve(root, 'dist'),
      emptyOutDir: false,
      minify:      false,
      rollupOptions: {
        input: { [outName]: entryFile },
        output: {
          format:         'iife',
          entryFileNames: '[name].js',
          // activities don't export — dummy name satisfies Rollup
          name:           'FreeMiDActivity',
        },
      },
    },
    define: Object.fromEntries(
      Object.entries(env)
        .filter(([k]) => k.startsWith('VITE_'))
        .map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)])
    ),
    resolve: {
      alias: { '@': resolve(root, 'src') },
    },
  });

  console.log(`[activities] ✓ dist/${outName}.js`);
}
