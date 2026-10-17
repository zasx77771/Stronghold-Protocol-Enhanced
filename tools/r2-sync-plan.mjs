#!/usr/bin/env node
/**
 * Deterministic R2 asset sync plan.
 *
 * The release channel is a directory of content-addressed asset packages plus `assets-index.json`
 * (`tools/assets-r2.mjs` writes it). This tool answers one question offline: given the local channel and
 * a snapshot of the remote bucket, which objects are missing or different, and in what order must an
 * operator upload them?
 *
 * It never touches the network. The remote state is a JSON or NDJSON fixture that a read-only listing
 * (`aws s3api list-objects-v2 --query 'Contents[]'`) produces; the tool reads it and prints the plan.
 * It deliberately cannot upload, delete or list anything: the operator runs the printed commands with
 * their own credentials, and `docs/ASSETS-R2-SYNC.md` documents the runbook.
 *
 * Guarantees:
 *  - the same channel and the same snapshot always produce byte-identical output (sorted keys, no
 *    timestamps, no randomness);
 *  - a plan is only "complete" when every object the index serves is in the snapshot with the expected
 *    sha256 and size, so an unverifiable snapshot fails instead of printing a misleading short plan;
 *  - two keys carrying identical bytes are refused, because that is the same content queued for upload
 *    twice under two version names;
 *  - uploads come first, `head-object` verification second and the signed index metadata last.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INDEX_FILE, basePackageName, checkIndex, deltaPackageName, formatBytes, packageNameInfo, sha256File
} from './assetPackages.mjs';

export const PLAN_FORMAT = 'sp-assets-r2-sync-plan-v1';
export const SNAPSHOT_FORMAT = 'sp-assets-r2-snapshot-v1';

/** The published index is always the last object an operator may replace. */
export const INDEX_ACTION = 'publish-index';
export const UPLOAD_ACTION = 'upload';
export const VERIFY_ACTION = 'head-object';

const normalizeHash = (value) => {
  const text = value === undefined || value === null ? '' : String(value).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
};

const normalizeSize = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
};

/** Keys that must never be treated as a bucket object (path traversal, absolute paths, directories). */
export function checkObjectKey(key) {
  if (typeof key !== 'string' || key === '') return 'empty object key';
  if (key.includes('\\')) return `object key ${JSON.stringify(key)} contains a backslash`;
  if (key.startsWith('/') || /^[A-Za-z]:/.test(key)) return `object key ${JSON.stringify(key)} is absolute`;
  const segments = key.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `object key ${JSON.stringify(key)} has an unsafe path segment`;
  }
  if (segments.length !== 1) return `object key ${JSON.stringify(key)} has a prefix; only bucket-root keys are supported`;
  return null;
}

/**
 * sha256 → every key that carries exactly those bytes.
 *
 * Content is the identity of an object: a version bump that ships the same asset bytes must reuse one
 * key, never add a second one. This index proves that, and `loadChannel` fails on any digest that
 * appears twice.
 */
export function contentIndex(objects) {
  const byContent = new Map();
  for (const object of objects) {
    const digest = (object.expected && object.expected.sha256) || object.sha256;
    if (!digest) continue;
    if (!byContent.has(digest)) byContent.set(digest, []);
    byContent.get(digest).push(object.key);
  }
  return Object.fromEntries(
    [...byContent.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([digest, keys]) => [digest, keys.slice().sort()])
  );
}

/**
 * Read the local release channel.
 *
 * `assets-index.json` is the authority: it decides the object set, so a package that sits in the
 * directory but is not served is reported as a note and never uploaded, and a package the index serves
 * but the directory lost is an error (the plan cannot be proven complete).
 */
