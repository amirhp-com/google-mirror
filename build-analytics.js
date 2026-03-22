/**
 * Build script for bundling Vercel Analytics
 * 
 * This script bundles the @vercel/analytics package into a single file
 * that can be included in the static site.
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

// Ensure js directory exists
const jsDir = path.join(__dirname, 'js');
if (!fs.existsSync(jsDir)) {
  fs.mkdirSync(jsDir, { recursive: true });
}

// Bundle the analytics module
esbuild.build({
  entryPoints: ['js/analytics-src.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  outfile: 'js/analytics.bundle.js',
  platform: 'browser',
  target: ['es2015'],
}).then(() => {
  console.log('✅ Analytics bundle created successfully');
}).catch((error) => {
  console.error('❌ Build failed:', error);
  process.exit(1);
});
