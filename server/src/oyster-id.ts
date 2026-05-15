// Portable source identity. Reads/writes <root>/.oyster/id, the single
// file that gives Oyster a cross-machine identifier for a source folder.
// See docs/superpowers/specs/2026-05-15-oyster-id-portable-identity-design.md
// for the design rationale, invariants, and error-handling matrix.

import { readFileSync, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Matches the canonical lowercase UUID shape (8-4-4-4-12 hex). Note that
// Oyster *writes* UUIDv4 (via crypto.randomUUID()) but this regex accepts any
// canonical-shape UUID so that .oyster/id files written by future Oyster
// versions or other tools (e.g. UUIDv7) are still accepted.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OYSTER_DIR = ".oyster";
const ID_FILE = "id";

export function isValidUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

export type OysterIdReadResult =
  | { status: "valid"; id: string }
  | { status: "missing" }
  | { status: "malformed"; value?: string }
  | { status: "unreadable"; error: unknown }
  | { status: "blocked"; reason: ".oyster-is-file" };

export function readOysterId(root: string): OysterIdReadResult {
  const oysterPath = join(root, OYSTER_DIR);
  const idPath = join(oysterPath, ID_FILE);

  // Cheap stat: is .oyster a directory? If it doesn't exist at all, we
  // return "missing"; if it exists but is a file, we return "blocked"
  // (handled below).
  let oysterStat;
  try {
    oysterStat = statSync(oysterPath);
  } catch (err) {
    // ENOENT → no .oyster anything. Any other error treat as missing too;
    // the caller's retry path is the same.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "unreadable", error: err };
  }

  if (!oysterStat.isDirectory()) {
    // `.oyster` exists but isn't a directory — bail with blocked.
    return { status: "blocked", reason: ".oyster-is-file" };
  }

  let raw: string;
  try {
    raw = readFileSync(idPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "unreadable", error: err };
  }

  const trimmed = raw.trim();
  if (isValidUuid(trimmed)) {
    return { status: "valid", id: trimmed };
  }
  return { status: "malformed", value: trimmed };
}

export function writeOysterId(root: string, id: string): void {
  if (!isValidUuid(id)) {
    // Defensive: callers shouldn't pass garbage but if they do we
    // refuse rather than write invalid disk state.
    throw new Error(`writeOysterId: refusing to write non-UUID value: ${id}`);
  }
  const oysterPath = join(root, OYSTER_DIR);
  mkdirSync(oysterPath, { recursive: true });

  const tmpPath = join(oysterPath, `id.tmp-${process.pid}-${Date.now()}`);
  const finalPath = join(oysterPath, ID_FILE);
  writeFileSync(tmpPath, id + "\n", "utf8");
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    // Best-effort tmpfile cleanup; suppress secondary errors since we're
    // already throwing the primary rename failure to the caller.
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}