export function loadChannel(dir, { hash = true } = {}) {
  const root = path.resolve(dir);
  const indexPath = path.join(root, INDEX_FILE);
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  const problems = checkIndex(index).map((line) => `${line}`);
  const objects = [];
  const seen = new Set();
  const failed = (message) => ({ dir: root, indexPath, index, objects: [], problems: [...problems, message] });

  if (index.format !== 'sp-assets-index-v1') return failed(`${indexPath}: unsupported index format ${index.format}`);
  if (!(index.bases || []).length) return failed(`${indexPath}: the index serves no baseline`);

  for (const item of [...(index.bases || []), ...(index.deltas || [])]) {
    const keyProblem = checkObjectKey(item.name);
    if (keyProblem) { problems.push(keyProblem); continue; }
    // The file name is the authority for the kind/version/from triple: the index only records `from`
    // and `to` for a delta, so reading `item.version` there would lose the target version.
    const info = packageNameInfo(item.name) || {};
    const kind = info.kind || (item.to ? 'delta' : 'base');
    const version = String(info.version ?? item.to ?? item.version ?? '');
    const from = info.from ?? (item.from ? String(item.from) : null);
    const expectedName = kind === 'delta' ? deltaPackageName(from, version) : basePackageName(version);
    if (item.name !== expectedName) problems.push(`index: ${item.name} does not match the package name it claims`);
    if (!normalizeHash(item.sha256)) problems.push(`index: ${item.name} has no usable sha256`);
    const file = path.join(root, item.name);
    let size;
    try {
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error('not a file');
      size = stat.size;
    } catch {
      problems.push(`${item.name} is listed in the index but missing in ${root}`);
      continue;
    }
    if (Number(item.size) !== size) {
      problems.push(`${item.name} is ${size} bytes on disk but the index records ${item.size}`);
    }
    objects.push({
      key: item.name,
      kind,
      version,
      from,
      localPath: file,
      size,
      sha256: hash ? sha256File(file) : normalizeHash(item.sha256),
      expected: { size: Number(item.size), sha256: normalizeHash(item.sha256) }
    });
    seen.add(item.name);
  }

  // Two keys with the same bytes are the same object uploaded twice, which is exactly what a release
  // that ships no new asset bytes must never cause: refuse to plan it instead of uploading both.
  for (const [digest, keys] of Object.entries(contentIndex(objects))) {
    if (keys.length < 2) continue;
    problems.push(`${keys.join(' and ')} carry identical content (sha256 ${digest}); the index reuses one object instead of uploading both`);
  }

  const strays = readdirSync(root).sort().filter((name) => packageNameInfo(name) && !seen.has(name));
  /*
   * The index itself is an object like any other, but it is published last. Its digest is always computed
   * and always expected: a release that only rewrites the metadata (a version whose asset set did not
   * change) differs from the published index by bytes, not by size, so comparing sizes alone would report
   * "nothing to do" for exactly the release that has to publish it.
   */
  const indexSize = statSync(indexPath).size;
  const indexSha256 = sha256File(indexPath);
  const indexObject = {
    key: INDEX_FILE,
    kind: 'index',
    version: String(index.latest),
    from: null,
    localPath: indexPath,
    size: indexSize,
    sha256: indexSha256,
    expected: { size: indexSize, sha256: indexSha256 }
  };
  return {
    dir: root,
    indexPath,
    index,
    latest: String(index.latest),
    objects: [...objects, indexObject],
    packages: objects,
    strays,
    problems
  };
}

/**
 * Read a bucket snapshot.
 *
 * Accepted shapes: `{ objects: [...] }` / `{ Contents: [...] }` / a bare array, as JSON (pretty-printed,
 * exactly what `aws s3api list-objects-v2 --output json` writes) or NDJSON, with the S3 names (`Key`,
 * `Size`, `ETag`) or the plain names (`key`, `size`, `sha256`/`etag`). An object without a sha256 and
 * without an ETag is kept as unverifiable, which fails the plan instead of being silently assumed healthy.
 */
