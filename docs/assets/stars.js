// Generates the star field for the two layers (.stars-far, .stars-near).
// Per-star brightness uses a power curve so most stars are at the edge
// of visibility with a handful of brighter standouts — that's what gives
// a real night sky its depth.
(function () {
  function seed(s) {
    return function () {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
  }
  var rand = seed(42);

  function makeStars(el, count, opts) {
    if (!el) return;
    var bright = opts && opts.twinkle;
    var minOp = bright ? 0.05 : 0.015;
    var maxOp = bright ? 0.62 : 0.30;
    var skew = bright ? 2.2 : 3.4;
    var sizeBase = bright ? 0.9 : 0.7;
    var sizeJitter = bright ? 1.6 : 1.0;
    // Fraction of stars that twinkle — both layers, less on far.
    var twinkleRate = bright ? 0.30 : 0.10;

    var frag = document.createDocumentFragment();
    for (var i = 0; i < count; i++) {
      var d = document.createElement('div');
      d.style.left = (rand() * 100).toFixed(2) + '%';
      d.style.top = (rand() * 100).toFixed(2) + '%';
      var op = minOp + Math.pow(rand(), skew) * (maxOp - minOp);
      d.style.opacity = op.toFixed(3);
      var size = (sizeBase + rand() * sizeJitter).toFixed(2) + 'px';
      d.style.width = size;
      d.style.height = size;
      if (rand() < twinkleRate) {
        d.classList.add('star-twinkle');
        // Trough fraction varies wildly so some stars flicker, some
        // fade subtly. CSS keyframe reads --peak/--trough.
        var troughFrac = 0.05 + rand() * 0.6;
        d.style.setProperty('--peak', op.toFixed(3));
        d.style.setProperty('--trough', (op * troughFrac).toFixed(3));
        d.style.setProperty('--dur', (1.5 + rand() * 6).toFixed(2) + 's');
        d.style.setProperty('--delay', (rand() * 8).toFixed(2) + 's');
      }
      frag.appendChild(d);
    }
    el.appendChild(frag);
  }

  var far = document.getElementById('stars-far');
  var near = document.getElementById('stars-near');
  if (far) makeStars(far, 1500, { twinkle: false });
  if (near) makeStars(near, 260, { twinkle: true });
})();
