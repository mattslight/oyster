#!/usr/bin/env node
// Local discovery PoC — walker + git metadata + LLM filter + report
// Usage: node scripts/discovery-poc.mjs [--emails a@b.com,c@d.com] [--roots ~,/Users/x/work]

import { promises as fs, existsSync, readFileSync } from "node:fs";
import { join, basename, dirname, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// ─── Config ───────────────────────────────────────────────────────────────

const MARKERS = [
  ".git", "package.json", "go.mod", "Cargo.toml", "pyproject.toml",
  "setup.py", "requirements.txt", "Gemfile", "pom.xml", "build.gradle",
  "Makefile",
];
const SKIP = new Set([
  "node_modules", "dist", "build", ".venv", "venv", "target", "vendor",
  "Library", ".cache", "__pycache__", ".next", ".Trash", ".npm", ".yarn",
  ".docker", ".local", ".config", ".cargo", ".rustup", ".pyenv", ".nvm",
  ".vscode", "Applications", ".Trashes", "Music", "Movies", "Public",
]);
const MAX_DEPTH = 3;
const RECENT_DAYS = 90;
const MIN_RECENT_FILES = 3;
const AUTHOR_WINDOW_DAYS = 180;

// ─── CLI ─────────────────────────────────────────────────────────────────

async function parseArgs(argv) {
  const args = { emails: [], roots: [homedir()], maxDepth: MAX_DEPTH };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--emails") {
      args.emails = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (argv[i] === "--roots") {
      args.roots = argv[++i].split(",").map((s) => {
        const p = s.trim();
        return p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(p);
      });
    } else if (argv[i] === "--depth") {
      args.maxDepth = parseInt(argv[++i], 10) || MAX_DEPTH;
    }
  }
  if (args.emails.length === 0) {
    try {
      const { stdout } = await execFileP("git", ["config", "--global", "user.email"]);
      if (stdout.trim()) args.emails = [stdout.trim()];
    } catch {}
  }
  return args;
}

// ─── Walker ──────────────────────────────────────────────────────────────

async function walk(root, userEmails, stats, maxDepth = MAX_DEPTH) {
  const candidates = [];

  async function visit(path, depth) {
    stats.dirsVisited++;
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await fs.readdir(path, { withFileTypes: true });
    } catch {
      return;
    }

    const names = new Set(entries.map((e) => e.name));
    const markerHits = MARKERS.filter((m) => names.has(m));

    if (markerHits.length > 0) {
      const meta = await gatherMeta(path, entries, markerHits, depth, userEmails, stats);
      candidates.push(meta);
      return; // don't descend into a project
    }

    if (depth >= 1) {
      const meta = await checkRecency(path, entries, depth, userEmails, stats);
      if (meta) candidates.push(meta);
    }

    if (depth >= maxDepth) return;

    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      if (!e.isDirectory()) continue;
      await visit(join(path, e.name), depth + 1);
    }
  }

  await visit(root, 0);
  return candidates;
}

async function gatherMeta(path, entries, markers, depth, userEmails, stats) {
  let fileCount = 0, dirCount = 0, sizeBytes = 0, lastMod = 0, recentFiles = 0;
  const typeCounts = new Map();
  const recentThresholdMs = Date.now() - RECENT_DAYS * 86400 * 1000;

  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isFile()) {
      fileCount++;
      const ext = extname(e.name).toLowerCase();
      if (ext) typeCounts.set(ext, (typeCounts.get(ext) || 0) + 1);
      try {
        const st = await fs.stat(join(path, e.name));
        sizeBytes += st.size;
        if (st.mtimeMs > lastMod) lastMod = st.mtimeMs;
        if (st.mtimeMs >= recentThresholdMs) recentFiles++;
      } catch {}
    } else if (e.isDirectory()) {
      dirCount++;
    }
  }

  const topTypes = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([ext, n]) => `${ext}(${n})`);

  const meta = {
    path,
    name: basename(path),
    parent_name: basename(dirname(path)),
    depth,
    file_count: fileCount,
    dir_count: dirCount,
    top_file_types: topTypes,
    recent_files_90d: recentFiles,
    last_modified: lastMod ? new Date(lastMod).toISOString() : null,
    size_mb: +(sizeBytes / (1024 * 1024)).toFixed(1),
    markers,
    detection: markers.length > 0 ? "marker" : "recency",
  };

  // Framework detection (reuse existing discovery.ts logic inline)
  if (markers.includes("package.json")) {
    try {
      const pkg = JSON.parse(await fs.readFile(join(path, "package.json"), "utf8"));
      const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
      const frameworks = ["react", "vue", "next", "vite", "svelte", "angular", "nuxt", "astro"];
      meta.framework = frameworks.find((f) => deps.some((d) => d.includes(f)));
    } catch {}
  } else if (markers.includes("go.mod")) meta.framework = "go";
  else if (markers.includes("Cargo.toml")) meta.framework = "rust";
  else if (markers.includes("pyproject.toml") || markers.includes("setup.py")) meta.framework = "python";

  // Git metadata
  if (markers.includes(".git")) {
    Object.assign(meta, await gatherGitMeta(path, userEmails));
    stats.gitRepos++;
  }

  return meta;
}

