// Claude Code wraps slash-command machinery in two shapes:
//
//   1. Pseudo-`user` messages — `<command-name>/exit</command-name>`,
//      `<local-command-stdout>Goodbye!`, `<system-reminder>The user named
//      this session "…"</system-reminder>`.
//   2. `system` events with `subtype = "local_command"` — renderEvent
//      stringifies these as `local_command: <command-name>…` (the wrapper
//      tag is no longer the leading token, so the prefix checks above miss
//      them). See #536.
//
// They were never typed by the user and were never said by the assistant;
// they're protocol artefacts. We classify them at ingest so the transcript
// reader and search index can ignore them while the raw rows stay on disk.
//
// Match is intentionally prefix-only: a real message that happens to *contain*
// these strings (e.g. someone pasting a snippet about slash-commands) should
// still render. Only events whose leading non-whitespace token is one of these
// wrappers, or whose text begins with the `local_command:` subtype label,
// get classified out.
//
// Assistant messages can legitimately echo a slash command (`/rename ...`).
// Those start with `/`, never match any of the prefixes below, and stay
// visible regardless of the caller's role gate.
export function isClaudeProtocolArtifact(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<local-command-")
    || trimmed.startsWith("<command-")
    || trimmed.startsWith("<system-reminder>")
    || trimmed.startsWith("local_command:")
  );
}
