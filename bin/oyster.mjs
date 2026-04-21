#!/usr/bin/env node

import { spawn, execSync, execFileSync } from "node:child_process";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync,
  rmSync, cpSync, createWriteStream, realpathSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB cap on plugin bundles
const DOWNLOAD_TIMEOUT_MS = 60_000;
const API_TIMEOUT_MS = 10_000;
// The community registry is the trust root for `oyster install <id>`. A merged
// PR to that repo can redirect any id to any repo — delegation is to the
// registry maintainer, not verified here. Direct `oyster install <owner>/<repo>`
// bypasses the registry entirely.
const REGISTRY_URL = "https://raw.githubusercontent.com/mattslight/oyster-community-plugins/main/community-plugins.json";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const OYSTER_HOME = join(homedir(), ".oyster");

// ── CLI flags ──
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
  printHelp();
  process.exit(0);
}

// ── Plugin subcommands ──

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/;

const cmd = args[0];
if (cmd && !cmd.startsWith("-")) {
  try {
    if (cmd === "install") { await cmdInstall(args[1]); process.exit(0); }
    if (cmd === "uninstall" || cmd === "remove") { cmdUninstall(args[1]); process.exit(0); }
    if (cmd === "list" || cmd === "ls") { cmdList(); process.exit(0); }
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    process.exit(1);
  } catch (err) {
    console.error(`\n  Error: ${err.message}\n`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
  🦪 Oyster — prompt-controlled workspace OS

  Usage:
    oyster                            Start the server (default)
    oyster install <id|owner/repo>    Install a plugin by registry id, or directly from a repo
    oyster uninstall <id>             Remove an installed plugin
    oyster list                       List installed plugins
    oyster --version                  Print version
    oyster --help                     Show this help

  Examples:
    oyster install pomodoro                           # resolved via community registry
    oyster install mattslight/oyster-sample-plugin    # explicit repo path
`);
}

// Returns { repo, expectedId } — expectedId is set only when arg was resolved
// via the registry, letting the caller assert the downloaded manifest.id
// matches what the user typed. For direct <owner>/<repo> installs there's
// nothing to cross-check against, so expectedId is null.
async function resolvePluginArg(arg) {
  if (!arg) {
    throw new Error("install expects a plugin id or <owner>/<repo>, e.g. 'oyster install pomodoro'");
  }
  if (REPO_PATTERN.test(arg)) return { repo: arg, expectedId: null };
  if (!PLUGIN_ID_PATTERN.test(arg)) {
    throw new Error(`'${arg}' is neither a valid plugin id nor an <owner>/<repo> path.`);
  }
  console.log(`\n  Looking up '${arg}' in the community registry...`);
  const registry = await fetchJson(REGISTRY_URL);
  if (!Array.isArray(registry)) {
    throw new Error("Registry response was not a JSON array — ask the registry maintainer.");
  }
  const matches = registry.filter((p) => p && p.id === arg);
  if (matches.length === 0) {
    throw new Error(`'${arg}' is not listed in the community registry. Try 'oyster install <owner>/<repo>' for plugins that aren't listed, or browse https://oyster.to/plugins.`);
  }
  if (matches.length > 1) {
    throw new Error(`Registry has ${matches.length} entries with id '${arg}' — report this to the registry maintainer.`);
  }
  const entry = matches[0];
  if (!entry.repo || !REPO_PATTERN.test(entry.repo)) {
    throw new Error(`Registry entry for '${arg}' has an invalid 'repo' field: '${entry.repo}'.`);
  }
  console.log(`  → ${entry.repo}`);
  return { repo: entry.repo, expectedId: arg };
}

async function cmdInstall(arg) {
  const { repo, expectedId } = await resolvePluginArg(arg);

  console.log(`\n  Fetching latest release of ${repo}...`);
  const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  const assets = release.assets || [];
  const zipAsset = assets.find((a) => a.name.toLowerCase().endsWith(".zip"));
  if (!zipAsset) {
    throw new Error(`No .zip asset found in release ${release.tag_name || "?"} of ${repo}. Plugin authors: attach a zipped bundle to the release.`);
  }
  console.log(`  Release: ${release.tag_name} (${zipAsset.name}, ${(zipAsset.size / 1024).toFixed(1)} KB)`);

  const workDir = mkdtempSync(join(tmpdir(), "oyster-install-"));
  // Hardcode the local filename — never interpolate attacker-controlled asset.name into a path.
  const zipPath = join(workDir, "bundle.zip");
  const extractDir = join(workDir, "extracted");
  mkdirSync(extractDir);

  try {
    await downloadFile(zipAsset.browser_download_url, zipPath);
    extractZip(zipPath, extractDir);
    assertNoZipSlip(extractDir);

    const manifestRoot = locateManifestRoot(extractDir);
    const manifest = JSON.parse(readFileSync(join(manifestRoot, "manifest.json"), "utf8"));
    if (!manifest.id || !PLUGIN_ID_PATTERN.test(manifest.id)) {
      throw new Error(`Invalid plugin id in manifest: '${manifest.id}'. Must match ${PLUGIN_ID_PATTERN}.`);
    }
    if (expectedId && manifest.id !== expectedId) {
      throw new Error(`Registry mismatch: '${expectedId}' points to ${repo}, but that plugin declares id '${manifest.id}'. Refusing install so 'oyster uninstall ${expectedId}' stays honest. Report to the registry maintainer.`);
    }

    const userlandDir = join(OYSTER_HOME, "userland");
    mkdirSync(userlandDir, { recursive: true });
    const destDir = join(userlandDir, manifest.id);

    if (existsSync(destDir)) {
      throw new Error(`Plugin '${manifest.id}' is already installed at ${destDir}. Run 'oyster uninstall ${manifest.id}' first.`);
    }

    try {
      cpSync(manifestRoot, destDir, { recursive: true });
    } catch (err) {
      rmSync(destDir, { recursive: true, force: true });
      throw err;
    }

    console.log(`\n  ✓ Installed ${manifest.name} v${manifest.version || "?"}`);
    console.log(`    ${destDir}`);
    console.log(`\n  Restart Oyster (or the running server) to see it on your surface.\n`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function cmdUninstall(id) {
  if (!id || !PLUGIN_ID_PATTERN.test(id)) {
    throw new Error("uninstall expects a valid plugin id, e.g. 'oyster uninstall pomodoro'");
  }
  const dir = join(OYSTER_HOME, "userland", id);
  if (!existsSync(dir)) {
    throw new Error(`'${id}' is not installed.`);
  }
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`${dir} has no manifest.json — refusing to remove a folder that isn't a plugin.`);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n  ✓ Uninstalled ${id}\n`);
}

function cmdList() {
  const userlandDir = join(OYSTER_HOME, "userland");
  if (!existsSync(userlandDir)) {
    console.log("\n  No plugins installed.\n");
    return;
  }
  const rows = [];
  for (const entry of readdirSync(userlandDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(userlandDir, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf8"));
      rows.push({ id: m.id || entry.name, name: m.name || "-", version: m.version || "?", builtin: m.builtin === true });
    } catch {}
  }
  if (rows.length === 0) {
    console.log("\n  No plugins installed.\n");
    return;
  }
  const idWidth = Math.max(8, ...rows.map((r) => r.id.length));
  const nameWidth = Math.max(8, ...rows.map((r) => r.name.length));
  console.log("");
  for (const r of rows) {
    const tag = r.builtin ? " (builtin)" : "";
    console.log(`  ${r.id.padEnd(idWidth)}  ${r.name.padEnd(nameWidth)}  v${r.version}${tag}`);
  }
  console.log("");
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "oyster-cli", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}`);
  return await res.json();
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "oyster-cli" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);

  const declared = Number(res.headers.get("content-length"));
  if (declared && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Bundle too large: ${(declared / 1024 / 1024).toFixed(1)} MB (limit ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB)`);
  }

  let bytes = 0;
  const capped = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_DOWNLOAD_BYTES) {
        cb(new Error(`Bundle exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB limit`));
        return;
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), capped, createWriteStream(destPath));
}

function extractZip(zipPath, destDir) {
  try {
    execFileSync("unzip", ["-q", zipPath, "-d", destDir], { stdio: "pipe" });
    return;
  } catch {
    // fall through to tar
  }
  try {
    execFileSync("tar", ["-xf", zipPath, "-C", destDir], { stdio: "pipe" });
    return;
  } catch {
    throw new Error("Extraction failed — neither `unzip` nor `tar` could open the bundle.");
  }
}

// Defend against zip-slip: every extracted path must resolve under the extract root,
// even after following any symlinks that landed in the archive.
function assertNoZipSlip(rootDir) {
  const realRoot = realpathSync(rootDir);
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const real = realpathSync(full);
      if (real !== realRoot && !real.startsWith(rootPrefix)) {
        throw new Error(`Unsafe archive entry escapes plugin dir: ${entry.name} → ${real}`);
      }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(realRoot);
}

// Source-zipballs nest everything under <repo>-<sha>/. If manifest.json isn't at
// the extract root, probe exactly one level deep for it.
function locateManifestRoot(extractDir) {
  if (existsSync(join(extractDir, "manifest.json"))) return extractDir;
  const subdirs = readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (subdirs.length === 1) {
    const nested = join(extractDir, subdirs[0].name);
    if (existsSync(join(nested, "manifest.json"))) return nested;
  }
  throw new Error("Downloaded bundle has no manifest.json at the root (or one level deep).");
}

const ENV_FILE = join(OYSTER_HOME, ".env");

// ── Resolve env vars ──

function loadEnvFile(path, env) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  for (const line of lines) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match && !env[match[1]]) env[match[1]] = match[2];
  }
}

function getEnvVars() {
  const env = { ...process.env };
  loadEnvFile(join(PACKAGE_ROOT, ".env"), env);
  loadEnvFile(ENV_FILE, env);
  return env;
}

// ── Find bundled OpenCode binary ──

function findOpenCodeBin() {
  const isWin = process.platform === "win32";
  const names = isWin ? ["opencode.cmd", "opencode.ps1", "opencode"] : ["opencode"];
  const roots = [
    join(PACKAGE_ROOT, "node_modules", ".bin"),
    join(PACKAGE_ROOT, "server", "node_modules", ".bin"),
  ];
  // Walk up for hoisted installs (npx, global)
  let dir = PACKAGE_ROOT;
  for (let i = 0; i < 5; i++) {
    roots.push(join(dir, "node_modules", ".bin"));
    dir = dirname(dir);
  }
  for (const root of roots) {
    for (const name of names) {
      const candidate = join(root, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "opencode"; // fallback to PATH
}

// ── Check OpenCode auth ──

function hasAuth() {
  const authFile = join(homedir(), ".local", "share", "opencode", "auth.json");
  if (!existsSync(authFile)) return false;
  try {
    const data = JSON.parse(readFileSync(authFile, "utf8"));
    return Object.keys(data).length > 0;
  } catch {
    return false;
  }
}

function runLogin(opencodeBin) {
  return new Promise((resolve) => {
    const child = spawn(opencodeBin, ["providers", "login"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => resolve(code === 0));
  });
}

// ── Main ──

async function main() {
  const env = getEnvVars();
  const opencodeBin = findOpenCodeBin();

  // Ensure userland dir exists
  mkdirSync(join(OYSTER_HOME, "userland"), { recursive: true });

  // Skip auth check if any provider API key is in env
  const hasEnvKey = env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GOOGLE_API_KEY || env.GEMINI_API_KEY;

  // Check auth — if none, run login inline
  if (!hasEnvKey && !hasAuth()) {
    console.log("\n  🦪 Welcome to Oyster\n");
    console.log("  First, let's connect an AI provider.\n");

    const ok = await runLogin(opencodeBin);
    if (!ok || !hasAuth(opencodeBin)) {
      console.log("\n  No provider configured. Run `oyster` again to retry.\n");
      process.exit(1);
    }
    console.log("\n  Provider connected. Starting Oyster...\n");
  }

  // Mark as installed (not running from source)
  env.OYSTER_INSTALLED = "1";

  // Terminal opens in user's home directory
  env.OYSTER_WORKSPACE = env.OYSTER_WORKSPACE || homedir();

  const serverEntry = join(PACKAGE_ROOT, "server", "dist", "server", "src", "index.js");

  if (!existsSync(serverEntry)) {
    console.error("  Error: Server not built. Run `npm run build` first.");
    process.exit(1);
  }

  console.log("\n  🦪 Starting Oyster...\n");

  const child = spawn("node", [serverEntry], {
    stdio: ["inherit", "pipe", "inherit"],
    env,
    cwd: PACKAGE_ROOT,
  });

  // Watch stdout for the listening message to get the actual port
  let opened = false;
  child.stdout.on("data", (data) => {
    const text = data.toString();
    process.stdout.write(text);
    if (!opened) {
      const match = text.match(/listening on (http:\/\/localhost:\d+)/);
      if (match) {
        opened = true;
        const url = match[1];
        console.log(`\n  👉 Open: ${url} 👈\n`);
        console.log(`  🔗 Bring your own AI:`);
        console.log(`     claude mcp add --scope user --transport http oyster ${url}/mcp/\n`);
        console.log(`  What you can do:`);
        console.log(`  • "Create a deck about our roadmap" → appears on your surface`);
        console.log(`  • "Scan ~/Dev/my-project" → new space with everything discovered`);
        console.log(`  • "Open the competitor analysis" → opens in viewer\n`);
        try {
          const platform = process.platform;
          if (platform === "darwin") execSync(`open ${url}`);
          else if (platform === "linux") execSync(`xdg-open ${url}`);
          else if (platform === "win32") execSync(`start ${url}`);
        } catch {
          // Browser open is best-effort
        }
      }
    }
  });

  // Forward signals
  process.on("SIGINT", () => { child.kill("SIGINT"); process.exit(0); });
  process.on("SIGTERM", () => { child.kill("SIGTERM"); process.exit(0); });

  child.on("exit", (code) => process.exit(code || 0));
}

main();
