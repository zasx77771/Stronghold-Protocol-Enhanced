// Builds and verifies offline client update payloads.
// Windows updates carry changed files; Android updates carry a byte-exact delta of the signed APK.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync, closeSync, copyFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const PATCH_MAGIC = Buffer.from('SPDELTA1', 'ascii');
const PATCH_VERSION = 1;
const PATCH_HEADER_BYTES = 96;
const BLOCK_SIZE = 32 * 1024;
const MOD_ADLER = 65521;

function fail(message) { throw new Error(message); }

function safeRelative(value) {
  const text = String(value || '').replaceAll('\\', '/');
  if (!text || text.startsWith('/') || text.includes('../') || text === '..') fail(`Unsafe relative path: ${value}`);
  return text;
}

function child(root, rel) {
  const base = resolve(root);
  const out = resolve(base, ...safeRelative(rel).split('/'));
  if (out !== base && !out.startsWith(`${base}${sep}`)) fail(`Path escapes root: ${rel}`);
  return out;
}

function writeAll(fd, buffer, position = null) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = position == null
      ? writeSync(fd, buffer, offset, buffer.length - offset)
      : writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (!(written > 0)) fail('Unable to write update payload');
    offset += written;
  }
}

function readExact(fd, length, position) {
  const out = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const got = readSync(fd, out, offset, length - offset, position + offset);
    if (!(got > 0)) fail('Unexpected end of update payload');
    offset += got;
  }
  return out;
}

function u32(value) {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32BE(value);
  return out;
}

