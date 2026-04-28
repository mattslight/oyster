// SQLite's `datetime('now')` produces `YYYY-MM-DD HH:MM:SS` (no T, no Z).
// Some browsers (Safari historically, plus older WebKit-based ones) reject
// that form in `Date.parse`, returning NaN. Many of our timestamps come from
// SQLite defaults and we can't normalise every column server-side without a
// data migration, so the parser tolerates both shapes:
//
//   "2026-04-28 17:25:22"          → space-separated, no zone
//   "2026-04-28T17:25:22.123Z"     → ISO with zone
//
// Returns NaN for anything else.
export function parseTimestamp(input: string | null | undefined): number {
  if (!input) return NaN;
  const direct = Date.parse(input);
  if (Number.isFinite(direct)) return direct;
  // Rewrite `YYYY-MM-DD HH:MM:SS[.fff]` → ISO and try again.
  const match = input.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  if (match) {
    return Date.parse(`${match[1]}T${match[2]}Z`);
  }
  return NaN;
}
