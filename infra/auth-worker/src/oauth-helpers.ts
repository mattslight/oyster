// Pure helpers for the OAuth flow. Kept separate from worker.ts so the
// unit tests can import them without dragging in the Env interface or
// the fetch handler.

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// 32 random bytes → 43 base64url characters. Matches RFC 7636's
// recommended length for high-entropy verifiers.
export function pkceVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

// SHA-256 of the verifier, base64url-encoded. Must match the verifier
// GitHub will receive at token exchange — any divergence (padding,
// alphabet) means GitHub rejects the call.
export async function codeChallengeS256(verifier: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(buf));
}
