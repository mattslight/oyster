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

export function subscribeUiEvents(listener: Listener): () => void {
  listeners.add(listener);
  if (!es) {
    es = new EventSource("/api/ui/events");
    es.onmessage = handleMessage;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && es) {
      es.close();
      es = null;
    }
  };
}
