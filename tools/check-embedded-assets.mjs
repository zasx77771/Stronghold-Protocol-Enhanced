#!/usr/bin/env node
// Release guard: a packaged client carries the official art it references, so a
// release build must prove those files are on disk before it ships.
//
// `public/assets` and `public/fonts` are git-ignored and produced by `npm run
// assets`; `data/assets.json` is committed and lists every URL the client loads.
// A packaging run that skipped the download, or a partial one, would otherwise
// produce an installer whose art 404s at runtime with no build error. This turns
// that into a build failure.
//
// Usage: node tools/check-embedded-assets.mjs [--strict] [--json]
//   --strict  also hold the manifest to its own count (`stats.files`), so a
//             stale manifest cannot hide files the client no longer references.
//   --json    print the machine-readable result instead of the summary.
// Exit 0 when every manifest file is on disk, 1 otherwise.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const MANIFEST_PATH = 'data/assets.json';

// The client root is `public/`, so `/assets/x.png` lives at `public/assets/x.png`.
const ASSET_URL = /^\/(?:assets|fonts)\/[^?#]+/;
const ASSET_DIR = ['public', 'assets'];

/** Every `/assets/…` or `/fonts/…` URL a value tree mentions, de-duplicated in order. */
export function manifestUrls(manifest) {
  const urls = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (ASSET_URL.test(value)) urls.add(value);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) walk(child);
  };
  walk(manifest);
  return [...urls];
}

/** URL → path under `root`, keeping the URL's forward slashes on every OS. */
export function urlPath(root, url) {
  const parts = url.split('/').filter(Boolean);
  return join(root, 'public', ...parts);
}

/** The manifest URLs whose file is absent (or not a regular file) under `root`. */
export function missingFiles(urls, root) {
  return urls.filter((url) => {
    try {
      return !statSync(urlPath(root, url)).isFile();
    } catch {
      return true;
    }
  });
}

/** Recursive file count and byte total under `dir`; zeros when it is absent. */
export function dirSummary(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        files += 1;
        bytes += statSync(path).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/**
 * Check the embedded client assets.
 * @param {{ root?: string, strict?: boolean }} [options]
 * @returns {{ ok: boolean, urls: number, assets: { files: number, bytes: number },
 *   missing: string[], problems: string[] }}
 */
export function check({ root = ROOT, strict = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf8'));
  const urls = manifestUrls(manifest);
  const missing = missingFiles(urls, root);
  const assets = dirSummary(join(root, ...ASSET_DIR));
  const problems = [];
  if (!urls.length) problems.push(`${MANIFEST_PATH} lists no /assets/ or /fonts/ URL`);
  if (!assets.files) problems.push(`public/${ASSET_DIR[1]} is empty or absent; run \`npm run assets\``);
  if (missing.length) {
    problems.push(`${missing.length} manifest file(s) missing, e.g. ${missing.slice(0, 3).join(', ')}`);
  }
  const listed = urls.filter((url) => url.startsWith('/assets/')).length;
  if (strict && Number.isFinite(manifest.stats?.files) && manifest.stats.files !== listed) {
    problems.push(`manifest stats.files (${manifest.stats.files}) disagrees with its ${listed} /assets/ URLs`);
  }
  return { ok: problems.length === 0, urls: urls.length, assets, missing, problems };
}

/** CLI; returns the process exit code. */
export function main(argv) {
  const result = check({ strict: argv.includes('--strict') });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const mib = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
    console.log(`embedded assets: ${result.assets.files} files, ${mib(result.assets.bytes)} MiB under public/assets`);
    console.log(`manifest: ${result.urls} URLs, ${result.missing.length} missing`);
    for (const problem of result.problems) console.error(`error: ${problem}`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
