// Star field motion. Two effects layered together:
//   1. Mouse parallax — cursor away from centre shifts the layers,
//      opposite to the cursor; near layer shifts more than far.
//   2. Ambient drift — slow sinusoidal sway on each axis, different
//      periods per layer so the motion never visibly repeats.
// Skipped under prefers-reduced-motion and on touch-only devices.
(function () {
  if (!window.matchMedia) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  var far = document.querySelector('.stars-far');
  var near = document.querySelector('.stars-near');
  if (!far && !near) return;

  // Mouse-parallax: max shift in px when cursor is at a viewport edge.
  var FAR_MAX = 10;
  var NEAR_MAX = 24;
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

  window.addEventListener('mousemove', function (e) {
    var w = window.innerWidth || 1;
    var h = window.innerHeight || 1;
    tx = (e.clientX / w) * 2 - 1;
    ty = (e.clientY / h) * 2 - 1;
  }, { passive: true });

  var T0 = performance.now();
  var TAU = Math.PI * 2;

  function tick(now) {
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

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
