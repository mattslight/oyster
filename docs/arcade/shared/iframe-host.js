// Shared iframe ↔ host bridge.
//
// Self-installs on script load. When the page is embedded as an iframe:
//   - flags <body> with `.is-embedded` so the game can target embedded-only
//     styles if needed
//   - on ESC, posts a close message up to the parent. Both the new arcade
//     name and the legacy rocket-ship name are sent, so the existing
//     close handler in docs/index.html keeps working.

(function () {
  if (window.self !== window.top) document.body.classList.add('is-embedded');

  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    try { window.parent.postMessage({ type: 'arcade-close' }, '*'); } catch (_) {}
    // Back-compat with the rocket-ship close handler in docs/index.html.
    try { window.parent.postMessage({ type: 'oyster-rocket-close' }, '*'); } catch (_) {}
  });
})();
