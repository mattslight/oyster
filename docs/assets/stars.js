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
    var twinkle = opts && opts.twinkle;
    var minOp = twinkle ? 0.05 : 0.015;
    var maxOp = twinkle ? 0.62 : 0.30;
    var skew = twinkle ? 2.2 : 3.4;
    var sizeBase = twinkle ? 0.9 : 0.7;
    var sizeJitter = twinkle ? 1.6 : 1.0;

    var frag = document.createDocumentFragment();
    for (var i = 0; i < count; i++) {
      var d = document.createElement('div');
      d.style.left = (rand() * 100).toFixed(2) + '%';
      d.style.top = (rand() * 100).toFixed(2) + '%';
      d.style.opacity = (minOp + Math.pow(rand(), skew) * (maxOp - minOp)).toFixed(3);
      var size = (sizeBase + rand() * sizeJitter).toFixed(2) + 'px';
      d.style.width = size;
      d.style.height = size;
      if (twinkle && rand() < 0.15) {
        d.classList.add('star-twinkle');
        d.style.setProperty('--dur', (2.5 + rand() * 4).toFixed(2) + 's');
        d.style.setProperty('--delay', (rand() * 5).toFixed(2) + 's');
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
