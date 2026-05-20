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
// Usage (use the arcade-wide mute key so MUSIC / SFX state is shared
// across every cabinet game — see shared/pause.js):
//   Arcade.Audio.init({ sfx: { 'sfx-coin': 'sfx-coin.mp3', ... },
//                       mutedKey: 'oyster-arcade-sfx-muted' });
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
  let mutedKey = null;
  let audioCtx = null;
  let masterGain = null;
  let buffers = {};
  let muted = false;

  function init(opts) {
    sfxFiles = (opts && opts.sfx) || {};
    mutedKey = (opts && opts.mutedKey) || null;
    let initialMuted = false;
    if (mutedKey) {
      try { initialMuted = localStorage.getItem(mutedKey) === '1'; } catch (_) {}
    }
    setMuted(initialMuted);
  }

  function ensureCtx() {
    try {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        audioCtx = new Ctx();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = muted ? 0 : 1;
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

  function setMuted(m) {
    muted = !!m;
    if (masterGain) masterGain.gain.value = muted ? 0 : 1;
    // Mirror onto every <audio> element (used for the fallback path AND any
    // background-music track the page declares).
    document.querySelectorAll('audio').forEach(a => { a.muted = muted; });
    if (mutedKey) {
      try { localStorage.setItem(mutedKey, muted ? '1' : '0'); } catch (_) {}
    }
  }

  function isMuted() { return muted; }

  function play(id, volume) {
    if (volume == null) volume = 0.6;
    const c = audioCtx;
    const buf = c && buffers[id];
    if (!c || !buf) {
      // Fallback: <audio> element. Used only until the matching buffer
      // finishes decoding, which is usually well before any in-game shot.
      const el = document.getElementById(id);
      if (!el) return;
      el.volume = muted ? 0 : volume;
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
  window.Arcade.Audio = { init, ensureCtx, setMuted, isMuted, play };
})();