export function parseSnapshot(text, { name = 'snapshot' } = {}) {
  const problems = [];
  const entries = [];
  const push = (raw, where) => {
    if (!raw || typeof raw !== 'object') { problems.push(`${where}: object entry is not an object`); return; }
    const key = String(raw.Key ?? raw.key ?? raw.name ?? '');
    const keyProblem = checkObjectKey(key);
    if (keyProblem) { problems.push(`${where}: ${keyProblem}`); return; }
    const etag = raw.ETag !== undefined ? String(raw.ETag) : raw.etag !== undefined ? String(raw.etag) : null;
    const md5 = etag ? etag.replace(/^"|"$/g, '') : null;
    entries.push({
      key,
      size: normalizeSize(raw.Size ?? raw.size),
      sha256: normalizeHash(raw.sha256 ?? raw.SHA256 ?? raw.checksumSHA256 ?? raw.ChecksumSHA256),
      etag: md5 && /^[0-9a-f]{32}$/i.test(md5) ? md5.toLowerCase() : null,
      metadata: (raw.Metadata || raw.metadata) && typeof (raw.Metadata || raw.metadata) === 'object' ? (raw.Metadata || raw.metadata) : null,
      raw
    });
  };

  const trimmed = String(text).trim();
  if (!trimmed) {
    problems.push(`${name}: the snapshot is empty`);
  } else {
    /**
     * One JSON listing (`aws s3api list-objects-v2 --output json` is pretty-printed and spans many
     * lines) or one JSON object per line (NDJSON). The whole document is parsed first: NDJSON can never
     * satisfy `JSON.parse` for the complete text, so the fallback below only runs when it really is
     * line-delimited and no line of a pretty-printed listing is silently dropped.
     */
    let parsed;
    let whole = true;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      whole = false;
    }
    if (!whole) {
      trimmed.split(/\r?\n/).forEach((raw, position) => {
        const line = raw.trim();
        if (!line) return;
        try {
          push(JSON.parse(line), `${name}:${position + 1}`);
        } catch (error) {
          problems.push(`${name}:${position + 1}: ${error.message}`);
        }
      });
    } else if (Array.isArray(parsed)) {
      parsed.forEach((raw, position) => push(raw, `${name}#${position}`));
    } else if (parsed && typeof parsed === 'object') {
      const list = Array.isArray(parsed.objects) ? parsed.objects
        : Array.isArray(parsed.Contents) ? parsed.Contents
          : Array.isArray(parsed.contents) ? parsed.contents : null;
      if (!list) problems.push(`${name}: no "objects", "Contents" or array of objects was found`);
      else list.forEach((raw, position) => push(raw, `${name}#${position}`));
    } else {
      problems.push(`${name}: the snapshot must be a JSON listing of objects`);
    }
  }

  const objects = new Map();
  for (const entry of entries) {
    if (objects.has(entry.key)) problems.push(`${name}: ${entry.key} is listed twice`);
    else objects.set(entry.key, entry);
  }
  return { format: SNAPSHOT_FORMAT, objects, problems, entries };
}

export function readSnapshot(file) {
  const text = readFileSync(file, 'utf8');
  const parsed = parseSnapshot(text, { name: path.basename(file) });
  return { ...parsed, file: path.resolve(file) };
}

/**
 * Compare the channel with the snapshot.
 *
 * Every difference is reported with the key, the expected sha256/size and what the snapshot says, so an
 * operator can tell a lost upload from a corrupted one without downloading anything. `unverifiable` is a
 * stronger failure than `missing`: an object the snapshot cannot vouch for (no sha256 and no ETag) does
 * not prove the snapshot is a real listing, so the plan stays unprovable instead of silently "re-uploading
 * everything". A snapshot that contradicts the index fails the plan for the same reason.
 */
export function diffChannel(channel, snapshot) {
  const problems = [...channel.problems, ...snapshot.problems];
  const missing = [];
  const mismatched = [];
  const upToDate = [];
  const unverifiable = [];

  for (const object of channel.objects) {
    const remote = snapshot.objects.get(object.key);
    if (!remote) { missing.push(object); continue; }
    const reasons = [];
    // A 32 character ETag is the md5 of a single part upload; a multipart ETag has a dash and is skipped.
    const digest = remote.sha256 || remote.etag;
    if (!digest) {
      unverifiable.push({ ...object, remote: summarizeRemote(remote), reasons: ['the snapshot has neither sha256 nor ETag for this key'] });
      continue;
    }
    if (object.expected.sha256 && remote.sha256 && remote.sha256 !== object.expected.sha256) {
      reasons.push(`sha256 ${remote.sha256} != expected ${object.expected.sha256}`);
    }
    if (remote.size !== null && object.expected.size !== null && remote.size !== object.expected.size) {
      reasons.push(`size ${remote.size} != expected ${object.expected.size}`);
    }
    if (reasons.length) mismatched.push({ ...object, remote: summarizeRemote(remote), reasons });
    else upToDate.push(object);
  }
  return { problems, missing, mismatched, upToDate, unverifiable };
}

