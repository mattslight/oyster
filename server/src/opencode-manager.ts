import { type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";

let shuttingDown = false;
let opencodeRestarts = 0;
const MAX_RESTARTS = 10;

let resolvedPort = 0;

export function getOpenCodePort(): number {
  return resolvedPort;
}

export function spawnOpenCodeServe(
  opencodeBin: string,
  opencodePort: number,
  userlandDir: string,
  cleanEnv: Record<string, string>,
) {
  // Use port 0 to let the OS pick an available port
  console.log(`Spawning opencode serve in ${userlandDir}`);
  const child = spawn(opencodeBin, ["serve", "--port", "0"], {
    cwd: userlandDir,
    env: cleanEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  child.stdout?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    console.log(`[opencode-serve] ${text}`);
    // Parse actual port from output: "opencode server listening on http://127.0.0.1:XXXXX"
    const match = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (match && !resolvedPort) {
      resolvedPort = parseInt(match[1], 10);
      console.log(`[opencode-serve] resolved to port ${resolvedPort}`);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    console.error(`[opencode-serve] ${data.toString().trim()}`);
  });

  child.on("exit", (code) => {
    if (shuttingDown) return;
    opencodeRestarts++;
    if (opencodeRestarts > MAX_RESTARTS) {
      console.error("[opencode-serve] too many restarts, giving up");
      return;
    }
    const delay = Math.min(2000 * opencodeRestarts, 30000);
    console.log(`[opencode-serve] exited (code ${code}), restarting in ${delay}ms...`);
    setTimeout(() => spawnOpenCodeServe(opencodeBin, opencodePort, userlandDir, cleanEnv), delay);
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
    try {
      const res = await fetch(`http://127.0.0.1:${opencodePort}/event`, {
        headers: { Accept: "text/event-stream" },
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
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

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
      }

      pump().catch(() => {}).finally(() => {
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

export async function proxySSE(
  req: IncomingMessage,
  res: ServerResponse,
  targetPath: string,
  opencodePort: number,
) {
  const url = `http://127.0.0.1:${opencodePort}${targetPath}`;

  try {
    const upstream = await fetch(url, {
      headers: { Accept: "text/event-stream" },
    });

    if (!upstream.ok || !upstream.body) {
      res.writeHead(upstream.status);
      res.end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    async function pump() {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
      res.end();
    }

    pump().catch(() => res.end());

    req.on("close", () => {
      reader.cancel();
    });
  } catch {
    res.writeHead(502);
    res.end();
  }
}
