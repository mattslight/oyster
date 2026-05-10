// encryption.ts — per-user AES-GCM for session jsonl bytes (#322).
//
// HKDF (SHA-256) derives an AES-256 key from a master secret + per-user salt.
// A leak of one user's derived key cannot decrypt another user's bytes.
// A leak of the master secret without the user id list still requires
// re-deriving each user's key separately.
//
// Wire format on R2: 12-byte IV || ciphertext+tag. The IV is random per
// encryption — never reused with the same key (AES-GCM nonce-reuse breaks
// confidentiality and integrity). 12 bytes is the standard AES-GCM IV size.

const HKDF_INFO = new TextEncoder().encode("oyster-session-bytes-v1");
const IV_LENGTH = 12;

async function deriveKey(masterSecret: string, userId: string): Promise<CryptoKey> {
  const ikm = new TextEncoder().encode(masterSecret);
  const salt = new TextEncoder().encode(userId);
  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: HKDF_INFO },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptForUser(
  masterSecret: string,
  userId: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await deriveKey(masterSecret, userId);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_LENGTH);
  return out;
}

export async function decryptForUser(
  masterSecret: string,
  userId: string,
  blob: Uint8Array,
): Promise<Uint8Array> {
  if (blob.byteLength < IV_LENGTH + 16 /* AES-GCM tag */) {
    throw new Error("ciphertext too short");
  }
  const key = await deriveKey(masterSecret, userId);
  const iv = blob.subarray(0, IV_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new Uint8Array(plaintext);
}
