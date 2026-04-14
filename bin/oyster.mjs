#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const OYSTER_HOME = join(homedir(), ".oyster");
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

function hasAuth(opencodeBin) {
  try {
    const result = execSync(`"${opencodeBin}" providers list`, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      shell: true,
    });
    return result.toString().includes("●");
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

  // Check auth — if none, run login inline
  if (!hasAuth(opencodeBin)) {
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
        console.log(`     claude mcp add --transport http oyster ${url}/mcp/\n`);
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
