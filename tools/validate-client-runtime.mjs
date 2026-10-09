#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CLIENT_RUNTIME_FILES = Object.freeze([
  'index.html',
  'js/main.js',
  'data.js',
  'vendor/preact.module.js',
  'vendor/hooks.module.js',
  'vendor/htm.module.js',
  'vendor/pixi.min.js',
  'vendor/pixi-spine.js',
  'fonts/fonts.css',
]);

export function missingClientRuntimeFiles(root) {
  return REQUIRED_CLIENT_RUNTIME_FILES.filter((relative) => {
    const target = path.join(root, ...relative.split('/'));
    try {
      const stat = fs.statSync(target);
      return !stat.isFile() || stat.size === 0;
    } catch {
      return true;
    }
  });
}

export function validateClientRuntime(root) {
  const missing = missingClientRuntimeFiles(root);
  if (missing.length) {
    throw new Error(`Incomplete client runtime in ${path.resolve(root)}:\n${missing.map((file) => `  - ${file}`).join('\n')}`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: node tools/validate-client-runtime.mjs <client-root>');
    process.exitCode = 2;
  } else {
    try {
      validateClientRuntime(root);
      console.log(`Client runtime verified: ${path.resolve(root)}`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
