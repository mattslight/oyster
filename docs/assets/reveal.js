// Reveal-on-scroll. The head script on each page adds `js-reveal` to
// <html> only when prefers-reduced-motion is not set, so this no-ops
// for users who opt out of motion.
(function () {
  if (!document.documentElement.classList.contains('js-reveal')) return;
  if (!('IntersectionObserver' in window)) return;

  var targets = document.querySelectorAll('[data-reveal]');
  if (!targets.length) return;

  var obs = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        obs.unobserve(entry.target);
      }
    }
  }, { threshold: 0, rootMargin: '0px 0px -25% 0px' });

  targets.forEach(function (el) { obs.observe(el); });
})();
