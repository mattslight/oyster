import { existsSync } from "node:fs";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import type { Artifact } from "../../shared/types.js";

export type { Artifact, ArtifactKind, ArtifactStatus, IconStatus } from "../../shared/types.js";

// ── State ──

const procs = new Map<string, ChildProcess>();
const starting = new Set<string>();

export function isStarting(name: string): boolean {
  return starting.has(name);
}

export function clearStarting(name: string): void {
  starting.delete(name);
}

// ── Generated artifacts (in-memory, transitional) ──

type GeneratedEntry = Artifact & { filePath?: string; builtin?: boolean };

const generatedArtifacts = new Map<string, GeneratedEntry>();

export function registerGeneratedArtifact(artifact: Artifact, filePath?: string, builtin = false): void {
  generatedArtifacts.set(artifact.id, { ...artifact, filePath, builtin });
}

export function updateGeneratedArtifact(id: string, fields: Partial<Artifact>, filePath?: string): void {
  const existing = generatedArtifacts.get(id);
  if (existing) {
    Object.assign(existing, fields);
    if (filePath !== undefined) existing.filePath = filePath;
  }
}

// Returns full entries including filePath and builtin — used for reconciliation and twin-suppression
export function getGeneratedArtifactEntries(onRemove?: (id: string, filePath: string) => void): GeneratedEntry[] {
  for (const [id, entry] of generatedArtifacts) {
    if (entry.filePath && !existsSync(entry.filePath)) {
      console.log(`[artifact-cleanup] removed stale artifact: ${entry.label} (${entry.filePath})`);
      generatedArtifacts.delete(id);
      onRemove?.(id, entry.filePath);
    }
  }
  return Array.from(generatedArtifacts.values());
}

// ── Port / HTTP checks ──

export function tryConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    sock.setTimeout(1500);
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

export async function isPortOpen(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([
    tryConnect(port, "127.0.0.1"),
    tryConnect(port, "::1"),
  ]);
  return v4 || v6;
}

export async function isHttpReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok || res.status === 304;
  } catch {
    return false;
  }
}

export function waitForReady(
  port: number,
  timeout = 30000
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = async () => {
      if (await isHttpReady(port)) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("timeout"));
      setTimeout(check, 500);
    };
    check();
  });
}

// ── App lifecycle ──

export function startApp(name: string, config: { command: string; cwd: string; port: number }): void {
  if (procs.has(name)) return;

  starting.add(name);

  const parts = config.command.split(/\s+/);
  const child = spawn(
    parts[0],
    [...parts.slice(1), "--port", String(config.port), "--strictPort"],
    { cwd: config.cwd, stdio: "pipe" }
  );

  procs.set(name, child);

  child.on("exit", () => {
    procs.delete(name);
    starting.delete(name);
  });

  child.stdout?.on("data", (d: Buffer) =>
    process.stdout.write(`[${name}] ${d}`)
  );
  child.stderr?.on("data", (d: Buffer) =>
    process.stderr.write(`[${name}] ${d}`)
  );
}

export function stopApp(name: string, port: number): boolean {
  const child = procs.get(name);
  if (child) {
    child.kill("SIGTERM");
    procs.delete(name);
    starting.delete(name);
    return true;
  }

  // Not managed — kill by port
  try {
    const pids = execSync(`lsof -ti:${port}`, {
      encoding: "utf8",
    }).trim();
    if (pids) {
      execSync(`kill ${pids.split("\n").join(" ")}`);
      return true;
    }
  } catch {
    /* no process on port */
  }
  return false;
}

// ── Cleanup on exit ──

function cleanup() {
  procs.forEach((p) => p.kill());
  process.exit();
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
