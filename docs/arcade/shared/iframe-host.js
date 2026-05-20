// Shared iframe ↔ host bridge.
//
// Self-installs on script load. When the page is embedded as an iframe:
//   - flags <body> with `.is-embedded` so the game can target embedded-only
//     styles if needed
//   - on ESC, posts a close message up to the parent (back-compat: also
//     sends the legacy rocket-ship name so docs/index.html's handler
//     still works). Only fires when the page is actually embedded; in a
//     standalone tab ESC has no host to talk to.
//
// Coordination with shared/pause.js: if the game loaded the pause
// module, ESC belongs to pause (toggle overlay), so we no-op here to
// avoid the cabinet closing behind the pause UI. Games that don't load
// pause.js (e.g. the easter-egg standalone path) still get ESC-close.

(function () {
  const embedded = window.self !== window.top;
  if (embedded) document.body.classList.add('is-embedded');

  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!embedded) return;                                   // standalone: no host
    if (window.Arcade && window.Arcade.Pause) return;         // pause owns ESC
    try { window.parent.postMessage({ type: 'arcade-close' }, '*'); } catch (_) {}
    try { window.parent.postMessage({ type: 'oyster-rocket-close' }, '*'); } catch (_) {}
  });
})();
