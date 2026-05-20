// Shared pause overlay + global mute toggles for all arcade games.
//
// Usage (in a game's HTML):
//   <script src="../shared/pause.js"></script>
//   // … then in the game's update loop:
//   if (Arcade.Pause.isPaused()) return;
//
// Pressing P or ESC toggles the pause overlay. The overlay holds the
// MUSIC and SFX toggles and shares mute state across every game in the
// arcade via localStorage keys:
//
//   oyster-arcade-music-muted  — controls every <audio id^="bgm"> on the page
//   oyster-arcade-sfx-muted    — controls Arcade.Audio (sfx buffers)
//
// `Arcade.Audio.init({ mutedKey: 'oyster-arcade-sfx-muted', … })` makes
// the SFX toggle persistent across reloads / games. Music is handled
// here directly via the <audio> element's `muted` property.
//
// API exposed on window.Arcade.Pause:
//   isPaused()              — bool, true while overlay is visible
//   pause() / resume() / toggle()
//   isMusicMuted() / setMusicMuted(bool)
//   isSfxMuted()   / setSfxMuted(bool)
//   onToggle(cb)            — fires whenever music/sfx state flips
//   canPause = fn() | null  — optional gate; pause/resume are no-ops if it returns false

(function () {
  const MUSIC_KEY = 'oyster-arcade-music-muted';
  const SFX_KEY   = 'oyster-arcade-sfx-muted';

  let paused = false;
  let pauseEl = null;
  const onToggleCbs = [];

  function readBool(key) {
    try { return localStorage.getItem(key) === '1'; } catch (_) { return false; }
  }
  function writeBool(key, v) {
    try { localStorage.setItem(key, v ? '1' : '0'); } catch (_) {}
  }

  function getMusicMuted() { return readBool(MUSIC_KEY); }
  function getSfxMuted()   {
    return (window.Arcade && Arcade.Audio && Arcade.Audio.isMuted)
      ? Arcade.Audio.isMuted()
      : readBool(SFX_KEY);
  }

  function applyMusicMute() {
    const m = getMusicMuted();
    document.querySelectorAll('audio[id^="bgm"]').forEach(a => { a.muted = m; });
  }

  function setMusicMuted(m) {
    writeBool(MUSIC_KEY, m);
    applyMusicMute();
    paint();
    onToggleCbs.forEach(cb => { try { cb(); } catch (_) {} });
  }

  function setSfxMuted(m) {
    if (window.Arcade && Arcade.Audio && Arcade.Audio.setMuted) {
      Arcade.Audio.setMuted(m);
      // Arcade.Audio.setMuted mirrors muted=true onto every <audio>
      // including the bgm tracks — restore the (independent) music state
      // so the two toggles don't bleed into each other.
      applyMusicMute();
    } else {
      writeBool(SFX_KEY, m);
    }
    paint();
    onToggleCbs.forEach(cb => { try { cb(); } catch (_) {} });
  }

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
        .arcade-pause-toggle {
          background: transparent;
          border: 2px solid #2dd4ff;
          color: #2dd4ff;
          padding: 10px 14px;
          font-family: inherit;
          font-size: clamp(10px, 1.8vw, 14px);
          letter-spacing: 0.14em;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
          transition: color 0.12s, border-color 0.12s, background 0.12s;
        }
        .arcade-pause-toggle:hover,
        .arcade-pause-toggle:focus-visible {
          color: #fff; border-color: #fff;
          background: rgba(255, 255, 255, 0.06);
          outline: none;
        }
        .arcade-pause-toggle.is-muted {
          color: rgba(255, 255, 255, 0.4);
          text-decoration: line-through;
          text-decoration-thickness: 0.12em;
          border-color: rgba(255, 255, 255, 0.25);
        }
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
    pauseEl = document.createElement('div');
    pauseEl.className = 'arcade-pause';
    pauseEl.setAttribute('aria-hidden', 'true');
    pauseEl.innerHTML = `
      <div class="arcade-pause-card" role="dialog" aria-label="Paused">
        <div class="arcade-pause-title">PAUSED</div>
        <button class="arcade-pause-toggle" data-toggle="music" type="button">♫ MUSIC</button>
        <button class="arcade-pause-toggle" data-toggle="sfx"   type="button">♪ SFX</button>
        <div class="arcade-pause-hint">P or ESC to resume</div>
      </div>
    `;
    document.body.appendChild(pauseEl);
    pauseEl.querySelector('[data-toggle="music"]').addEventListener('click', e => {
      e.stopPropagation();
      setMusicMuted(!getMusicMuted());
    });
    pauseEl.querySelector('[data-toggle="sfx"]').addEventListener('click', e => {
      e.stopPropagation();
      setSfxMuted(!getSfxMuted());
    });
  }

  function paint() {
    if (!pauseEl) return;
    const m = pauseEl.querySelector('[data-toggle="music"]');
    const s = pauseEl.querySelector('[data-toggle="sfx"]');
    if (m) m.classList.toggle('is-muted', getMusicMuted());
    if (s) s.classList.toggle('is-muted', getSfxMuted());
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

  // Apply persisted music mute to every bgm-prefixed <audio> on the page
  // once the DOM is ready (handles late audio elements too).
  function init() {
    applyMusicMute();
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
    isMusicMuted: getMusicMuted,
    isSfxMuted:   getSfxMuted,
    setMusicMuted,
    setSfxMuted,
    onToggle(cb) { if (typeof cb === 'function') onToggleCbs.push(cb); },
    canPause: null,
  };
})();
