// Cross-platform test discovery. Node's bare `--test` also executes ordinary .js fixtures under test/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Return the repository's actual Node test files in stable order. */
export function listTestFiles(root = ROOT) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(file);
    }
  };
  visit(path.join(root, 'test'));
  return files;
}

export function runTests(root = ROOT) {
  const files = listTestFiles(root);
  if (!files.length) {
    console.error('no test/*.test.js files found');
    return 1;
  }
  const args = files.map((file) => path.relative(root, file));
  const result = spawnSync(process.execPath, ['--test', ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

const invoked = (() => { try { return pathToFileURL(fs.realpathSync(process.argv[1] || '')).href; } catch { return null; } })();
if (invoked === import.meta.url) process.exitCode = runTests();