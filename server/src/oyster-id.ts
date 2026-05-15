// Portable source identity. Reads/writes <root>/.oyster/id, the single
// file that gives Oyster a cross-machine identifier for a source folder.
// See docs/superpowers/specs/2026-05-15-oyster-id-portable-identity-design.md
// for the design rationale, invariants, and error-handling matrix.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}
