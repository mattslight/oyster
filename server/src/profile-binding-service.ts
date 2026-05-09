// profile-binding-service.ts — one-time binding of the local Oyster profile
// to a single cloud account. Prevents two different Pro users from sharing
// the same local SQLite via cross-device sync. Used by every cloud sync
// service (memory now, spaces and sessions later) before pull or push.

import type Database from "better-sqlite3";

export interface ProfileBindingDeps {
  db: Database.Database;
}

export type BindResult =
  | { bound: true;  reason: "bound" | "already_matches" }
  | { bound: false; reason: "conflict" };

export interface ProfileBindingService {
  /** Returns the cloud_owner_id this profile is bound to, or null if unbound. */
  getBoundOwner(): string | null;
  /** Binds the profile to ownerId on first call. Idempotent for the same
   *  owner. Returns `conflict` (bound=false) if a different owner is already
   *  bound — caller must treat that as a hard block on cloud sync. */
  bindToOwner(ownerId: string): BindResult;
  /** True if userId is non-null AND (the profile is unbound OR bound to userId).
   *  False if userId is null, or if bound to a different user. A null user is
   *  never an owner — sync gates use this to refuse the un-attributable case
   *  cleanly. Use this as the gate in cloud sync services. */
  isOwnedBy(userId: string | null): boolean;
}

export function createProfileBindingService(deps: ProfileBindingDeps): ProfileBindingService {
  const getStmt = deps.db.prepare(
    `SELECT cloud_owner_id FROM profile_binding WHERE id = 1`,
  );
  const insertStmt = deps.db.prepare(
    `INSERT INTO profile_binding (id, cloud_owner_id, bound_at) VALUES (1, ?, ?)`,
  );

  function getBoundOwner(): string | null {
    const row = getStmt.get() as { cloud_owner_id: string } | undefined;
    return row?.cloud_owner_id ?? null;
  }

  function bindToOwner(ownerId: string): BindResult {
    const existing = getBoundOwner();
    if (existing === ownerId) return { bound: true, reason: "already_matches" };
    if (existing !== null)    return { bound: false, reason: "conflict" };
    insertStmt.run(ownerId, Date.now());
    return { bound: true, reason: "bound" };
  }

  function isOwnedBy(userId: string | null): boolean {
    if (userId === null) return false;
    const owner = getBoundOwner();
    return owner === null || owner === userId;
  }

  return { getBoundOwner, bindToOwner, isOwnedBy };
}