const summarizeRemote = (remote) => ({
  sha256: remote.sha256,
  size: remote.size,
  etag: remote.etag,
  metadata: remote.metadata
});

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Build the deterministic plan.
 *
 * Order is fixed: every missing or mismatched package ZIP is uploaded, each upload is verified with
 * `head-object`, and the index metadata is published last so it can never point at an object that is
 * not in the bucket yet. `complete` is true only when nothing about the channel and the snapshot
 * prevented the tool from proving the full object set.
 */
export function buildPlan({ channel, snapshot, diff = null, remote = { bucket: 'r2', endpoint: null } }) {
  const result = diff || diffChannel(channel, snapshot);
  const broken = [...result.missing, ...result.mismatched].sort(byKey);
  // `diffChannel` returns enriched copies, so differences are matched by key, never by reference.
  const brokenKeys = new Set(broken.map((item) => item.key));
  const missingKeys = new Set(result.missing.map((item) => item.key));
  const operations = [];
  for (const item of broken) {
    if (item.kind === 'index') continue;
    operations.push({
      order: operations.length + 1,
      action: UPLOAD_ACTION,
      bucket: remote.bucket,
      key: item.key,
      kind: item.kind,
      version: item.version,
      from: item.from,
      source: item.localPath,
      size: item.size,
      sha256: item.expected.sha256,
      reason: missingKeys.has(item.key) ? 'missing in the bucket snapshot' : 'the bucket snapshot does not match the index'
    });
  }
  const uploaded = operations.map((operation) => operation.key);
  const verifications = [];
  for (const key of uploaded) {
    const item = broken.find((entry) => entry.key === key);
    verifications.push({
      order: operations.length + verifications.length + 1,
      action: VERIFY_ACTION,
      bucket: remote.bucket,
      key,
      expect: { size: item.expected.size, sha256: item.expected.sha256 },
      verify: ['size', 'sha256', 'content-type', 'cache-control']
    });
  }
  // Verification follows the uploads, so an operator never publishes an index before it is proven.
  operations.push(...verifications);
  const indexObject = channel.objects.find((object) => object.kind === 'index');
  const indexNeedsPublish = Boolean(indexObject) && brokenKeys.has(indexObject.key);
  if (indexNeedsPublish) {
    operations.push({
      order: operations.length + 1,
      action: INDEX_ACTION,
      bucket: remote.bucket,
      key: indexObject.key,
      kind: 'index',
      version: indexObject.version,
      source: indexObject.localPath,
      size: indexObject.size,
      /** The index is tiny and re-read on every publish, so its own digest is always computed. */
      sha256: indexObject.sha256,
      reason: missingKeys.has(indexObject.key)
        ? 'the index is missing in the bucket snapshot'
        : 'the index does not match the bucket snapshot'
    });
  }
  const indexOperations = operations.filter((operation) => operation.action === INDEX_ACTION);
  const plan = {
    format: PLAN_FORMAT,
    bucket: remote.bucket,
    endpoint: remote.endpoint,
    channel: channel.dir,
    index: channel.indexPath,
    latest: channel.latest,
    indexKey: INDEX_FILE,
    /** True only when the run publishes the index, and always as the final operation. */
    indexPublishedLast: indexOperations.length > 0 && operations.at(-1).action === INDEX_ACTION,
    deterministic: true,
    complete: result.problems.length === 0 && result.unverifiable.length === 0,
    problems: [...result.problems, ...result.unverifiable.flatMap((item) => item.reasons.map((reason) => `${item.key}: ${reason}`))],
    counts: {
      objects: channel.objects.length,
      packages: channel.objects.length - 1,
      missing: result.missing.length,
      mismatched: result.mismatched.length,
      unverifiable: result.unverifiable.length,
      upToDate: result.upToDate.length,
      uploads: operations.filter((operation) => operation.action === UPLOAD_ACTION).length,
      verifications: verifications.length,
      indexPublishes: indexOperations.length
    },
    uploads: operations.filter((operation) => operation.action === UPLOAD_ACTION).sort(byKey),
    verifications: verifications.sort(byKey),
    indexPublish: indexOperations.length ? indexOperations[0] : null,
    operations,
    upToDate: result.upToDate.map((item) => item.key).sort(),
    packages: (channel.packages || []).map((item) => ({
      key: item.key,
      kind: item.kind,
      version: item.version,
      from: item.from,
      size: item.size,
      sha256: item.sha256
    })),
    /** sha256 → the keys that carry those bytes; one entry per package, so nothing is uploaded twice. */
    contentIndex: contentIndex(channel.packages || [])
  };
  if (channel.strays && channel.strays.length) {
    plan.strays = channel.strays.slice().sort();
  }
  return plan;
}

