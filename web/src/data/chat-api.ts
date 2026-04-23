const SESSION_KEY = "oyster-session-id";

export interface ChatSession {
  id: string;
  title: string;
}

export interface ChatEvent {
  type: string;
  properties: Record<string, unknown>;
}

export async function createSession(): Promise<ChatSession> {
  const res = await fetch("/api/chat/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "oyster",
      agent: "oyster",
      permission: [
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "write", pattern: "*", action: "allow" },
        { permission: "edit", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "glob", pattern: "*", action: "allow" },
        { permission: "grep", pattern: "*", action: "allow" },
        { permission: "list", pattern: "*", action: "allow" },
        { permission: "task", pattern: "*", action: "allow" },
        { permission: "todoread", pattern: "*", action: "allow" },
        { permission: "todowrite", pattern: "*", action: "allow" },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  return res.json();
}

export async function getOrCreateSession(): Promise<string> {
  const stored = localStorage.getItem(SESSION_KEY);
  if (stored) {
    // Verify the session still exists
    const res = await fetch(`/api/chat/session/${stored}`);
    if (res.ok) return stored;
  }
  const session = await createSession();
  localStorage.setItem(SESSION_KEY, session.id);
  return session.id;
}

// Shape emitted on the OpenCode SSE stream when a provider call fails.
export interface OpenCodeError {
  data?: { message?: string; statusCode?: number };
}

// Build user-facing banner text for any chat failure. Three buckets:
// auth → actionable reconnect hint; transient → retry hint; else → raw.
export function formatChatError(
  source: "http" | "stream",
  status: number | undefined,
  body: string | undefined,
): string {
  if (source === "http" && status === 502) {
    try {
      const parsed = JSON.parse(body || "{}");
      if (parsed?.error === "opencode serve unavailable") {
        return "Can't reach the AI engine — restart Oyster to recover";
      }
    } catch { /* fall through */ }
    return "AI engine unavailable — check that Oyster is running";
  }
  if (status === 401) return "AI provider auth failed — run: opencode providers login";
  if (status === 429 || (typeof status === "number" && status >= 500)) {
    return "AI provider unavailable — try again in a moment";
  }
  if (source === "http") {
    return `Couldn't send message${status ? ` (HTTP ${status})` : ""}`;
  }
  return body?.trim() || "AI request failed";
}

export class ChatSendError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`sendMessage failed: ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function sendMessage(
  sessionId: string,
  text: string
): Promise<void> {
  // Fire and forget — we get streaming updates via SSE
  // But we do await to surface network/proxy errors to the caller
  const res = await fetch(`/api/chat/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text }],
      agent: "oyster",
    }),
  });
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch { /* ignore */ }
    throw new ChatSendError(res.status, body);
  }
}

export function subscribeToEvents(
  onEvent: (event: ChatEvent) => void
): () => void {
  const es = new EventSource("/api/chat/events");

  es.onmessage = (e) => {
    try {
      const event: ChatEvent = JSON.parse(e.data);
      onEvent(event);
    } catch {
      // ignore parse errors
    }
  };

  es.onerror = () => {
    // EventSource auto-reconnects
  };

  return () => es.close();
}

export async function replyToQuestion(
  questionId: string,
  answers: string[][]
): Promise<void> {
  const res = await fetch(`/api/chat/question/${questionId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  if (!res.ok) throw new Error(`replyToQuestion failed: ${res.status}`);
}

export async function loadMessages(
  sessionId: string
): Promise<Array<{ info: { id: string; role: "user" | "assistant" }; parts: Array<Record<string, unknown>> }>> {
  const res = await fetch(`/api/chat/session/${sessionId}/message`);
  if (!res.ok) return [];
  return res.json();
}
