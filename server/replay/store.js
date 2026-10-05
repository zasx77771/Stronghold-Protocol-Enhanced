// Durable local match history. The raw replay envelope is immutable once a match finishes;
// SQLite only indexes its small, queryable summary and keeps the compressed payload as a blob.

import fs from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID, createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

export const REPLAY_FORMAT_VERSION = 1;

const json = (value, fallback = null) => {
  try { return JSON.parse(value); } catch { return fallback; }
};
const now = () => Date.now();
const asTag = (value) => typeof value === 'string' && /^\d{4}$/.test(value) ? value : null;
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function archiveId() {
  return `r_${randomUUID().replaceAll('-', '')}`;
}

/** Embedded SQLite storage used by the game server and the separate TCP replay service. */
export class ReplayStore {
  constructor({ file, log = console } = {}) {
    if (!file) throw new TypeError('ReplayStore requires a file path');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.log = log;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tag TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS profiles_name_idx ON profiles(name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        room_code TEXT,
        match_no INTEGER NOT NULL,
        seed INTEGER NOT NULL,
        mode TEXT,
        difficulty TEXT,
        stage_id TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        data_hash TEXT NOT NULL,
        summary_json TEXT,
        result_json TEXT,
        replay_bytes INTEGER NOT NULL DEFAULT 0,
        replay_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS matches_started_idx ON matches(started_at DESC);
      CREATE TABLE IF NOT EXISTS match_players (
        match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        user_id TEXT,
        player_id TEXT NOT NULL,
        seat INTEGER NOT NULL,
        name_at_match TEXT NOT NULL,
        tag_at_match TEXT,
        is_bot INTEGER NOT NULL DEFAULT 0,
        loadout_json TEXT,
        result_json TEXT,
        PRIMARY KEY(match_id, player_id)
      );
      CREATE INDEX IF NOT EXISTS match_players_user_idx ON match_players(user_id);
      CREATE INDEX IF NOT EXISTS match_players_name_idx ON match_players(name_at_match COLLATE NOCASE, tag_at_match);
      CREATE TABLE IF NOT EXISTS replay_chunks (
        match_id TEXT PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
        codec TEXT NOT NULL,
        payload BLOB NOT NULL
      );
    `);
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }

  profileCandidates(name) {
    if (typeof name !== 'string' || !name) return [];
    return this.db.prepare('SELECT user_id, name, tag FROM profiles WHERE name = ? COLLATE NOCASE ORDER BY tag').all(name)
      .map((r) => ({ userId: r.user_id, name: r.name, tag: r.tag }));
  }

  profileById(userId) {
    if (typeof userId !== 'string') return null;
    const r = this.db.prepare('SELECT user_id, name, tag FROM profiles WHERE user_id = ?').get(userId);
    return r ? { userId: r.user_id, name: r.name, tag: r.tag } : null;
  }

  /** Resolve a persistent local profile. A supplied tag must name the supplied nickname exactly. */
  resolveProfile(name, tag = null, existingUserId = null) {
    const cleanTag = asTag(tag);
    const existing = this.profileById(existingUserId);
    if (existing) {
      if (cleanTag && cleanTag !== existing.tag) return null;
      if (existing.name !== name) this.db.prepare('UPDATE profiles SET name = ?, updated_at = ? WHERE user_id = ?').run(name, now(), existing.userId);
      return { ...existing, name };
    }
    if (cleanTag) {
      const r = this.db.prepare('SELECT user_id, name, tag FROM profiles WHERE name = ? COLLATE NOCASE AND tag = ?').get(name, cleanTag);
      return r ? { userId: r.user_id, name: r.name, tag: r.tag } : null;
    }
    return this.createProfile(name);
  }

  createProfile(name) {
    const stamp = now();
    let tag = null;
    for (let i = 0; i < 64; i++) {
      const candidate = String(randomInt(10_000)).padStart(4, '0');
      if (!this.db.prepare('SELECT 1 FROM profiles WHERE tag = ?').get(candidate)) { tag = candidate; break; }
    }
    if (!tag) {
      for (let i = 0; i < 10_000; i++) {
        const candidate = String(i).padStart(4, '0');
        if (!this.db.prepare('SELECT 1 FROM profiles WHERE tag = ?').get(candidate)) { tag = candidate; break; }
      }
    }
    if (!tag) throw new Error('all four-digit profile tags are allocated');
    const userId = `u_${randomUUID().replaceAll('-', '')}`;
    this.db.prepare('INSERT INTO profiles(user_id, name, tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, name, tag, stamp, stamp);
    return { userId, name, tag };
  }

  dataHash(data) { return hash(data || {}); }

  createMatch(meta) {
    const id = archiveId();
    const stamp = Number.isFinite(meta.startedAt) ? meta.startedAt : now();
    this.db.prepare(`INSERT INTO matches(id, schema_version, room_code, match_no, seed, mode, difficulty, stage_id, started_at, status, data_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recording', ?)`)
      .run(id, REPLAY_FORMAT_VERSION, meta.roomCode || null, Number(meta.matchNo) || 0, Number(meta.seed) >>> 0,
        meta.mode || null, meta.difficulty || null, meta.stageId || null, stamp, meta.dataHash || hash({}));
    const add = this.db.prepare(`INSERT INTO match_players(match_id, user_id, player_id, seat, name_at_match, tag_at_match, is_bot, loadout_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of meta.players || []) {
      add.run(id, p.userId || null, p.playerId, Number(p.seat) || 0, p.name || '博士', p.tag || null, p.isBot ? 1 : 0,
        JSON.stringify(plain(p.loadout || null)));
    }
    return id;
  }

  finalizeMatch(id, { summary, result, timeline, endedAt = now() }) {
    const envelope = {
      kind: 'stronghold-protocol-replay', formatVersion: REPLAY_FORMAT_VERSION,
      result: plain(result), timeline: plain(timeline || []),
    };
    const raw = Buffer.from(JSON.stringify(envelope));
    const payload = brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } });
    const digest = hash(raw);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR REPLACE INTO replay_chunks(match_id, codec, payload) VALUES (?, ?, ?)').run(id, 'br', payload);
      this.db.prepare(`UPDATE matches SET ended_at = ?, status = 'complete', summary_json = ?, result_json = ?, replay_bytes = ?, replay_hash = ? WHERE id = ?`)
        .run(endedAt, JSON.stringify(plain(summary || null)), JSON.stringify(plain(result || null)), payload.length, digest, id);
      const row = result && Array.isArray(result.players) ? result.players : [];
      const set = this.db.prepare('UPDATE match_players SET result_json = ? WHERE match_id = ? AND player_id = ?');
      for (const p of row) set.run(JSON.stringify(plain(p)), id, p.playerId);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  listMatches({ q = '', limit = 100 } = {}) {
    const query = String(q || '').trim();
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    const rows = this.db.prepare(`SELECT m.*, GROUP_CONCAT(COALESCE(mp.name_at_match, '博士') || CASE WHEN mp.tag_at_match IS NOT NULL THEN '#' || mp.tag_at_match ELSE '' END, ' · ') AS players
      FROM matches m LEFT JOIN match_players mp ON mp.match_id = m.id
      WHERE (? = '' OR m.id LIKE '%' || ? || '%' OR EXISTS (
        SELECT 1 FROM match_players x WHERE x.match_id = m.id AND (x.name_at_match LIKE '%' || ? || '%' OR x.tag_at_match = ?)
      ))
      GROUP BY m.id ORDER BY m.started_at DESC LIMIT ?`).all(query, query, query, query.replace(/^#/, ''), n);
    return rows.map((r) => ({
      id: r.id, roomCode: r.room_code, matchNo: r.match_no, seed: r.seed, mode: r.mode, difficulty: r.difficulty,
      stageId: r.stage_id, startedAt: r.started_at, endedAt: r.ended_at, status: r.status, replayBytes: r.replay_bytes,
      summary: json(r.summary_json), result: json(r.result_json), players: r.players ? r.players.split(' · ') : [],
    }));
  }

  getMatch(id, { includeTimeline = true } = {}) {
    const m = this.db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    if (!m) return null;
    const players = this.db.prepare('SELECT * FROM match_players WHERE match_id = ? ORDER BY seat').all(id).map((p) => ({
      userId: p.user_id, playerId: p.player_id, seat: p.seat, name: p.name_at_match, tag: p.tag_at_match,
      isBot: !!p.is_bot, loadout: json(p.loadout_json), result: json(p.result_json),
    }));
    const out = {
      id: m.id, formatVersion: m.schema_version, roomCode: m.room_code, matchNo: m.match_no, seed: m.seed,
      mode: m.mode, difficulty: m.difficulty, stageId: m.stage_id, startedAt: m.started_at, endedAt: m.ended_at,
      status: m.status, dataHash: m.data_hash, replayBytes: m.replay_bytes, replayHash: m.replay_hash,
      summary: json(m.summary_json), result: json(m.result_json), players,
    };
    if (includeTimeline) {
      const chunk = this.db.prepare('SELECT codec, payload FROM replay_chunks WHERE match_id = ?').get(id);
      if (chunk) {
        try {
          const text = chunk.codec === 'br' ? brotliDecompressSync(Buffer.from(chunk.payload)).toString('utf8') : Buffer.from(chunk.payload).toString('utf8');
          out.replay = json(text, { corrupted: true });
        } catch { out.replay = { corrupted: true }; }
      } else out.replay = null;
    }
    return out;
  }

  exportMatch(id) {
    const match = this.getMatch(id, { includeTimeline: true });
    if (!match) return null;
    return { kind: 'stronghold-protocol-replay-export', exportVersion: 1, exportedAt: now(), match };
  }

  importArchive(archive) {
    const source = archive && archive.kind === 'stronghold-protocol-replay-export' ? archive.match : null;
    if (!source || typeof source !== 'object' || !source.replay || !Array.isArray(source.replay.timeline)) throw new TypeError('invalid replay archive');
    if (this.db.prepare('SELECT 1 FROM matches WHERE id = ?').get(source.id)) return source.id;
    const meta = {
      roomCode: source.roomCode, matchNo: source.matchNo, seed: source.seed, mode: source.mode, difficulty: source.difficulty,
      stageId: source.stageId, startedAt: source.startedAt, dataHash: source.dataHash,
      players: source.players || [],
    };
    const id = this.createMatch({ ...meta, players: meta.players.map((p) => ({ ...p, loadout: p.loadout })) });
    this.finalizeMatch(id, { summary: source.summary, result: source.result || source.replay.result, timeline: source.replay.timeline, endedAt: source.endedAt || now() });
    return id;
  }

  deleteMatch(id) { return this.db.prepare('DELETE FROM matches WHERE id = ?').run(id).changes > 0; }

  stats() {
    const r = this.db.prepare("SELECT COUNT(*) AS matches, COALESCE(SUM(replay_bytes), 0) AS bytes FROM matches WHERE status = 'complete'").get();
    return { matches: Number(r.matches) || 0, bytes: Number(r.bytes) || 0, retention: 'forever' };
  }
}
