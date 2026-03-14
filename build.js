// ---------------------------------------------------------------------------
// build.js — esbuild bundler for System Awakening
//
// Bundles engine.js and all its ES module imports into a single file at
// dist/engine.js. For production use on GitHub Pages (fewer HTTP requests).
//
// Usage:
//   npm install        (installs esbuild)
//   npm run build      (runs this script)
//
// The output goes to dist/engine.js. To use it:
//   1. Copy dist/engine.js to the repo root (or adjust index.html's script src)
//   2. index.html keeps type="module" — esbuild's output is a valid ES module
//
// For development, the unbundled modules work fine with any static file server
// (including GitHub Pages). Bundling is an optimisation, not a requirement.
// ---------------------------------------------------------------------------

import { build } from 'esbuild';

try {
  const result = await build({
    entryPoints: ['engine.js'],
    bundle: true,
    format: 'esm',
    outfile: 'dist/engine.js',
    minify: false,           // keep readable for debugging; set true for production
    sourcemap: true,         // dist/engine.js.map
    target: ['es2020'],
    logLevel: 'info',
  });
  console.log('Build complete: dist/engine.js');
} catch (err) {
  console.error('Build failed:', err);
  process.exit(1);
}
