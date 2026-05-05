// Minimal, chrome-less pages for intermediary states.
// Spec: docs/superpowers/specs/2026-05-03-r5-viewer-design.md (Minimal pages).
// Each function returns an HTML string. Wrap in basePage() for consistency.

export interface PageOpts {
  // If true, the response also gets an `Accept: application/json` JSON body
  // variant with the same { error, message } shape — set by the caller.
  jsonError?: { code: string; message: string };
}

export function passwordGatePage(shareToken: string, opts?: { error?: "wrong_password" }): string {
  const errorBlock = opts?.error === "wrong_password"
    ? `<p class="err">Incorrect password.</p>`
    : "";
  return basePage("Password required", `
    <div class="icon">🔒</div>
    <h1>Password required</h1>
    <p class="hint">This share is password-protected.</p>
    ${errorBlock}
    <form method="POST" action="/p/${escapeHtml(shareToken)}">
      <input type="password" name="password" placeholder="Password" autofocus required>
      <button type="submit">Unlock</button>
    </form>
  `);
}

export function gonePage(): string {
  return basePage("Share removed", `
    <div class="icon">🚫</div>
    <h1>This share has been removed</h1>
    <p class="hint">The owner has unpublished this artefact.</p>
  `);
}

export function notFoundPage(): string {
  return basePage("Not found", `
    <div class="icon">❓</div>
    <h1>Share not found</h1>
    <p class="hint">The link may have been mistyped or removed.</p>
  `);
}

export function internalErrorPage(): string {
  return basePage("Error", `
    <div class="icon">⚠️</div>
    <h1>Something went wrong</h1>
    <p class="hint">Try again in a moment.</p>
  `);
}

export function rateLimitedPage(): string {
  return basePage("Too many attempts", `
    <div class="icon">⏱️</div>
    <h1>Too many attempts</h1>
    <p class="hint">Wait a minute and try again.</p>
  `);
}

function basePage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/png" href="https://oyster.to/logo.png">
<link rel="apple-touch-icon" href="https://oyster.to/logo.png">
<style>
  :root { color-scheme: light dark; --fg: #111; --muted: #666; --bd: #d4d4d8; --bg: #fff; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f4f4f5; --muted: #a1a1aa; --bd: #3f3f46; --bg: #18181b; } }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 24rem; margin: 6rem auto; padding: 0 1.5rem; line-height: 1.5; color: var(--fg); background: var(--bg); text-align: center; }
  .icon { font-size: 1.6rem; margin-bottom: 0.6rem; opacity: 0.9; }
  h1 { font-size: 1.2rem; margin: 0 0 0.5rem; font-weight: 600; }
  .hint { font-size: 0.95rem; color: var(--muted); margin: 0 0 1.5rem; }
  .err { font-size: 0.85rem; color: #c62828; margin: 0 0 0.75rem; }
  form { display: flex; flex-direction: column; gap: 0.6rem; max-width: 14rem; margin: 0 auto; }
  input[type=password] { padding: 0.55rem 0.7rem; font-size: 0.95rem; border: 1px solid var(--bd); border-radius: 0.35rem; background: transparent; color: inherit; text-align: center; }
  button { padding: 0.55rem 0.7rem; font-size: 0.95rem; font-weight: 500; border: 0; border-radius: 0.35rem; background: var(--fg); color: var(--bg); cursor: pointer; }
  .tag { font-size: 0.7rem; color: var(--muted); margin-top: 4rem; opacity: 0.6; }
</style>
</head><body>
${bodyHtml}
<p class="tag">Shared via Oyster</p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}
