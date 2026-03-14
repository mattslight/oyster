// server/src/error-bridge.ts
// Exports the error bridge script and an injection function.

const BRIDGE_SCRIPT = `<script data-oyster-bridge>
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

  window.onerror = function(msg, src, line, col, err) {
    sendError(msg, err && err.stack ? err.stack : src + ':' + line + ':' + col);
  };

  window.onunhandledrejection = function(e) {
    var reason = e.reason;
    if (reason instanceof Error) {
      sendError(reason.message, reason.stack);
    } else {
      sendError(String(reason), '');
    }
  };
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