function u64(value) {
  const out = Buffer.allocUnsafe(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}

function hashBuffer(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

export async function sha256File(file) {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  stream.on('data', (chunk) => hash.update(chunk));
  await once(stream, 'end');
  return hash.digest('hex');
}

function walkFiles(root, here = root, entries = []) {
  for (const entry of readdirSync(here, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = resolve(here, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, entries);
    else if (entry.isFile()) entries.push(full);
    else fail(`Update packages do not support non-file entry: ${full}`);
  }
  return entries;
}

export async function treeManifest(root) {
  const base = resolve(root);
  if (!existsSync(base) || !statSync(base).isDirectory()) fail(`Client directory is missing: ${base}`);
  const files = [];
  for (const full of walkFiles(base)) {
    const rel = relative(base, full).replaceAll('\\', '/');
    files.push({ path: safeRelative(rel), size: statSync(full).size, sha256: await sha256File(full) });
  }
  const digest = hashBuffer(Buffer.from(JSON.stringify(files)));
  return { files, sha256: digest };
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Create a file-level Windows delta. `outDir` is an unpacked update package. */
export async function createWindowsDelta({ fromDir, toDir, outDir, fromVersion = null, toVersion = null }) {
  const fromRoot = resolve(fromDir);
  const toRoot = resolve(toDir);
  const output = resolve(outDir);
  if (output === fromRoot || output === toRoot) fail('Update output cannot be a client directory');
  const before = await treeManifest(fromRoot);
  const after = await treeManifest(toRoot);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });

  const oldByPath = new Map(before.files.map((file) => [file.path, file]));
  const newByPath = new Map(after.files.map((file) => [file.path, file]));
  const changed = [];
  for (const file of after.files) {
    const old = oldByPath.get(file.path);
    if (old?.sha256 === file.sha256) continue;
    const payload = child(resolve(output, 'files'), file.path);
    mkdirSync(dirname(payload), { recursive: true });
    copyFileSync(child(toRoot, file.path), payload);
    changed.push(file);
  }
  const removed = before.files.filter((file) => !newByPath.has(file.path)).map((file) => file.path);
  const manifest = {
    format: 'stronghold-windows-update-v1',
    from: { version: fromVersion, treeSha256: before.sha256, files: before.files.length },
    to: { version: toVersion, treeSha256: after.sha256, files: after.files.length },
    // Keep file-level expectations so the PowerShell updater can verify a base client without Node.js.
    baseFiles: before.files,
    targetFiles: after.files,
    changed,
    removed,
  };
  writeJson(resolve(output, 'update.json'), manifest);
  return { manifest, changedBytes: changed.reduce((sum, file) => sum + file.size, 0) };
}

/** Apply an unpacked Windows delta. Intended for verification and the PowerShell updater's contract. */
export async function applyWindowsDelta({ packageDir, targetDir }) {
  const pkg = resolve(packageDir);
  const target = resolve(targetDir);
  const manifest = JSON.parse(readFileSync(resolve(pkg, 'update.json'), 'utf8'));
  if (manifest.format !== 'stronghold-windows-update-v1') fail('Unsupported Windows update package');
  const actual = await treeManifest(target);
  if (actual.sha256 !== manifest.from?.treeSha256) fail('The selected Windows client is not the expected base version');
  for (const rel of manifest.removed || []) rmSync(child(target, rel), { force: true });
  for (const file of manifest.changed || []) {
    const source = child(resolve(pkg, 'files'), file.path);
    if (!existsSync(source)) fail(`Update payload is missing: ${file.path}`);
    const destination = child(target, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (await sha256File(destination) !== file.sha256) fail(`Update payload hash mismatch: ${file.path}`);
  }
  const complete = await treeManifest(target);
  if (complete.sha256 !== manifest.to?.treeSha256) fail('Windows update did not produce the expected client');
  return manifest;
}

function adler32(buffer, start = 0, length = buffer.length - start) {
  let a = 1;
  let b = 0;
  const end = start + length;
  for (let index = start; index < end; index++) {
    a += buffer[index];
    b += a;
    if ((index & 4095) === 4095) { a %= MOD_ADLER; b %= MOD_ADLER; }
  }
  return (((b % MOD_ADLER) << 16) | (a % MOD_ADLER)) >>> 0;
}

function rollAdler(sum, removed, added, length) {
  let a = (sum & 0xffff) - removed + added;
  a %= MOD_ADLER;
  if (a < 0) a += MOD_ADLER;
  let b = (sum >>> 16) - length * removed + a - 1;
  b %= MOD_ADLER;
  if (b < 0) b += MOD_ADLER;
  return ((b << 16) | a) >>> 0;
}

function baseBlocks(file, blockSize) {
  const fd = openSync(file, 'r');
  const size = statSync(file).size;
  const map = new Map();
  const buffer = Buffer.allocUnsafe(blockSize);
  try {
    for (let offset = 0; offset + blockSize <= size; offset += blockSize) {
      const got = readSync(fd, buffer, 0, blockSize, offset);
      if (got !== blockSize) fail('Unable to read base APK');
      const weak = adler32(buffer);
      const record = { offset, strong: hashBuffer(buffer) };
      const records = map.get(weak);
      if (records) records.push(record);
      else map.set(weak, [record]);
    }
  } finally { closeSync(fd); }
  return map;
}

function writeLiteral(fd, source) {
  if (!source.length) return;
  writeAll(fd, Buffer.from([0]));
  writeAll(fd, u32(source.length));
  writeAll(fd, source);
}

function writeCopy(fd, offset, length) {
  writeAll(fd, Buffer.from([1]));
  writeAll(fd, u64(offset));
  writeAll(fd, u32(length));
}

/**
 * Generate a rolling-checksum delta. It copies unchanged 32 KiB blocks from the old signed APK and
 * writes only unmatched bytes. Applying it reconstructs the exact target bytes, preserving APK signatures.
 */
export async function createBinaryDelta({ fromFile, toFile, outFile, blockSize = BLOCK_SIZE }) {
  if (!(blockSize > 0 && blockSize <= 0xffffffff)) fail('Invalid delta block size');
  const source = resolve(fromFile);
  const target = resolve(toFile);
  const out = resolve(outFile);
  if (!existsSync(source) || !statSync(source).isFile()) fail(`Base file is missing: ${source}`);
  if (!existsSync(target) || !statSync(target).isFile()) fail(`Target file is missing: ${target}`);
  mkdirSync(dirname(out), { recursive: true });
  const baseHash = await sha256File(source);
  const targetHash = await sha256File(target);
  const sourceSize = statSync(source).size;
  const targetData = readFileSync(target);
  const blocks = baseBlocks(source, blockSize);
  const fd = openSync(out, 'w');
  try {
    writeAll(fd, PATCH_MAGIC);
    writeAll(fd, u32(PATCH_VERSION));
    writeAll(fd, u32(blockSize));
    writeAll(fd, Buffer.from(baseHash, 'hex'));
    writeAll(fd, Buffer.from(targetHash, 'hex'));
    writeAll(fd, u64(sourceSize));
    writeAll(fd, u64(targetData.length));
    let literalStart = 0;
    let index = 0;
    let weak = targetData.length >= blockSize ? adler32(targetData, 0, blockSize) : 0;
    while (index + blockSize <= targetData.length) {
      const candidates = blocks.get(weak);
      let match = null;
      if (candidates?.length) {
        const strong = hashBuffer(targetData.subarray(index, index + blockSize));
        match = candidates.find((candidate) => candidate.strong === strong) || null;
      }
      if (match) {
        writeLiteral(fd, targetData.subarray(literalStart, index));
        writeCopy(fd, match.offset, blockSize);
        index += blockSize;
        literalStart = index;
        weak = index + blockSize <= targetData.length ? adler32(targetData, index, blockSize) : 0;
      } else {
        if (index + blockSize >= targetData.length) break;
        weak = rollAdler(weak, targetData[index], targetData[index + blockSize], blockSize);
        index++;
      }
    }
    writeLiteral(fd, targetData.subarray(literalStart));
    writeAll(fd, Buffer.from([255]));
  } finally { closeSync(fd); }
  return { baseSha256: baseHash, targetSha256: targetHash, baseBytes: sourceSize, targetBytes: targetData.length, patchBytes: statSync(out).size, blockSize };
}

/** Reconstruct and verify a target file from a binary delta. */
export async function applyBinaryDelta({ fromFile, deltaFile, outFile }) {
  const source = resolve(fromFile);
  const patch = resolve(deltaFile);
  const output = resolve(outFile);
  const sourceFd = openSync(source, 'r');
  const patchFd = openSync(patch, 'r');
  const temporary = `${output}.partial`;
  rmSync(temporary, { force: true });
  mkdirSync(dirname(output), { recursive: true });
  const outFd = openSync(temporary, 'w');
  let expectedTargetHash;
  try {
    let pos = 0;
    if (!readExact(patchFd, 8, pos).equals(PATCH_MAGIC)) fail('Unsupported Android update payload');
    pos += 8;
    if (readExact(patchFd, 4, pos).readUInt32BE() !== PATCH_VERSION) fail('Unsupported Android update version');
    pos += 4;
    const blockSize = readExact(patchFd, 4, pos).readUInt32BE(); pos += 4;
    const expectedBaseHash = readExact(patchFd, 32, pos).toString('hex'); pos += 32;
    expectedTargetHash = readExact(patchFd, 32, pos).toString('hex'); pos += 32;
    const expectedBaseBytes = readExact(patchFd, 8, pos).readBigUInt64BE(); pos += 8;
    const expectedTargetBytes = readExact(patchFd, 8, pos).readBigUInt64BE(); pos += 8;
    if (pos !== PATCH_HEADER_BYTES || blockSize < 1) fail('Invalid Android update header');
    if (BigInt(statSync(source).size) !== expectedBaseBytes || await sha256File(source) !== expectedBaseHash) {
      fail('The selected APK is not the expected base version');
    }
    let produced = 0n;
    const buffer = Buffer.allocUnsafe(Math.min(blockSize, 1024 * 1024));
    for (;;) {
      const op = readExact(patchFd, 1, pos)[0]; pos++;
      if (op === 255) break;
      if (op === 0) {
        let remaining = readExact(patchFd, 4, pos).readUInt32BE(); pos += 4;
        while (remaining) {
          const length = Math.min(remaining, buffer.length);
          const bytes = readExact(patchFd, length, pos); pos += length;
          writeAll(outFd, bytes);
          remaining -= length;
          produced += BigInt(length);
        }
      } else if (op === 1) {
        let sourcePos = readExact(patchFd, 8, pos).readBigUInt64BE(); pos += 8;
        let remaining = readExact(patchFd, 4, pos).readUInt32BE(); pos += 4;
        if (sourcePos + BigInt(remaining) > expectedBaseBytes) fail('Android update copy range exceeds base APK');
        while (remaining) {
          const length = Math.min(remaining, buffer.length);
          const got = readSync(sourceFd, buffer, 0, length, Number(sourcePos));
          if (got !== length) fail('Unable to read base APK while applying update');
          writeAll(outFd, buffer.subarray(0, length));
          sourcePos += BigInt(length);
          remaining -= length;
          produced += BigInt(length);
        }
      } else fail(`Unknown Android update operation: ${op}`);
    }
    if (produced !== expectedTargetBytes) fail('Android update produced an unexpected APK length');
  } finally {
    closeSync(outFd);
    closeSync(patchFd);
    closeSync(sourceFd);
  }
  if (await sha256File(temporary) !== expectedTargetHash) {
    rmSync(temporary, { force: true });
    fail('Android update did not produce the expected APK');
  }
  rmSync(output, { force: true });
  renameSync(temporary, output);
  return { sha256: expectedTargetHash, bytes: statSync(output).size };
}

export async function createAndroidDelta({ fromApk, toApk, outDir, fromVersion = null, toVersion = null }) {
  const output = resolve(outDir);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const patchName = 'client.spdelta';
  const result = await createBinaryDelta({ fromFile: fromApk, toFile: toApk, outFile: resolve(output, patchName) });
  const manifest = {
    format: 'stronghold-android-update-v1',
    from: { version: fromVersion, apkSha256: result.baseSha256, bytes: result.baseBytes },
    to: { version: toVersion, apkSha256: result.targetSha256, bytes: result.targetBytes },
    patch: { file: patchName, bytes: result.patchBytes, blockBytes: result.blockSize },
  };
  writeJson(resolve(output, 'update.json'), manifest);
  return { manifest, ...result };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) fail(`Missing ${name}`);
  return args[index + 1];
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'windows') {
    const result = await createWindowsDelta({ fromDir: argValue(args, '--from'), toDir: argValue(args, '--to'), outDir: argValue(args, '--out'), fromVersion: args.includes('--from-version') ? argValue(args, '--from-version') : null, toVersion: args.includes('--to-version') ? argValue(args, '--to-version') : null });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === 'android') {
    const result = await createAndroidDelta({ fromApk: argValue(args, '--from'), toApk: argValue(args, '--to'), outDir: argValue(args, '--out'), fromVersion: args.includes('--from-version') ? argValue(args, '--from-version') : null, toVersion: args.includes('--to-version') ? argValue(args, '--to-version') : null });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (command === 'apply-android') {
    const result = await applyBinaryDelta({ fromFile: argValue(args, '--from'), deltaFile: argValue(args, '--delta'), outFile: argValue(args, '--out') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    fail('Usage: clientDelta.mjs <windows|android|apply-android> --from <path> --to/--delta <path> --out <path>');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
