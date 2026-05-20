// Shared pause overlay + global volume sliders for all arcade games.
//
// Usage (in a game's HTML):
//   <script src="../shared/pause.js"></script>
//   // … then in the game's update loop:
//   if (Arcade.Pause.isPaused()) return;
//
// Pressing P or ESC toggles the pause overlay. The overlay holds two
// 5-step volume bars (MUSIC + SFX) and shares state across every game in
// the arcade via localStorage keys:
//
//   oyster-arcade-music-volume  — 0..1, controls every <audio id^="bgm">
//   oyster-arcade-sfx-volume    — 0..1, threaded into Arcade.Audio master gain
//
// Legacy *-muted keys are still read on first boot so existing players
// don't get reset when they upgrade. They're discarded once a volume key
// is written. `Arcade.Audio.init({ volumeKey: 'oyster-arcade-sfx-volume', … })`
// gives Arcade.Audio its own persistence; pause.js mirrors on user changes.
//
// API exposed on window.Arcade.Pause:
//   isPaused()                     — bool, true while overlay is visible
//   pause() / resume() / toggle()
//   getMusicVolume() / setMusicVolume(0..1)
//   getSfxVolume()   / setSfxVolume(0..1)
//   isMusicMuted() / setMusicMuted(bool)  — kept for back-compat (vol 0/1)
//   isSfxMuted()   / setSfxMuted(bool)    — kept for back-compat (vol 0/1)
//   onToggle(cb)                   — fires whenever music/sfx state changes
//   canPause = fn() | null         — optional gate; pause/resume are no-ops if it returns false

