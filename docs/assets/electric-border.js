// Electric border — vanilla port of @react-bits/ElectricBorder.
// Inspired by @BalintFerenczy on X — https://codepen.io/BalintFerenczy/pen/KwdoyEN
//
// Usage: any element with class="electric-border" and the inner DOM:
//   <div class="electric-border" data-eb-color="#7df9ff" data-eb-speed="0.5" data-eb-chaos="0.04" data-eb-radius="20">
//     <div class="eb-canvas-container"><canvas class="eb-canvas"></canvas></div>
//     <div class="eb-layers">
//       <div class="eb-glow-1"></div><div class="eb-glow-2"></div><div class="eb-background-glow"></div>
//     </div>
//     <div class="eb-content"><!-- your content --></div>
//   </div>

(function () {
  const OCTAVES = 10;
  const LACUNARITY = 1.6;
  const GAIN = 0.7;
  const FREQUENCY = 10;
  const BASE_FLATNESS = 0;
  const DISPLACEMENT = 60;
  const BORDER_OFFSET = 60;

  function random(x) {
    return (Math.sin(x * 12.9898) * 43758.5453) % 1;
  }

  function noise2D(x, y) {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const a = random(i + j * 57);
    const b = random(i + 1 + j * 57);
    const c = random(i + (j + 1) * 57);
    const d = random(i + 1 + (j + 1) * 57);
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
  }

  function octavedNoise(x, baseAmplitude, time, seed) {
    let y = 0;
    let amp = baseAmplitude;
    let freq = FREQUENCY;
    for (let i = 0; i < OCTAVES; i++) {
      let octAmp = amp;
      if (i === 0) octAmp *= BASE_FLATNESS;
      y += octAmp * noise2D(freq * x + seed * 100, time * freq * 0.3);
      freq *= LACUNARITY;
      amp *= GAIN;
    }
    return y;
  }

  function corner(cx, cy, r, startAngle, arcLength, progress) {
    const a = startAngle + progress * arcLength;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }

  function roundedRectPoint(t, left, top, w, h, r) {
    const sw = w - 2 * r;
    const sh = h - 2 * r;
    const arc = (Math.PI * r) / 2;
    const total = 2 * sw + 2 * sh + 4 * arc;
    const d = t * total;
    let acc = 0;

    if (d <= acc + sw) return { x: left + r + ((d - acc) / sw) * sw, y: top };
    acc += sw;
    if (d <= acc + arc) return corner(left + w - r, top + r, r, -Math.PI / 2, Math.PI / 2, (d - acc) / arc);
    acc += arc;
    if (d <= acc + sh) return { x: left + w, y: top + r + ((d - acc) / sh) * sh };
    acc += sh;
    if (d <= acc + arc) return corner(left + w - r, top + h - r, r, 0, Math.PI / 2, (d - acc) / arc);
    acc += arc;
    if (d <= acc + sw) return { x: left + w - r - ((d - acc) / sw) * sw, y: top + h };
    acc += sw;
    if (d <= acc + arc) return corner(left + r, top + h - r, r, Math.PI / 2, Math.PI / 2, (d - acc) / arc);
    acc += arc;
    if (d <= acc + sh) return { x: left, y: top + h - r - ((d - acc) / sh) * sh };
    acc += sh;
    return corner(left + r, top + r, r, Math.PI, Math.PI / 2, (d - acc) / arc);
  }

  function setup(container) {
    const canvas = container.querySelector('.eb-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const color = container.dataset.ebColor || '#5227FF';
    const speed = parseFloat(container.dataset.ebSpeed || '1');
    const chaos = parseFloat(container.dataset.ebChaos || '0.12');
    const borderRadius = parseFloat(container.dataset.ebRadius || '16');

    container.style.setProperty('--electric-border-color', color);
    if (!container.style.borderRadius) {
      container.style.borderRadius = borderRadius + 'px';
    }

    let width = 0, height = 0;
    let time = 0, lastFrame = 0, raf = 0;

    function updateSize() {
      const rect = container.getBoundingClientRect();
      width = rect.width + BORDER_OFFSET * 2;
      height = rect.height + BORDER_OFFSET * 2;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    }

    function frame(now) {
      if (!lastFrame) lastFrame = now;
      const dt = (now - lastFrame) / 1000;
      time += dt * speed;
      lastFrame = now;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const left = BORDER_OFFSET;
      const top = BORDER_OFFSET;
      const bw = width - 2 * BORDER_OFFSET;
      const bh = height - 2 * BORDER_OFFSET;
      const maxR = Math.min(bw, bh) / 2;
      const r = Math.min(borderRadius, maxR);
      const perim = 2 * (bw + bh) + 2 * Math.PI * r;
      const samples = Math.floor(perim / 2);

      ctx.beginPath();
      for (let i = 0; i <= samples; i++) {
        const p = i / samples;
        const pt = roundedRectPoint(p, left, top, bw, bh, r);
        const xn = octavedNoise(p * 8, chaos, time, 0);
        const yn = octavedNoise(p * 8, chaos, time, 1);
        const dx = pt.x + xn * DISPLACEMENT;
        const dy = pt.y + yn * DISPLACEMENT;
        if (i === 0) ctx.moveTo(dx, dy);
        else ctx.lineTo(dx, dy);
      }
      ctx.closePath();
      ctx.stroke();

      raf = requestAnimationFrame(frame);
    }

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(container);
    raf = requestAnimationFrame(frame);
  }

  function init() {
    document.querySelectorAll('.electric-border').forEach(setup);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