async function checkRecency(path, entries, depth, userEmails, stats) {
  // Quick recency check before building full meta
  const recentThresholdMs = Date.now() - RECENT_DAYS * 86400 * 1000;
  let recent = 0;
  for (const e of entries) {
    if (e.name.startsWith(".") || !e.isFile()) continue;
    try {
      const st = await fs.stat(join(path, e.name));
      if (st.mtimeMs >= recentThresholdMs) recent++;
      if (recent >= MIN_RECENT_FILES) break;
    } catch {}
  }
  if (recent < MIN_RECENT_FILES) return null;
  return gatherMeta(path, entries, [], depth, userEmails, stats);
}

async function gatherGitMeta(path, userEmails) {
  const meta = {};

  try {
    const { stdout } = await execFileP("git", ["-C", path, "config", "--get", "remote.origin.url"]);
    meta.git_origin = stdout.trim() || null;
  } catch { meta.git_origin = null; }

  try {
    const { stdout } = await execFileP("git", ["-C", path, "config", "user.email"]);
    meta.git_repo_email = stdout.trim() || null;
  } catch { meta.git_repo_email = null; }

  try {
    const { stdout } = await execFileP("git", ["-C", path, "rev-list", "--count", "HEAD"]);
    meta.git_total_commits = parseInt(stdout.trim(), 10) || 0;
  } catch { meta.git_total_commits = 0; }

  // Author breakdown for last 180 days
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", path, "log", `--since=${AUTHOR_WINDOW_DAYS} days ago`, "--format=%ae\x1f%an"],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const counts = new Map();
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [email, name] = line.split("\x1f");
      const entry = counts.get(email) || { email, name, commits: 0 };
      entry.commits++;
      counts.set(email, entry);
    }
    const authors = [...counts.values()].sort((a, b) => b.commits - a.commits);
    meta.git_top_authors_180d = authors.slice(0, 3);

    const userSet = new Set(userEmails);
    meta.git_user_commits_180d = authors
      .filter((a) => userSet.has(a.email))
      .reduce((sum, a) => sum + a.commits, 0);
  } catch {
    meta.git_top_authors_180d = [];
    meta.git_user_commits_180d = 0;
  }

  // Last commit by user (any known email)
  meta.git_last_commit_by_user = null;
  if (userEmails.length > 0) {
    try {
      const authorFilters = userEmails.flatMap((e) => [`--author=${e}`]);
      const { stdout } = await execFileP(
        "git",
        ["-C", path, "log", "-1", "--format=%aI", ...authorFilters],
      );
      meta.git_last_commit_by_user = stdout.trim() || null;
    } catch {}
  }

  return meta;
}

// ─── LLM filter ──────────────────────────────────────────────────────────

function loadApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      if (auth.anthropic) return auth.anthropic.key || auth.anthropic.access || null;
    } catch {}
  }
  return null;
}

function buildPrompt(candidates, userEmails) {
  // Strip the absolute path prefix to reduce tokens (show ~/ relative)
  const home = homedir();
  const rel = (p) => (p.startsWith(home) ? "~" + p.slice(home.length) : p);

  const payload = candidates.map((c) => ({
    path: rel(c.path),
    depth: c.depth,
    file_count: c.file_count,
    dir_count: c.dir_count,
    top_types: c.top_file_types,
    recent_files_90d: c.recent_files_90d,
    size_mb: c.size_mb,
    markers: c.markers,
    framework: c.framework,
    detection: c.detection,
    ...(c.markers.includes(".git") ? {
      git_origin: c.git_origin,
      git_user_commits_180d: c.git_user_commits_180d,
      git_total_commits: c.git_total_commits,
      git_top_authors_180d: c.git_top_authors_180d,
      git_repo_email: c.git_repo_email,
    } : {}),
  }));

  return `You are filtering a list of folders discovered on a user's machine. Decide which are real work projects (code the user contributes to, writing projects, design work, research, client deliverables) versus junk (read-only clones, auto-generated backups, downloads, caches, system folders, loose files, subfolders of existing projects).

Use the metadata carefully:
- For git repos, low or zero git_user_commits_180d combined with an unfamiliar git_origin owner (e.g. "getzep/graphiti" when the user isn't getzep) strongly suggests a read-only clone, not the user's work.
- Timestamped folder names (ISO dates, YYYY-MM-DD, backup-...) suggest auto-generated backups.
- Folders named "Downloads", "Desktop", "tmp", "Trash" are almost never work projects — reject even with recent activity.
- Paths containing "backups/", "userland-backup", "backup-2026-" etc are auto-generated.
- A repo where the top author is someone else AND git_user_commits_180d is 0 is a clone.
- The user's known identities: ${JSON.stringify(userEmails)}. Match generously — first-name similarity is a weak positive signal.

Input (array of candidates):
${JSON.stringify(payload, null, 2)}

Output ONLY valid JSON matching this schema (no prose, no markdown fences):
{
  "kept": [{"path": "<as-given>", "reason": "<one sentence>"}],
  "rejected": [{"path": "<as-given>", "reason": "<one sentence>"}]
}

Every input candidate MUST appear in exactly one of kept or rejected.`;
}