/** Change the published route without pretending a new asset package exists. */
export function planPublishIndexOnly(channel, snapshot, remote) {
  const plan = buildPlan({ channel, snapshot, remote });
  return plan;
}

export function planToJson(plan) {
  return `${JSON.stringify(plan)}\n`;
}

function commandsFor(plan, { endpoint = null, publicBase = null } = {}) {
  const base = endpoint ? String(endpoint).replace(/\/+$/, '') : '<R2-BUCKET-URL>';
  const lines = [];
  lines.push('# 1. upload the missing or mismatched content-addressed ZIPs');
  if (!plan.uploads.length) lines.push('#    (none: every package the index serves is already in the bucket)');
  for (const item of plan.uploads) {
    lines.push(`aws s3 cp "${item.key}" "${base}/${item.key}" --content-type application/zip --cache-control "public, max-age=31536000, immutable"`);
  }
  lines.push('# 2. verify each upload with head-object (size, sha256, metadata)');
  if (!plan.verifications.length) lines.push('#    (nothing to verify)');
  for (const item of plan.verifications) {
    lines.push(`aws s3api head-object --bucket ${plan.bucket} --key "${item.key}"   # expect ${item.expect.size} bytes, sha256 ${item.expect.sha256}`);
  }
  lines.push('# 3. publish the signed index metadata last');
  if (!plan.indexPublish) lines.push('#    (the index already matches the bucket)');
  else lines.push(`aws s3 cp "${INDEX_FILE}" "${base}/${INDEX_FILE}" --content-type application/json --cache-control "public, max-age=60, must-revalidate"`);
  if (publicBase) {
    lines.push('# 4. verify these public URLs');
    for (const item of [...plan.uploads, ...(plan.indexPublish ? [plan.indexPublish] : [])]) {
      lines.push(`${String(publicBase).replace(/\/+$/, '')}/${item.key}`);
    }
  }
  return lines;
}

