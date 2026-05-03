#!/usr/bin/env node
// Mirror server/package.json's runtime dependencies into the root package.json.
//
// Why: the published `oyster-os` tarball ships `server/dist/` but not `server/
// package.json`, so a global install resolves runtime deps against ROOT
// node_modules. If root and server pins drift, dev/CI tests one combination
// and end-users get a different one. This script enforces a single source of
// truth (server) and lets root stay generated.
//
// Usage:
//   node scripts/sync-published-deps.mjs          rewrites root package.json
//   node scripts/sync-published-deps.mjs --check  exits 1 if a rewrite would change it
//
// Packages already in root's optionalDependencies are skipped (e.g. @lydell/
// node-pty, which is intentionally optional at install time on root).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootPkgPath = path.join(root, "package.json");
const serverPkgPath = path.join(root, "server", "package.json");

const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
const serverPkg = JSON.parse(fs.readFileSync(serverPkgPath, "utf8"));

const serverDeps = serverPkg.dependencies ?? {};
const rootOptional = rootPkg.optionalDependencies ?? {};

const synced = Object.fromEntries(
  Object.entries(serverDeps)
    .filter(([name]) => !(name in rootOptional))
    .sort(([a], [b]) => a.localeCompare(b)),
);

const updated = { ...rootPkg, dependencies: synced };
const before = fs.readFileSync(rootPkgPath, "utf8");
const after = JSON.stringify(updated, null, 2) + "\n";

const checkOnly = process.argv.includes("--check");
if (before === after) {
  console.log("root package.json dependencies already in sync with server.");
  process.exit(0);
}

if (checkOnly) {
  console.error("root package.json dependencies are out of sync with server/package.json.");
  console.error("Run: node scripts/sync-published-deps.mjs");
  process.exit(1);
}

fs.writeFileSync(rootPkgPath, after);
console.log("root package.json dependencies synced from server/package.json.");
