// Shared leaderboard client for the arcade games. Scoped per-game via the
// `game` key passed to init() — corresponds to the worker's GAMES allowlist
// (see infra/leaderboard-worker/src/worker.ts).
//
// Local mirror in localStorage is the source of truth for `qualifies()` so
// the game can decide in-memory whether to prompt for initials without a
// round-trip. Cloud (the Cloudflare Worker) is the canonical store and is
// refreshed asynchronously on init and after a successful submit.
//
// Usage:
//   Arcade.Leaderboard.init({ game: 'platformer', max: 10 });
//   Arcade.Leaderboard.refresh();           // fire-and-forget, updates mirror
//   if (Arcade.Leaderboard.qualifies(score)) ...
//   const r = await Arcade.Leaderboard.submit(score, 'ABC');

(function () {
  const LB_API = '/api/leaderboard';
  const LB_API_START = '/api/leaderboard/start';

  let game = null;
  let MAX = 10;
  let LB_KEY = null;

  // One token per session, refreshed lazily. The worker TTL is 1 hour; we
  // mint on demand and trust its expiry rather than tracking it precisely.
  let _playToken = null;
  let _playTokenExp = 0;

  function init(opts) {
    game = (opts && opts.game) || null;
    MAX = (opts && opts.max) || 10;
    LB_KEY = game ? `oyster-arcade-leaderboard-${game}` : null;
  }

  function read() {
    if (!LB_KEY) return [];
    try {
      const s = localStorage.getItem(LB_KEY);
      if (!s) return [];
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.slice(0, MAX) : [];
    } catch (_) { return []; }
  }

  function write(list) {
    if (!LB_KEY) return;
    try { localStorage.setItem(LB_KEY, JSON.stringify(list.slice(0, MAX))); } catch (_) {}
  }

  async function refresh() {
    if (!game) return read();
    try {
      const r = await fetch(`${LB_API}?game=${encodeURIComponent(game)}`);
      if (!r.ok) return read();
      const j = await r.json();
      if (Array.isArray(j.list)) {
        write(j.list);
        return j.list;
      }
    } catch (_) {}
    return read();
  }

  function qualifies(score) {
    if (!Number.isFinite(score) || score <= 0) return false;
    const list = read();
    if (list.length < MAX) return true;
    return score > list[list.length - 1].score;
  }

  function getHighScore() {
    const list = read();
    return list.length ? list[0] : null;
  }

  async function ensurePlayToken() {
    const now = Date.now();
    if (_playToken && _playTokenExp > now + 60_000) return _playToken;
    try {
      const r = await fetch(LB_API_START, { method: 'GET' });
      if (!r.ok) return null;
      const j = await r.json();
      if (typeof j.token !== 'string') return null;
      _playToken = j.token;
      _playTokenExp = typeof j.expires_at === 'number' ? j.expires_at : 0;
      return _playToken;
    } catch (_) { return null; }
  }

  async function submit(score, initials) {
    if (!game) return { ok: false, error: 'not_initialised' };
    const token = await ensurePlayToken();
    if (!token) return { ok: false, error: 'no_token' };
    try {
      const r = await fetch(LB_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ game, score, initials, token }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(j.list)) {
        write(j.list);
        return { ok: true, list: j.list };
      }
      // Token expired during the session: invalidate so the next call mints fresh.
      if (j && j.error === 'invalid_token') { _playToken = null; _playTokenExp = 0; }
      return { ok: false, error: (j && j.error) || `http_${r.status}` };
    } catch (_) { return { ok: false, error: 'network' }; }
  }

  window.Arcade = window.Arcade || {};
  window.Arcade.Leaderboard = { init, read, refresh, qualifies, getHighScore, submit };
})();
