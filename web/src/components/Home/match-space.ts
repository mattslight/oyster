// Score a folder basename against a list of candidate spaces and return the
// best match (or null). Used by AttachOrphanPopover to suggest "Best match"
// when an Unsorted folder name resembles an existing space.
//
// Scoring (per folder token, take the best across all space tokens):
//   1.0  exact equal
//   0.5  one is a substring of the other
//   0    neither
// Sum across folder tokens. Return the highest-scoring space with score >= 1.
// Tie-break: shorter displayName, then alphabetical, so the result is stable.
//
// Caller is responsible for excluding meta spaces (home, __all__, __archived__).

export interface MatchCandidate {
  id: string;
  displayName: string;
}

function tokenise(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function bestMatchSpace<T extends MatchCandidate>(
  folderBasename: string,
  candidates: readonly T[],
): T | null {
  const folderTokens = tokenise(folderBasename);
  if (folderTokens.length === 0 || candidates.length === 0) return null;

  let best: { space: T; score: number } | null = null;
  for (const space of candidates) {
    const spaceTokens = tokenise(space.displayName);
    if (spaceTokens.length === 0) continue;
    let score = 0;
    for (const ft of folderTokens) {
      let bestForToken = 0;
      for (const st of spaceTokens) {
        if (ft === st) { bestForToken = 1; break; }
        if (ft.includes(st) || st.includes(ft)) bestForToken = Math.max(bestForToken, 0.5);
      }
      score += bestForToken;
    }
    if (score < 1) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && space.displayName.length < best.space.displayName.length) ||
      (score === best.score && space.displayName.length === best.space.displayName.length && space.displayName < best.space.displayName)
    ) {
      best = { space, score };
    }
  }
  return best?.space ?? null;
}
