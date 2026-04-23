import { type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, execSync } from "node:child_process";
import { broadcastRaw, broadcastSynthetic } from "./opencode-events.js";

let shuttingDown = false;
let opencodeRestarts = 0;
const MAX_RESTARTS = 10;

let resolvedPort = 0;
let opencodeChild: ReturnType<typeof spawn> | null = null;

export function getOpenCodePort(): number {
  return resolvedPort;
}

export function killOpenCode() {
  if (opencodeChild) {
    const pid = opencodeChild.pid;
    if (process.platform === "win32" && pid) {
      try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch (err) {
        console.warn(`[opencode-serve] taskkill failed: ${err instanceof Error ? err.message : err}`);
      }
    } else if (pid) {
      // Child is its own process-group leader (detached: true on spawn), so
      // signalling -pid cascades to any workers opencode-ai itself spawned.
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try { opencodeChild.kill("SIGTERM"); } catch { /* already gone */ }
      }
    }
    opencodeChild = null;
  }
}

export function spawnOpenCodeServe(
  opencodeBin: string,
  opencodePort: number,
  userlandDir: string,
  cleanEnv: Record<string, string>,
) {
  console.log(`Spawning opencode serve in ${userlandDir}`);
  resolvedPort = 0;
  const portArg = opencodePort > 0 ? String(opencodePort) : "0";
  const child = spawn(opencodeBin, ["serve", "--port", portArg], {
    cwd: userlandDir,
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    // Give the child its own process group on Unix so killOpenCode can
    // cascade SIGTERM to any workers it spawned. Windows uses taskkill /T
    // which walks the tree directly and has no equivalent concept.
    detached: process.platform !== "win32",
  });
  opencodeChild = child;

  child.stdout?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    console.log(`[opencode-serve] ${text}`);
    // Parse actual port from output: "opencode server listening on http://127.0.0.1:XXXXX"
    const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match && !resolvedPort) {
      resolvedPort = parseInt(match[1], 10);
      opencodeRestarts = 0;
      console.log(`[opencode-serve] resolved to port ${resolvedPort}`);
    }
  });

  // #203: some opencode failures (notably ProviderModelNotFoundError when
  // no provider is authed) surface *only* on stderr — no HTTP error, no
  // session.error SSE event, the browser sits at "thinking..." forever.
  // Buffer stderr across chunks (the error and its "data: { ... }" block
  // can land in separate writes), pattern-match known failures, and
  // inject a synthetic session.error so the banner handler in
  // useChatEvents.ts surfaces it via the existing UI.
  let stderrBuffer = "";
  const MODEL_NOT_FOUND_RE = /ProviderModelNotFoundError[\s\S]*?providerID:\s*"([^"]+)"[\s\S]*?modelID:\s*"([^"]+)"/;
  child.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    console.error(`[opencode-serve] ${text.trim()}`);
    stderrBuffer = (stderrBuffer + text).slice(-4000);
    const match = stderrBuffer.match(MODEL_NOT_FOUND_RE);
    if (match) {
      const [full, providerID, modelID] = match;
      broadcastSynthetic({
        type: "session.error",
        properties: {
          error: {
            data: {
              message: `Model not found: ${providerID}/${modelID}`,
            },
          },
        },
      });
      // Drop consumed bytes so we don't re-fire on the same error.
      stderrBuffer = stderrBuffer.slice(stderrBuffer.indexOf(full) + full.length);
    }
  });

  function scheduleRestart(reason: string) {
    if (opencodeChild !== child) return; // already handled by other event
    opencodeChild = null;
    resolvedPort = 0;
    if (shuttingDown) return;
    opencodeRestarts++;
    if (opencodeRestarts > MAX_RESTARTS) {
      console.error("[opencode-serve] too many restarts, giving up");
      return;
    }
    const delay = Math.min(2000 * opencodeRestarts, 30000);
    console.log(`[opencode-serve] ${reason}, restarting in ${delay}ms...`);
    setTimeout(() => spawnOpenCodeServe(opencodeBin, opencodePort, userlandDir, cleanEnv), delay);
  }

  child.on("error", (err) => {
    console.error(`[opencode-serve] spawn error: ${err.message}`);
    scheduleRestart(`spawn error: ${err.message}`);
  });

  child.on("exit", (code) => {
    scheduleRestart(`exited (code ${code})`);
  });

  return child;
}

export function markShuttingDown() {
  shuttingDown = true;
}

export function isShuttingDown() {
  return shuttingDown;
}

// ── Auto-approve permission requests from opencode ──
// In the PoC, we trust all tool use. This listens to the SSE stream
// and auto-approves any permission.asked events.

export function startAutoApprover(
  getPort: () => number,
  onFileEdited: (file: string) => void,
) {
  async function connect() {
    const opencodePort = getPort();
    if (!opencodePort) {
      // Port not resolved yet, retry
      setTimeout(connect, 3000);
      return;
    }
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${opencodePort}/event`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        console.log("[auto-approver] failed to connect, retrying in 3s...");
        setTimeout(connect, 3000);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      async function pump() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });

            // Fan out the raw SSE bytes to any connected browser clients
            // before we parse them for our own reactive behaviour below.
            // This replaces the previous per-client proxySSE — a single
            // upstream subscription avoids multiplying opencode load by
            // the number of open tabs, and gives us a place to inject
            // server-originated synthetic events.
            broadcastRaw(text);

            buffer += text;

            // Parse SSE lines
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              try {
                const event = JSON.parse(line.slice(6));
                if (event.type === "permission.asked") {
                  const requestId = event.properties.id;
                  console.log(`[auto-approver] approving ${requestId}: ${event.properties.permission}`);
                  fetch(`http://127.0.0.1:${opencodePort}/permission/${requestId}/reply`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ reply: "always" }),
                  }).catch(() => {});
                }

                // Auto-detect new artifacts from file.edited events
                if (event.type === "file.edited") {
                  const file = event.properties.file as string | undefined;
                  if (file) onFileEdited(file);
                }
              } catch {}
            }
          }
        } catch {}
      }

      pump().finally(() => {
        controller.abort();
        if (!shuttingDown) {
          console.log("[auto-approver] disconnected, reconnecting in 3s...");
          setTimeout(connect, 3000);
        }
      });
    } catch {
      if (!shuttingDown) setTimeout(connect, 3000);
    }
  }

  // Give opencode serve a moment to start before connecting
  setTimeout(connect, 3000);
}

// ── Proxy helpers for opencode API ──

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}

export async function proxyToOpenCode(
  req: IncomingMessage,
  res: ServerResponse,
  targetPath: string,
  opencodePort: number,
) {
  const method = req.method || "GET";
  const url = `http://127.0.0.1:${opencodePort}${targetPath}`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const fetchOpts: RequestInit = { method, headers };

  if (method === "POST" || method === "PATCH" || method === "PUT") {
    fetchOpts.body = await readBody(req);
  }

  try {
    const upstream = await fetch(url, fetchOpts);
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
    });
    const text = await upstream.text();
    res.end(text);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "opencode serve unavailable" }));
  }
}

