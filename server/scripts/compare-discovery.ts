/**
 * Chunk 3 validation (PRD: docs/superpowers/specs/2026-04-22-unified-discovery-prd.md).
 *
 * Runs both discovery pipelines against a real container and prints a diff.
 *
 * Usage: cd server && npx tsx scripts/compare-discovery.ts ~/Dev
 */

import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  isContainer,
  discoverCandidates,
  groupWithLLM,
  discoverAllSubfolders,
  groupWithLLMRich,
} from "../src/discovery.js";

const rawPath = process.argv[2] ?? "~/Dev";
const path = rawPath.startsWith("~/")
  ? resolve(join(homedir(), rawPath.slice(2)))
  : resolve(rawPath);

function hdr(s: string) {
  const bar = "─".repeat(Math.max(16, 72 - s.length));
  console.log(`\n── ${s} ${bar}`);
}

async function main() {
  console.log(`Comparing discovery pipelines for: ${path}`);
  console.log(`isContainer: ${isContainer(path)}`);

  hdr("OLD: discoverCandidates (markers-only)");
  const candidates = discoverCandidates(path);
  console.log(`  ${candidates.length} candidates`);
  for (const c of candidates) {
    const fw = c.framework ? ` [${c.framework}]` : "";
    const sub = c.subProjects?.length ? ` monorepo: ${c.subProjects.join(", ")}` : "";
    console.log(`  - ${c.name}${fw}${sub} (markers: ${c.markers.join(", ")})`);
  }

  hdr("OLD: groupWithLLM");
  const oldStart = Date.now();
  const oldGroups = await groupWithLLM(candidates);
  const oldMs = Date.now() - oldStart;
  for (const g of oldGroups) {
    console.log(`  space: ${g.name}`);
    for (const f of g.folders) console.log(`    · ${f.split("/").pop()}`);
  }
  console.log(`  (${oldMs}ms)`);

  hdr("NEW: discoverAllSubfolders (full)");
  const folders = discoverAllSubfolders(path);
  console.log(`  ${folders.length} folders`);
  for (const f of folders) {
    const mk = f.markers.length > 0 ? `markers: ${f.markers.join(", ")}` : "no markers";
    const fw = f.framework ? ` ${f.framework}` : "";
    const exts = f.sampleExtensions.slice(0, 3).join(" ");
    console.log(`  - ${f.name} (${mk}${fw}; ${f.fileCount}${f.fileCount >= 200 ? "+" : ""} files; ${exts})`);
  }

  hdr("NEW: groupWithLLMRich");
  const newStart = Date.now();
  const newGroups = await groupWithLLMRich(folders);
  const newMs = Date.now() - newStart;
  for (const g of newGroups) {
    const amb = g.ambiguous ? " ⚠" : "";
    console.log(`  space: ${g.name}${amb}`);
    console.log(`    reason: ${g.reason}`);
    for (const f of g.folders) console.log(`    · ${f.split("/").pop()}`);
  }
  console.log(`  (${newMs}ms)`);

  hdr("DIFF");
  const oldFolderSet = new Set(oldGroups.flatMap(g => g.folders.map(f => f.split("/").pop()!)));
  const newFolderSet = new Set(newGroups.flatMap(g => g.folders.map(f => f.split("/").pop()!)));
  const onlyOld = [...oldFolderSet].filter(f => !newFolderSet.has(f));
  const onlyNew = [...newFolderSet].filter(f => !oldFolderSet.has(f));
  console.log(`  folders only in OLD output: ${onlyOld.join(", ") || "(none)"}`);
  console.log(`  folders only in NEW output: ${onlyNew.join(", ") || "(none)"}`);
  console.log(`  latency: OLD ${oldMs}ms  NEW ${newMs}ms  (${newMs - oldMs >= 0 ? "+" : ""}${newMs - oldMs}ms)`);
  console.log(`  spaces: OLD ${oldGroups.length}  NEW ${newGroups.length}`);

  hdr("JSON DUMP (for the record)");
  console.log(JSON.stringify({ path, old: { candidates, groups: oldGroups, ms: oldMs }, new: { folders, groups: newGroups, ms: newMs } }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
