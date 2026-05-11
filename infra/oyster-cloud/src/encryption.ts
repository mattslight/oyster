// encryption.ts — per-user AES-GCM for session jsonl chunks (#322).
//
// HKDF (SHA-256) derives an AES-256 key from a master secret + per-user salt.
// A leak of one user's derived key cannot decrypt another user's bytes.
// A leak of the master secret without the user id list still requires
// re-deriving each user's key separately.
//
// Each chunk's ciphertext is bound to its identifying metadata via AES-GCM's
// Additional Authenticated Data (AAD). AAD doesn't change ciphertext length
// but decrypt fails if any AAD field differs from what was bound at encrypt.
// This makes chunks non-substitutable: a chunk's ciphertext from session A,
// chunk 3, generation 0 cannot be served as session B / chunk 7 / generation 1.
//
// Wire format on R2: 12-byte IV || ciphertext+tag. The IV is random per
// encryption — never reused with the same key (AES-GCM nonce-reuse breaks
// confidentiality and integrity). 12 bytes is the standard AES-GCM IV size.

const HKDF_INFO = new TextEncoder().encode("oyster-session-bytes-v1");
const IV_LENGTH = 12;

/** Fields bound into a chunk's ciphertext via AES-GCM AAD. Any change to
 *  any field invalidates the chunk on decrypt. Keep field names + order
 *  stable forever — they're part of the on-disk format. */
export interface ChunkAad {
  owner_id: string;
  session_id: string;
  bytes_generation: number;
  chunk_number: number;
  start_offset: number;
  end_offset: number;
  plaintext_sha256: string;
}

/** Canonical AAD serialisation. Field order is fixed so encrypt and decrypt
 *  produce byte-identical inputs to AES-GCM regardless of JSON.stringify
 *  key-order quirks. */
function serialiseAad(aad: ChunkAad): Uint8Array {
  const canonical = JSON.stringify({
    owner_id: aad.owner_id,
    session_id: aad.session_id,
    bytes_generation: aad.bytes_generation,
    chunk_number: aad.chunk_number,
    start_offset: aad.start_offset,
    end_offset: aad.end_offset,
    plaintext_sha256: aad.plaintext_sha256,
  });
  return new TextEncoder().encode(canonical);
}

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

export async function encryptChunk(
  masterSecret: string,
  aad: ChunkAad,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await deriveKey(masterSecret, aad.owner_id);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const additionalData = serialiseAad(aad);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    plaintext,
  );
  const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), IV_LENGTH);
  return out;
}

export async function decryptChunk(
  masterSecret: string,
  aad: ChunkAad,
  blob: Uint8Array,
): Promise<Uint8Array> {
  if (blob.byteLength < IV_LENGTH + 16 /* AES-GCM tag */) {
    throw new Error("ciphertext too short");
  }
  const key = await deriveKey(masterSecret, aad.owner_id);
  const iv = blob.subarray(0, IV_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH);
  const additionalData = serialiseAad(aad);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}

/** Hex-encoded SHA-256 of plaintext bytes. Used as the chunk's content hash
 *  for the manifest, for AAD binding, and for Device B verification. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}