const USAGE = `usage: node tools/r2-sync-plan.mjs --dir <channel dir> --snapshot <file> [options]

options:
  --dir <dir>          local release channel (asset packages + assets-index.json)
  --snapshot <file>    local snapshot of the bucket state (JSON or NDJSON; never fetched)
  --bucket <name>      bucket name recorded in the plan (default: r2)
  --endpoint <url>     endpoint printed in the runbook commands
  --public-base <url>  public base URL printed for verification
  --json               print only the plan JSON (byte-identical for equal inputs)
  --commands           print only the operator commands
  --quiet              print nothing; use the exit status
  --allow-empty-bucket allow a snapshot that lists no objects at all (first publish of an empty bucket)

The exit status is 0 when the plan could be proven from the channel and the snapshot: the index and the
local packages agree, and every object in the snapshot carries the size and sha256 needed to compare it.
Such a plan may still contain uploads -- a missing or mismatched object is a finding, not a broken plan --
so run the plan it prints. When no plan can be proven (a channel problem, an object the snapshot cannot
describe, an empty snapshot without --allow-empty-bucket) the status is 1 and no commands are printed.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--help' || item === '-h') { args.help = true; continue; }
    if (!item.startsWith('--')) { args._.push(item); continue; }
    const [rawKey, inline] = item.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    if (inline !== undefined) { args[key] = inline; continue; }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    index += 1;
  }
  return args;
}

/**
 * Report a failure. The exit status is the caller's contract (`run` returns 1 and the CLI entry point
 * assigns it), so nothing here mutates global process state — embedding `run` in a test or another tool
 * must not be able to flip the host process's exit code.
 */
const fail = (message, out = null) => {
  if (out) out(`r2-sync-plan: ${message}`);
  console.error(`r2-sync-plan: ${message}`);
};

export function run(argv, io = {}) {
  const out = io.out || ((line) => process.stdout.write(`${line}\n`));
  const args = parseArgs(argv);
  if (args.help) { out(USAGE); return 0; }
  if (!args.dir || args.dir === true) { fail('--dir is required', out); return 1; }
  if (!args.snapshot || args.snapshot === true) { fail('--snapshot is required (a local bucket snapshot; this tool never lists the bucket)', out); return 1; }

  let channel;
  try {
    channel = loadChannel(String(args.dir));
  } catch (error) {
    fail(error.message, out);
    return 1;
  }
  let snapshot;
  try {
    snapshot = readSnapshot(String(args.snapshot));
  } catch (error) {
    fail(error.message, out);
    return 1;
  }

  const plan = planPublishIndexOnly(channel, snapshot, {
    bucket: args.bucket && args.bucket !== true ? String(args.bucket) : 'r2',
    endpoint: args.endpoint && args.endpoint !== true ? String(args.endpoint) : null
  });
  // A channel whose local packages disagree with its own index is as unprovable as a bad snapshot, and an
  // empty listing is far more likely to be a failed listing than an empty bucket: refusing it is the whole
  // point of the tool, because "upload everything" is exactly the misleading plan it must never print.
  const blocking = [];
  if (snapshot.objects.size === 0 && !args.allowEmptyBucket) {
    blocking.push('the snapshot lists no objects at all; refusing to plan a full re-upload of the channel'
      + ' (pass --allow-empty-bucket only when the bucket is genuinely empty)');
  }
  const complete = plan.complete && channel.problems.length === 0 && blocking.length === 0;
  const effective = { ...plan, problems: [...plan.problems, ...blocking], complete };

  if (!args.quiet) {
    if (args.json) out(planToJson(effective).trimEnd());
    else if (args.commands) {
      // A plan that cannot be proven complete must never look like a runnable runbook.
      if (complete) for (const line of commandsFor(effective, { endpoint: effective.endpoint, publicBase: args.publicBase && args.publicBase !== true ? String(args.publicBase) : null })) out(line);
      else out('# INCOMPLETE: the plan cannot be proven complete; no commands are emitted');
    } else {
      out(`channel ${effective.channel}`);
      out(`index   ${effective.index} (latest ${effective.latest})`);
      out(`bucket  ${effective.bucket}`);
      out(`objects ${effective.counts.objects}: ${effective.counts.packages} package(s) + the index; ${effective.counts.upToDate} up to date, ${effective.counts.missing} missing, ${effective.counts.mismatched} mismatched, ${effective.counts.unverifiable} unverifiable`);
      out(`plan: ${effective.counts.uploads} upload(s), ${effective.counts.verifications} head-object verification(s), ${effective.counts.indexPublishes} index publish(es) ${effective.indexPublishedLast ? 'last' : ''}`);
      for (const problem of effective.problems) out(`problem: ${problem}`);
      if (!complete) out('INCOMPLETE: the plan cannot be proven complete; nothing was uploaded and no commands are printed');
      else {
        for (const line of commandsFor(effective, { endpoint: effective.endpoint, publicBase: args.publicBase && args.publicBase !== true ? String(args.publicBase) : null })) out(line);
        if (!effective.counts.uploads && !effective.counts.indexPublishes) out('the bucket already serves this channel; nothing to do');
      }
    }
  }
  return complete ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = run(process.argv.slice(2));

export { commandsFor, USAGE, formatBytes };
