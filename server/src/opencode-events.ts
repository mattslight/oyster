// Browser-facing chat event stream. We maintain a single upstream subscription
// to opencode's /event SSE endpoint (in opencode-manager) and fan out to N
// registered browser clients. This lets us inject server-originated synthetic
// events (e.g. from stderr pattern matches in #203) alongside proxied ones —
// the previous per-client pass-through didn't allow that.

import type { IncomingMessage, ServerResponse } from "node:http";

type SyntheticEvent = { type: string; properties?: Record<string, unknown> };

const clients = new Set<ServerResponse>();

// Caller is responsible for the local-origin check (the same
// rejectIfNonLocalOrigin gate used for /api/ui/events). Chat SSE
// carries assistant output — a cross-origin page in the same browser
// must not be able to open an EventSource against it. We also don't
// set Access-Control-Allow-Origin here; the outer handler's wildcard
// header would otherwise make this world-readable.
export function attachChatEventClient(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  clients.add(res);
  req.on("close", () => {
    clients.delete(res);
  });
}

// Mirror broadcastUiEvent's leak-safe pattern in index.ts: if close
// doesn't fire cleanly, ended/destroyed responses would otherwise stay
// in the set and we'd throw on every subsequent broadcast. We also
// cap per-client buffering — chat SSE can emit many tokens per second
// during a long assistant response, so a stalled tab could otherwise
// grow Node's internal writable buffer without bound.
const MAX_CLIENT_BUFFER_BYTES = 1_000_000;

export function broadcastRaw(chunk: string) {
  for (const res of clients) {
    if (res.writableEnded || res.destroyed) {
      clients.delete(res);
      continue;
    }
    if (res.writableLength > MAX_CLIENT_BUFFER_BYTES) {
      // Client can't keep up — drop rather than grow forever.
      // EventSource in the browser will auto-reconnect.
      try { res.end(); } catch { /* best effort */ }
      clients.delete(res);
      continue;
    }
    try {
      res.write(chunk);
    } catch {
      clients.delete(res);
    }
  }
}

export function broadcastSynthetic(event: SyntheticEvent) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  broadcastRaw(payload);
}
