import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createProfileBindingService } from "../src/profile-binding-service.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE profile_binding (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cloud_owner_id TEXT NOT NULL,
      bound_at INTEGER NOT NULL
    )
  `);
  return db;
}

describe("ProfileBindingService", () => {
  it("getBoundOwner returns null on a fresh profile", () => {
    const svc = createProfileBindingService({ db: freshDb() });
    expect(svc.getBoundOwner()).toBeNull();
  });

  it("bindToOwner binds a fresh profile and reports `bound`", () => {
    const svc = createProfileBindingService({ db: freshDb() });
    expect(svc.bindToOwner("user-A")).toEqual({ bound: true, reason: "bound" });
    expect(svc.getBoundOwner()).toBe("user-A");
  });

  it("bindToOwner is idempotent for the same owner", () => {
    const svc = createProfileBindingService({ db: freshDb() });
    svc.bindToOwner("user-A");
    expect(svc.bindToOwner("user-A")).toEqual({ bound: true, reason: "already_matches" });
  });

  it("bindToOwner refuses a different owner — reports `conflict`", () => {
    const svc = createProfileBindingService({ db: freshDb() });
    svc.bindToOwner("user-A");
    expect(svc.bindToOwner("user-B")).toEqual({ bound: false, reason: "conflict" });
    expect(svc.getBoundOwner()).toBe("user-A");
  });

  it("isOwnedBy returns true when binding is null OR matches", () => {
    const svc = createProfileBindingService({ db: freshDb() });
    expect(svc.isOwnedBy("user-A")).toBe(true);
    svc.bindToOwner("user-A");
    expect(svc.isOwnedBy("user-A")).toBe(true);
    expect(svc.isOwnedBy("user-B")).toBe(false);
  });

  it("isOwnedBy returns false for null user when bound", () => {
    const svc = createProfileBindingService({ db: freshDb() });
    svc.bindToOwner("user-A");
    expect(svc.isOwnedBy(null)).toBe(false);
  });
});
