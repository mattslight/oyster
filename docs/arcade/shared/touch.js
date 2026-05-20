// Shared touch-button binding helper.
//
// The game declares its own <button> elements (left/right/jump/thrust/…)
// and wires each up with Arcade.Touch.bind(btn, onDown, onUp). The helper
// handles the pointer events (down + up + cancel + leave), the visual
// `.is-pressed` flip, and stops bubbling so a tap on a button doesn't
// also fire the splash's global dismiss listener.

(function () {
  function isCoarse() {
    return !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  }

  function bind(btn, onDown, onUp) {
    if (!btn) return;
    const down = e => { e.preventDefault(); btn.classList.add('is-pressed'); onDown(); };
    const up   = e => { if (e) e.preventDefault(); btn.classList.remove('is-pressed'); onUp(); };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
    ['pointerdown', 'mousedown', 'touchstart'].forEach(ev => {
      btn.addEventListener(ev, e => e.stopPropagation(), { passive: false });
    });
  }

  window.Arcade = window.Arcade || {};
  window.Arcade.Touch = { isCoarse, bind };
})();
