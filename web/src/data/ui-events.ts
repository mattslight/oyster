// Shared EventSource subscription for `/api/ui/events`.
//
// Multiple components (App, OnboardingDock) care about different slices of
// the same SSE stream — a per-component `new EventSource(...)` would open
// N connections to the same endpoint and parse every message N times. This
// module opens a single connection on first subscribe and closes it when
// the last subscriber unsubscribes.

export interface UiEvent {
  command: string;
  payload: unknown;
}

type Listener = (event: UiEvent) => void;

let es: EventSource | null = null;
const listeners = new Set<Listener>();

function handleMessage(e: MessageEvent) {
  let parsed: UiEvent;
  try {
    parsed = JSON.parse(e.data) as UiEvent;
  } catch {
    return; // malformed event — drop
  }
  for (const listener of listeners) {
    try { listener(parsed); } catch { /* isolate one bad listener from others */ }
  }
}

function ensureConnection() {
  if (es && es.readyState !== EventSource.CLOSED) return;
  if (es) es.close();
  es = new EventSource("/api/ui/events");
  es.onmessage = handleMessage;
  // EventSource auto-reconnects on transport errors, but a half-open
  // connection (server crash, proxy timeout) can leave readyState stuck.
  // Force a fresh connect on error so listeners aren't silently stranded.
  es.onerror = () => {
    if (es && es.readyState === EventSource.CLOSED) {
      es = null;
      if (listeners.size > 0) ensureConnection();
    }
  };
}

// When the tab returns to the foreground, replay a synthetic event so
// any listener that refetches on, say, `session_changed` gets fresh data
// — covers the case where the OS or proxy dropped our connection while
// the tab was backgrounded and we missed real events. Cheap: each
// refetch is a small JSON GET.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    ensureConnection();
    for (const l of listeners) {
      try { l({ command: "session_changed", payload: { id: "" } }); }
      catch { /* isolate */ }
    }
  });
}

export function subscribeUiEvents(listener: Listener): () => void {
  listeners.add(listener);
  ensureConnection();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && es) {
      es.close();
      es = null;
    }
  };
}
