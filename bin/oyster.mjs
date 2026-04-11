#!/usr/bin/env node

import { spawn, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const OYSTER_HOME = join(process.env.HOME || "~", ".oyster");
const ENV_FILE = join(OYSTER_HOME, ".env");

// ── Resolve API key ──

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
  // Check project root .env, then ~/.oyster/.env
  loadEnvFile(join(PACKAGE_ROOT, ".env"), env);
  loadEnvFile(ENV_FILE, env);
  return env;
}

async function ensureApiKey(env) {
  // Check for any supported provider key
  const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY"];
  if (keys.some((k) => env[k])) return env;

  console.log("\n  🦪 Welcome to Oyster\n");
  console.log("  You need an API key to power the AI engine.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question("  Paste your API key: ", resolve);
  });
  rl.close();

  const key = answer.trim();
  if (!key) {
    console.log("\n  No key provided. Set your API key in ~/.oyster/.env\n");
    process.exit(1);
  }

  // Detect provider from key prefix
  let envVar = "ANTHROPIC_API_KEY";
  if (key.startsWith("sk-ant-")) envVar = "ANTHROPIC_API_KEY";
  else if (key.startsWith("sk-")) envVar = "OPENAI_API_KEY";
  else if (key.startsWith("gsk_")) envVar = "GROQ_API_KEY";

  // Save to ~/.oyster/.env
  mkdirSync(OYSTER_HOME, { recursive: true });
  const envContent = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  writeFileSync(ENV_FILE, envContent + `${envVar}=${key}\n`);
  console.log(`\n  Saved as ${envVar} to ${ENV_FILE}\n`);

  env.ANTHROPIC_API_KEY = key;
  return env;
}

// ── Main ──

async function main() {
  const env = await ensureApiKey(getEnvVars());

  // Set workspace to cwd
  env.OYSTER_WORKSPACE = env.OYSTER_WORKSPACE || PACKAGE_ROOT;

  const serverEntry = join(PACKAGE_ROOT, "server", "dist", "server", "src", "index.js");

  if (!existsSync(serverEntry)) {
    console.error("  Error: Server not built. Run `npm run build` first.");
    process.exit(1);
  }

  console.log("\n  🦪 Starting Oyster...\n");

  const child = spawn("node", [serverEntry], {
    stdio: "inherit",
    env,
    cwd: PACKAGE_ROOT,
  });

  // Wait a moment then open browser
  setTimeout(() => {
    const url = "http://localhost:4200";
    console.log(`\n  Open: ${url}\n`);
    try {
      const platform = process.platform;
      if (platform === "darwin") execSync(`open ${url}`);
      else if (platform === "linux") execSync(`xdg-open ${url}`);
      else if (platform === "win32") execSync(`start ${url}`);
    } catch {
      // Browser open is best-effort
    }
  }, 3000);

  // Forward signals
  process.on("SIGINT", () => { child.kill("SIGINT"); process.exit(0); });
  process.on("SIGTERM", () => { child.kill("SIGTERM"); process.exit(0); });

  child.on("exit", (code) => process.exit(code || 0));
}

main();
