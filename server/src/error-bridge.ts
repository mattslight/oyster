// server/src/error-bridge.ts
// Exports the error bridge script and an injection function.

// Thin dark scrollbars so Windows artifact iframes don't show the chunky
// native Win32 bar. Chromium (all platforms) honours scrollbar-color; the
// ::-webkit-scrollbar rules keep older WebViews consistent.
const SCROLLBAR_STYLE = `<style data-oyster-scrollbar>
* { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 4px; }
*::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
</style>`;

const BRIDGE_SCRIPT = SCROLLBAR_STYLE + `<script data-oyster-bridge>
(function() {
  if (window.__oysterBridge) return;
  window.__oysterBridge = true;

  var MAX_ENTRIES = 20;
  var MAX_CHARS = 500;
  var fired = false;
  var buffer = [];

  function safeStr(val) {
    if (val === undefined) return 'undefined';
    if (val === null) return 'null';
    try {
      var s = typeof val === 'string' ? val : JSON.stringify(val);
      return s && s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + '...' : (s || String(val));
    } catch (e) {
      return String(val);
    }
  }

  function pushEntry(type, args) {
    var msg = Array.prototype.map.call(args, safeStr).join(' ');
    buffer.push({ type: type, message: msg, ts: Date.now() });
    if (buffer.length > MAX_ENTRIES) buffer.shift();
  }

  var origLog = console.log, origWarn = console.warn, origError = console.error;
  console.log = function() { pushEntry('log', arguments); origLog.apply(console, arguments); };
  console.warn = function() { pushEntry('warn', arguments); origWarn.apply(console, arguments); };
  console.error = function() { pushEntry('error', arguments); origError.apply(console, arguments); };

  function sendError(message, stack) {
    if (fired) return;
    fired = true;
    var payload = JSON.stringify(buffer);
    if (payload.length > 5120) {
      buffer = buffer.slice(-10);
      payload = JSON.stringify(buffer);
    }
    try {
      window.parent.postMessage({
        type: 'oyster-error',
        artifactPath: window.location.pathname,
        error: { message: String(message), stack: String(stack || '') },
        console: buffer
      }, window.location.origin);
    } catch (e) {}
  }

  window.addEventListener('error', function(e) {
    sendError(e.message, e.error && e.error.stack ? e.error.stack : e.filename + ':' + e.lineno + ':' + e.colno);
  });

  window.addEventListener('unhandledrejection', function(e) {
    var reason = e.reason;
    if (reason instanceof Error) {
      sendError(reason.message, reason.stack);
    } else {
      sendError(String(reason), '');
    }
  });
})();
</script>`;

/**
 * Inject the error bridge script into an HTML string.
 * Injection order: after <head>, after <html>, after <!doctype>, or prepend.
 */
export function injectBridge(html: string): string {
  // After <head> (case-insensitive)
  const headMatch = html.match(/<head(\s[^>]*)?>/i);
  if (headMatch) {
    const idx = headMatch.index! + headMatch[0].length;
    return html.slice(0, idx) + BRIDGE_SCRIPT + html.slice(idx);
  }

  // After <html>
  const htmlMatch = html.match(/<html(\s[^>]*)?>/i);
  if (htmlMatch) {
    const idx = htmlMatch.index! + htmlMatch[0].length;
    return html.slice(0, idx) + BRIDGE_SCRIPT + html.slice(idx);
  }

  // After <!doctype>
  const doctypeMatch = html.match(/<!doctype\s[^>]*>/i);
  if (doctypeMatch) {
    const idx = doctypeMatch.index! + doctypeMatch[0].length;
    return html.slice(0, idx) + BRIDGE_SCRIPT + html.slice(idx);
  }

  // Bare fragment — prepend
  return BRIDGE_SCRIPT + html;
}
