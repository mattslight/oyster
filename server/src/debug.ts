// Opt-in structured debug logging for artifact lifecycle diagnostics.
// Enable with OYSTER_DEBUG=1 (or =artifact to scope to this subsystem).
// Kept intentionally tiny — no dependencies, no levels, no formatter.

const enabled = (() => {
  const v = process.env.OYSTER_DEBUG;
  if (!v) return false;
  if (v === "1" || v.toLowerCase() === "true") return true;
  return v.split(",").map((s) => s.trim()).includes("artifact");
})();

export function debug(scope: string, msg: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.sss
  if (data) {
    console.log(`[${ts}] [${scope}] ${msg}`, JSON.stringify(data));
  } else {
    console.log(`[${ts}] [${scope}] ${msg}`);
  }
}

export const debugEnabled = enabled;
