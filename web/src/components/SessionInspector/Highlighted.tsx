// Highlighted — extracted from SessionInspector for navigability.
/** Renders text with case-insensitive substring matches wrapped in
 *  <mark> spans. Used by the in-transcript find-box (#332) to make the
 *  match visible inline, not just as a turn-level flash. */
export function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: Array<{ text: string; mark: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const found = lower.indexOf(q, i);
    if (found === -1) {
      parts.push({ text: text.slice(i), mark: false });
      break;
    }
    if (found > i) parts.push({ text: text.slice(i, found), mark: false });
    parts.push({ text: text.slice(found, found + q.length), mark: true });
    i = found + q.length;
  }
  return (
    <>
      {parts.map((p, idx) => p.mark
        ? <mark key={idx} className="turn-text-match">{p.text}</mark>
        : <span key={idx}>{p.text}</span>)}
    </>
  );
}
