// build.js — esbuild bundler for System Awakening
//
// Bundles engine.js and all its ES module imports into a single file at
// dist/engine.js, which Netlify serves as the game entry point.
//
// Usage:
//   npm install       (installs esbuild — one time only)
//   npm run build     (runs this script)
//
// Netlify runs this automatically on every push to main.
// For local development, the unbundled source files work fine with:
//   npm run dev       (serves on localhost:3000)

import { build } from 'esbuild';

try {
  await build({
    entryPoints: ['engine.js'],
    bundle:      true,
    format:      'esm',
    outfile:     'dist/engine.js',
    minify:      false,   // set true for a smaller production build
    sourcemap:   true,    // generates dist/engine.js.map for debugging
    target:      ['es2020'],
    logLevel:    'info',
  });
  console.log('Build complete: dist/engine.js');
} catch (err) {
  console.error('Build failed:', err);
  process.exit(1);
}