async function callHaiku(prompt, apiKey) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }
  const data = await res.json();
  return {
    text: data.content[0].text,
    usage: data.usage,
  };
}

function parseVerdict(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON object in LLM response");
  return JSON.parse(m[0]);
}

// ─── Report ──────────────────────────────────────────────────────────────

function formatCandidate(c, home) {
  const rel = c.path.startsWith(home) ? "~" + c.path.slice(home.length) : c.path;
  const tags = [];
  if (c.markers.length) tags.push(c.markers.join(","));
  if (c.framework) tags.push(c.framework);
  if (c.markers.includes(".git")) {
    if (c.git_origin) tags.push(`origin=${c.git_origin.replace(/^.*[:/]/, "").replace(/\.git$/, "")}`);
    tags.push(`u=${c.git_user_commits_180d}/180d`);
  }
  if (c.detection === "recency") tags.push(`${c.recent_files_90d}rec`);
  return { rel, tags };
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = await parseArgs(process.argv);

  console.log("== Discovery PoC ==");
  console.log(`Emails: ${args.emails.join(", ") || "(none)"}`);
  console.log(`Roots:  ${args.roots.join(", ")}`);
  console.log();

  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error("ERROR: No Anthropic API key found.");
    console.error("  Set ANTHROPIC_API_KEY env var OR");
    console.error("  Ensure ~/.local/share/opencode/auth.json has an 'anthropic' entry");
    process.exit(1);
  }

  // Crawl
  const stats = { dirsVisited: 0, gitRepos: 0 };
  const crawlStart = performance.now();
  let candidates = [];
  for (const root of args.roots) {
    const rootStart = performance.now();
    const found = await walk(root, args.emails, stats, args.maxDepth);
    console.log(`  walked ${root} → ${found.length} candidates in ${(performance.now() - rootStart).toFixed(0)}ms`);
    candidates.push(...found);
  }
  const crawlMs = performance.now() - crawlStart;

  console.log(`== Crawl ==`);
  console.log(`Visited ${stats.dirsVisited} directories, ${stats.gitRepos} git repos, in ${crawlMs.toFixed(0)}ms`);
  console.log(`Found ${candidates.length} candidates`);
  console.log();

  if (candidates.length === 0) {
    console.log("(no candidates found, exiting)");
    return;
  }

  // LLM filter
  const prompt = buildPrompt(candidates, args.emails);
  const llmStart = performance.now();
  console.log(`== LLM filter ==`);
  console.log(`Prompt size: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);
  console.log(`Calling Haiku...`);

  const { text, usage } = await callHaiku(prompt, apiKey);
  const llmMs = performance.now() - llmStart;

  const verdict = parseVerdict(text);
  console.log(
    `Response in ${llmMs.toFixed(0)}ms — in=${usage.input_tokens} out=${usage.output_tokens} tokens`,
  );
  console.log();

  // Report
  const home = homedir();
  const byPath = new Map(candidates.map((c) => [c.path.startsWith(home) ? "~" + c.path.slice(home.length) : c.path, c]));

  console.log(`== Kept (${verdict.kept.length}) ==`);
  for (const k of verdict.kept) {
    const c = byPath.get(k.path);
    const { rel, tags } = c ? formatCandidate(c, home) : { rel: k.path, tags: [] };
    console.log(`  ${rel}`);
    console.log(`    tags:   ${tags.join(" | ")}`);
    console.log(`    reason: ${k.reason}`);
  }
  console.log();

  console.log(`== Rejected (${verdict.rejected.length}) ==`);
  for (const r of verdict.rejected) {
    const c = byPath.get(r.path);
    const { rel, tags } = c ? formatCandidate(c, home) : { rel: r.path, tags: [] };
    console.log(`  ${rel}`);
    console.log(`    tags:   ${tags.join(" | ")}`);
    console.log(`    reason: ${r.reason}`);
  }
  console.log();

  const total = crawlMs + llmMs;
  console.log(`== Timings ==`);
  console.log(`Crawl:  ${crawlMs.toFixed(0)}ms`);
  console.log(`LLM:    ${llmMs.toFixed(0)}ms`);
  console.log(`Total:  ${total.toFixed(0)}ms`);

  // Persist raw data for re-runs / ground-truth annotation
  const outPath = join(dirname(new URL(import.meta.url).pathname), "discovery-poc-last.json");
  await fs.writeFile(
    outPath,
    JSON.stringify({ args, stats, crawlMs, llmMs, candidates, verdict, usage }, null, 2),
  );
  console.log();
  console.log(`Raw output written to ${outPath}`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
