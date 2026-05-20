// Shared audio for the arcade games.
//
// 8-bit SFX via Web Audio. The naive <audio>-element approach hitched on
// every shot because setting currentTime=0 to retrigger an MP3 forces the
// browser to tear down and reinit its decoder on the main thread, dropping
// a frame. Web Audio decodes each clip once into an AudioBuffer and plays
// disposable BufferSources for each shot — no seek, no decode, runs on the
// audio thread so it can't block paint.
//
// <audio id="<sfx-id>"> elements in the page document act as a fallback
// for the short window between page load and first decode completing.
// They MUST share their `id` with the keys passed to init({ sfx }).
//
// Usage (volumeKey is preferred — gives players a slider in the pause
// overlay; mutedKey is the legacy on/off variant, still accepted for
// back-compat with older cabinet games):
//   Arcade.Audio.init({ sfx: { 'sfx-coin': 'sfx-coin.mp3', ... },
//                       volumeKey: 'oyster-arcade-sfx-volume' });
//   // ...on first user gesture (e.g. splash dismiss):
//   Arcade.Audio.ensureCtx();
//   // ...in-game:
//   Arcade.Audio.play('sfx-coin', 0.5);
//
// iOS detail: the AudioContext MUST be created/resumed inside the user
// gesture that triggered the action (splash tap, keypress). Don't move
// ensureCtx() into a setTimeout or async chain — the context will stay
// suspended and play() will be silent.

(function () {
  let sfxFiles = {};
  let volumeKey = null;
  let mutedKey = null;          // legacy
  let audioCtx = null;
  let masterGain = null;
  let buffers = {};
  let masterVolume = 1;          // 0..1 — multiplied into each play()'s per-clip volume

  function readInitialVolume() {
    // Prefer the volume key (number 0..1). Fall back to the legacy mute key.
    if (volumeKey) {
      try {
        const raw = localStorage.getItem(volumeKey);
        if (raw != null) {
          const n = parseFloat(raw);
          if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
        }
      } catch (_) {}
    }
    if (mutedKey) {
      try { if (localStorage.getItem(mutedKey) === '1') return 0; } catch (_) {}
    }
    return 1;
  }

  function init(opts) {
    sfxFiles = (opts && opts.sfx) || {};
    volumeKey = (opts && opts.volumeKey) || null;
    mutedKey  = (opts && opts.mutedKey)  || null;
    setVolume(readInitialVolume(), { persist: false });
  }

  function ensureCtx() {
    try {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        audioCtx = new Ctx();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = masterVolume;
        masterGain.connect(audioCtx.destination);
        Object.entries(sfxFiles).forEach(async ([id, src]) => {
          try {
            const resp = await fetch(src);
            const arr = await resp.arrayBuffer();
            buffers[id] = await audioCtx.decodeAudioData(arr);
          } catch (_) {}
        });
      }
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch (_) {}
    return audioCtx;
  }

  function setVolume(v, opts) {
    masterVolume = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    if (masterGain) masterGain.gain.value = masterVolume;
    // Mirror onto every <audio> element so the fallback path matches the
    // Web Audio master. Note: this also touches BGM tracks — pause.js
    // re-applies the music volume right after if both keys are managed.
    document.querySelectorAll('audio').forEach(a => { a.volume = masterVolume; });
    if (volumeKey && (!opts || opts.persist !== false)) {
      try { localStorage.setItem(volumeKey, String(masterVolume)); } catch (_) {}
    }
  }

  function getVolume() { return masterVolume; }

  // Legacy boolean API — keeps older callers working. Mute = volume 0;
  // unmute restores to 1 (the legacy default). For nuanced control, use
  // setVolume directly.
  function setMuted(m) { setVolume(m ? 0 : 1); }
  function isMuted() { return masterVolume === 0; }

  function play(id, volume) {
    if (volume == null) volume = 0.6;
    const c = audioCtx;
    const buf = c && buffers[id];
    if (!c || !buf) {
      // Fallback: <audio> element. Used only until the matching buffer
      // finishes decoding, which is usually well before any in-game shot.
      const el = document.getElementById(id);
      if (!el) return;
      el.volume = masterVolume * volume;
      try { el.currentTime = 0; el.play().catch(() => {}); } catch (_) {}
      return;
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const gain = c.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(masterGain);
    try { src.start(0); } catch (_) {}
  }

  window.Arcade = window.Arcade || {};
  window.Arcade.Audio = { init, ensureCtx, setVolume, getVolume, setMuted, isMuted, play };
})();
