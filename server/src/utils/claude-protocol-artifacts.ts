// Claude Code wraps slash-command machinery in pseudo-user messages — e.g.
// `<command-name>/exit</command-name>`, `<local-command-stdout>Goodbye!`,
// `<system-reminder>The user named this session "…"</system-reminder>`. They
// were never typed by the user and were never said by the assistant; they're
// protocol artefacts. We classify them at ingest so the transcript reader and
// search index can ignore them while the raw rows stay on disk.
//
// Match is intentionally prefix-only: a real message that happens to *contain*
// these strings (e.g. someone pasting a snippet about slash-commands) should
// still render. Only events whose leading non-whitespace token is one of these
// wrappers get classified out.
//
// Caller is expected to gate this on `role === "user"`. Assistant messages can
// legitimately echo a slash command (`/rename ...`) and we want those visible.
export function isClaudeProtocolArtifact(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<local-command-")
    || trimmed.startsWith("<command-")
    || trimmed.startsWith("<system-reminder>")
  );
}
