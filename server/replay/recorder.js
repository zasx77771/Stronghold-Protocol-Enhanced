// In-memory recorder for one running match. Keeping events together gives Brotli useful
// redundancy and avoids SQLite write amplification during a busy combat phase.

const copy = (value) => JSON.parse(JSON.stringify(value ?? null));

export class MatchRecorder {
  constructor(store, meta) {
    this.store = store;
    this.startedAt = Number.isFinite(meta.startedAt) ? meta.startedAt : Date.now();
    this.id = store.createMatch(meta);
    this.timeline = [];
    this.seq = 0;
    this.finished = false;
  }

  add(kind, payload, extra = {}) {
    if (this.finished) return;
    this.timeline.push({ seq: ++this.seq, atMs: Math.max(0, Date.now() - this.startedAt), kind, ...extra, payload: copy(payload) });
  }

  action(playerId, message, phase) { this.add('action', message, { playerId, phase }); }
  system(type, payload, phase) { this.add('system', { type, ...payload }, { phase }); }
  frame(direction, playerId, message, phase) { this.add('frame', message, { direction, playerId: playerId || null, phase }); }

  finish(summary, result) {
    if (this.finished) return;
    this.finished = true;
    this.store.finalizeMatch(this.id, { summary, result, timeline: this.timeline, endedAt: Date.now() });
  }
}
