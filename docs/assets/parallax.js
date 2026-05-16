// Star field motion. Two effects layered together:
//   1. Mouse parallax — cursor away from centre shifts the layers,
//      opposite to the cursor; near layer shifts more than far.
//   2. Ambient drift — slow sinusoidal sway on each axis, different
//      periods per layer so the motion never visibly repeats.
// Skipped under prefers-reduced-motion and on touch-only devices.
(function () {
  if (!window.matchMedia) return;
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  var motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  if (motionQuery.matches) return;

  var far = document.querySelector('.stars-far');
  var near = document.querySelector('.stars-near');
  var orbit = document.querySelector('.orbit-svg');
  var heroMock = document.querySelector('.hero-mock');
  if (!far && !near && !orbit) return;

  // If the user enables Reduce Motion mid-session, stop the animation
  // loop and reset everything back to its at-rest state.
  var rafId = 0;
  var stopped = false;
  function stop() {
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
    if (far) { far.style.transform = ''; far.style.willChange = ''; }
    if (near) { near.style.transform = ''; near.style.willChange = ''; }
    if (orbit) {
      orbit.style.removeProperty('--parallax-x');
      orbit.style.removeProperty('--parallax-y');
      orbit.style.opacity = '';
      orbit.style.willChange = '';
    }
  }
  if (typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', function (e) { if (e.matches) stop(); });
  } else if (typeof motionQuery.addListener === 'function') {
    motionQuery.addListener(function (e) { if (e.matches) stop(); });
  }

  // Page-Y of the hero-mock's bottom edge. Used to fade the orbit
  // from opacity 1 (page top) to opacity 0 (hero-mock fully past
  // viewport top). Recomputed on resize since the hero-mock height
  // depends on viewport width.
  var heroFadeRange = 0;
  function recalcHeroFade() {
    if (!heroMock) return;
    var rect = heroMock.getBoundingClientRect();
    heroFadeRange = Math.max(1, rect.bottom + window.scrollY);
  }
  recalcHeroFade();
  window.addEventListener('resize', recalcHeroFade, { passive: true });
  window.addEventListener('load', recalcHeroFade, { passive: true });

  // Mouse-parallax: max shift in px when cursor is at a viewport edge.
  var FAR_MAX = 10;
  var NEAR_MAX = 24;
  // Orbit sits between stars and content depth-wise.
  var ORBIT_MOUSE_X = 18;
  var ORBIT_MOUSE_Y = 12;
  // Orbit lags the document scroll by this fraction (0 = moves with page,
  // 1 = stays fixed). Higher = deeper in the background.
  var ORBIT_SCROLL_RATE = 0.6;
  // Lerp factor per frame for the eased cursor follow.
  var EASE = 0.08;

  // Ambient drift: amplitudes (px) and periods (sec) per axis/layer.
  // Different periods on each axis avoid a perceived loop.
  var FAR_AMP_X = 30, FAR_PERIOD_X = 90;
  var FAR_AMP_Y = 24, FAR_PERIOD_Y = 60;
  var NEAR_AMP_X = 50, NEAR_PERIOD_X = 60;
  var NEAR_AMP_Y = 40, NEAR_PERIOD_Y = 45;

  var tx = 0, ty = 0;   // normalised cursor (-1..1) from viewport centre
  var cx = 0, cy = 0;   // eased cursor

  if (far) far.style.willChange = 'transform';
  if (near) near.style.willChange = 'transform';
  if (orbit) orbit.style.willChange = 'transform';

  window.addEventListener('mousemove', function (e) {
    var w = window.innerWidth || 1;
    var h = window.innerHeight || 1;
    tx = (e.clientX / w) * 2 - 1;
    ty = (e.clientY / h) * 2 - 1;
  }, { passive: true });

  var T0 = performance.now();
  var TAU = Math.PI * 2;

  function tick(now) {
    if (stopped) return;
    var t = (now - T0) / 1000;
    cx += (tx - cx) * EASE;
    cy += (ty - cy) * EASE;

    var driftFarX = Math.sin(t * TAU / FAR_PERIOD_X) * FAR_AMP_X;
    var driftFarY = Math.sin(t * TAU / FAR_PERIOD_Y) * FAR_AMP_Y;
    var driftNearX = Math.sin(t * TAU / NEAR_PERIOD_X) * NEAR_AMP_X;
    var driftNearY = Math.sin(t * TAU / NEAR_PERIOD_Y) * NEAR_AMP_Y;

    var fx = (-cx * FAR_MAX + driftFarX).toFixed(2);
    var fy = (-cy * FAR_MAX + driftFarY).toFixed(2);
    var nx = (-cx * NEAR_MAX + driftNearX).toFixed(2);
    var ny = (-cy * NEAR_MAX + driftNearY).toFixed(2);

    if (far) far.style.transform = 'translate3d(' + fx + 'px,' + fy + 'px,0)';
    if (near) near.style.transform = 'translate3d(' + nx + 'px,' + ny + 'px,0)';

    if (orbit) {
      // Orbit transform composes via CSS vars so it doesn't clobber the
      // inline translateX(-50%) centering on the SVG.
      var scrollY = window.scrollY;
      var ox = (-cx * ORBIT_MOUSE_X).toFixed(2);
      var oy = (-cy * ORBIT_MOUSE_Y + scrollY * ORBIT_SCROLL_RATE).toFixed(2);
      orbit.style.setProperty('--parallax-x', ox + 'px');
      orbit.style.setProperty('--parallax-y', oy + 'px');
      // Fade out as the hero-mock scrolls past viewport top.
      var op = heroMock ? Math.max(0, 1 - scrollY / heroFadeRange) : 1;
      orbit.style.opacity = op.toFixed(3);
    }

    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);
})();