(function () {
  const MUSIC_VOL_KEY  = 'oyster-arcade-music-volume';
  const SFX_VOL_KEY    = 'oyster-arcade-sfx-volume';
  const MUSIC_MUTE_KEY = 'oyster-arcade-music-muted';   // legacy
  const SFX_MUTE_KEY   = 'oyster-arcade-sfx-muted';     // legacy

  const STEPS = 5;            // 0/1/2/3/4 → 0, 25%, 50%, 75%, 100%
  const DEFAULT_VOLUME = 1;

  let paused = false;
  let pauseEl = null;
  const onToggleCbs = [];

  function readVolume(volKey, muteKey) {
    try {
      const raw = localStorage.getItem(volKey);
      if (raw != null) {
        const n = parseFloat(raw);
        if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
      }
    } catch (_) {}
    // Legacy fallback — boolean mute → volume 0 (muted) or 1 (unmuted).
    try { if (localStorage.getItem(muteKey) === '1') return 0; } catch (_) {}
    return DEFAULT_VOLUME;
  }
  function writeVolume(key, v) {
    try { localStorage.setItem(key, String(v)); } catch (_) {}
  }

  // Step ↔ continuous helpers. The slider is discrete (STEPS levels), but
  // the underlying audio APIs are 0..1 continuous — round to the nearest
  // step for display so the bar always matches the saved value.
  function stepFromVolume(v) { return Math.round(Math.max(0, Math.min(1, v)) * (STEPS - 1)); }
  function volumeFromStep(s) { return Math.max(0, Math.min(STEPS - 1, s)) / (STEPS - 1); }

  function getMusicVolume() { return readVolume(MUSIC_VOL_KEY, MUSIC_MUTE_KEY); }
  function getSfxVolume()   {
    if (window.Arcade && Arcade.Audio && Arcade.Audio.getVolume) return Arcade.Audio.getVolume();
    return readVolume(SFX_VOL_KEY, SFX_MUTE_KEY);
  }

  function applyMusicVolume() {
    const v = getMusicVolume();
    document.querySelectorAll('audio[id^="bgm"]').forEach(a => {
      a.volume = v;
      a.muted = v === 0;
    });
  }

  function setMusicVolume(v) {
    const clamped = Math.max(0, Math.min(1, v));
    writeVolume(MUSIC_VOL_KEY, clamped);
    applyMusicVolume();
    paint();
    onToggleCbs.forEach(cb => { try { cb(); } catch (_) {} });
  }

  function setSfxVolume(v) {
    const clamped = Math.max(0, Math.min(1, v));
    if (window.Arcade && Arcade.Audio && Arcade.Audio.setVolume) {
      Arcade.Audio.setVolume(clamped);
      // setVolume mirrors onto every <audio> element including bgm tracks
      // — restore the (independent) music state so the two sliders don't
      // bleed into each other.
      applyMusicVolume();
    } else {
      writeVolume(SFX_VOL_KEY, clamped);
    }
    paint();
    onToggleCbs.forEach(cb => { try { cb(); } catch (_) {} });
  }

  // Boolean aliases for the legacy callers — mute = 0, unmute = full.
  function getMusicMuted() { return getMusicVolume() === 0; }
  function getSfxMuted()   { return getSfxVolume()   === 0; }
  function setMusicMuted(m) { setMusicVolume(m ? 0 : 1); }
  function setSfxMuted(m)   { setSfxVolume(m   ? 0 : 1); }

  function ensureOverlay() {
    if (pauseEl) return;
    // Inject styles once.
    if (!document.getElementById('arcade-pause-styles')) {
      const s = document.createElement('style');
      s.id = 'arcade-pause-styles';
      s.textContent = `
        .arcade-pause {
          position: fixed; inset: 0; z-index: 9999;
          background: rgba(0, 0, 0, 0.78);
          display: none; align-items: center; justify-content: center;
          font-family: 'Press Start 2P', ui-monospace, monospace;
        }
        .arcade-pause.is-active { display: flex; }
        .arcade-pause-card {
          background: linear-gradient(180deg, #1a0d3a 0%, #050a25 100%);
          border: 3px solid #2dd4ff;
          padding: clamp(20px, 4vw, 40px) clamp(28px, 6vw, 56px);
          text-align: center;
          display: flex; flex-direction: column; gap: clamp(12px, 2vw, 18px);
          box-shadow: 0 0 40px rgba(45, 212, 255, 0.35), 6px 6px 0 #000;
          min-width: 240px;
        }
        .arcade-pause-title {
          font-size: clamp(18px, 4vw, 32px);
          color: #ffd84a; letter-spacing: 0.18em;
          text-shadow: 3px 3px 0 #ff3aa1, 6px 6px 0 #2dd4ff;
        }
        .arcade-pause-row {
          display: flex; align-items: center;
          gap: clamp(8px, 1.6vw, 14px);
          padding: 8px 12px;
          border: 2px solid #2dd4ff;
          font-family: inherit;
          font-size: clamp(10px, 1.8vw, 14px);
          letter-spacing: 0.14em;
          color: #2dd4ff;
        }
        .arcade-pause-row.is-muted .arcade-pause-row-label {
          color: rgba(255, 255, 255, 0.4);
          text-decoration: line-through;
          text-decoration-thickness: 0.12em;
        }
        .arcade-pause-row.is-muted { border-color: rgba(255, 255, 255, 0.25); }
        .arcade-pause-row-label {
          flex: 1; text-align: left; min-width: 80px;
        }
        .arcade-pause-bar {
          display: flex; gap: 3px;
        }
        .arcade-pause-seg {
          width: clamp(14px, 2.6vw, 22px);
          height: clamp(14px, 2.6vw, 22px);
          border: 2px solid #2dd4ff;
          background: transparent;
          cursor: pointer;
          padding: 0;
          -webkit-tap-highlight-color: transparent;
          transition: background 0.1s;
        }
        .arcade-pause-seg.is-on { background: #2dd4ff; }
        .arcade-pause-seg:hover { border-color: #fff; }
        .arcade-pause-seg.is-on:hover { background: #fff; }
        .arcade-pause-hint {
          font-size: clamp(8px, 1.3vw, 10px);
          letter-spacing: 0.24em;
          color: rgba(255, 255, 255, 0.55);
          margin-top: 4px;
          animation: arcade-blink 1.2s steps(1) infinite;
        }
      `;
      document.head.appendChild(s);
    }
    function rowHtml(label, kind, glyph) {
      let segs = '';
      for (let i = 0; i < STEPS; i++) {
        segs += `<button class="arcade-pause-seg" type="button" data-kind="${kind}" data-step="${i}" aria-label="${label} level ${i + 1}"></button>`;
      }
      return `
        <div class="arcade-pause-row" data-row="${kind}">
          <span class="arcade-pause-row-label">${glyph} ${label}</span>
          <span class="arcade-pause-bar">${segs}</span>
        </div>
      `;
    }
    pauseEl = document.createElement('div');
    pauseEl.className = 'arcade-pause';
    pauseEl.setAttribute('aria-hidden', 'true');
    pauseEl.innerHTML = `
      <div class="arcade-pause-card" role="dialog" aria-label="Paused">
        <div class="arcade-pause-title">PAUSED</div>
        ${rowHtml('MUSIC', 'music', '♫')}
        ${rowHtml('SFX',   'sfx',   '♪')}
        <div class="arcade-pause-hint">P or ESC to resume</div>
      </div>
    `;
    document.body.appendChild(pauseEl);
    // Segment clicks set the volume to (step+1)/STEPS, EXCEPT: clicking the
    // segment that's already the last-lit one toggles down to mute (step 0).
    // That gives a single-tap mute path without sacrificing the "click any
    // segment to set" affordance.
    pauseEl.querySelectorAll('.arcade-pause-seg').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const kind = btn.dataset.kind;
        const step = parseInt(btn.dataset.step, 10);
        const cur  = stepFromVolume(kind === 'music' ? getMusicVolume() : getSfxVolume());
        const targetStep = (step + 1 === cur) ? 0 : step + 1;
        const v = volumeFromStep(targetStep);
        if (kind === 'music') setMusicVolume(v); else setSfxVolume(v);
      });
    });
  }

  function paint() {
    if (!pauseEl) return;
    function paintRow(kind, value) {
      const row = pauseEl.querySelector(`[data-row="${kind}"]`);
      if (!row) return;
      row.classList.toggle('is-muted', value === 0);
      const cur = stepFromVolume(value);
      row.querySelectorAll('.arcade-pause-seg').forEach(seg => {
        const step = parseInt(seg.dataset.step, 10);
        seg.classList.toggle('is-on', step < cur);
      });
    }
    paintRow('music', getMusicVolume());
    paintRow('sfx',   getSfxVolume());
  }

  function pause() {
    if (paused) return;
    if (Arcade.Pause.canPause && !Arcade.Pause.canPause()) return;
    paused = true;
    ensureOverlay();
    pauseEl.classList.add('is-active');
    pauseEl.setAttribute('aria-hidden', 'false');
    paint();
  }
  function resume() {
    if (!paused) return;
    paused = false;
    if (pauseEl) {
      pauseEl.classList.remove('is-active');
      pauseEl.setAttribute('aria-hidden', 'true');
    }
  }
  function toggle() { paused ? resume() : pause(); }

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
      // Don't pause while a text-entry field is focused.
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      toggle();
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // Apply persisted music volume to every bgm-prefixed <audio> on the page
  // once the DOM is ready (handles late audio elements too).
  function init() {
    applyMusicVolume();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.Arcade = window.Arcade || {};
  window.Arcade.Pause = {
    isPaused: () => paused,
    pause, resume, toggle,
    getMusicVolume, setMusicVolume,
    getSfxVolume,   setSfxVolume,
    isMusicMuted: getMusicMuted,        // legacy aliases
    isSfxMuted:   getSfxMuted,
    setMusicMuted,
    setSfxMuted,
    onToggle(cb) { if (typeof cb === 'function') onToggleCbs.push(cb); },
    canPause: null,
  };
})();
