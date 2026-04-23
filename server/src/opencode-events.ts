// Browser-facing chat event stream. We maintain a single upstream subscription
// to opencode's /event SSE endpoint (in opencode-manager) and fan out to N
// registered browser clients. This lets us inject server-originated synthetic
// events (e.g. from stderr pattern matches in #203) alongside proxied ones —
// the previous per-client pass-through didn't allow that.

import type { IncomingMessage, ServerResponse } from "node:http";

type SyntheticEvent = { type: string; properties?: Record<string, unknown> };

const clients = new Set<ServerResponse>();

export function attachChatEventClient(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  clients.add(res);
  req.on("close", () => {
    clients.delete(res);
  });
}

export function broadcastRaw(chunk: string) {
  for (const res of clients) {
    try { res.write(chunk); } catch { /* client gone; will be removed on close */ }
  }
}

export function broadcastSynthetic(event: SyntheticEvent) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  broadcastRaw(payload);
}
