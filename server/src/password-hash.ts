// PBKDF2-SHA256 password hashing for R5 publish password mode (#315 spec).
// Format: pbkdf2$<iter>$<salt_b64url>$<hash_b64url>
// The viewer (in oyster-publish Worker) verifies the hash via Web Crypto's
// subtle.deriveBits with PBKDF2 — same parameters, same encoding.

import { pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length === 0) throw new Error("password_required");
  const salt = randomBytes(SALT_BYTES);
  const hash = await pbkdf2Async(plaintext, salt, ITERATIONS, HASH_BYTES, "sha256");
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}
