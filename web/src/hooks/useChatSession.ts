import { useState, useEffect, useRef } from "react";
import { createSession, loadMessages } from "../data/chat-api";
import { TOOL_LABELS, extractToolHint } from "./tool-labels";

export interface ToolPart {
  id: string;
  toolName: string;
  label: string;
  hint: string | null;
  status: "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
}

export interface MessagePart {
  type: "text" | "tool" | "reasoning";
  text?: string;
  tool?: ToolPart;
}

export interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  parts?: MessagePart[];
  question?: PendingQuestion;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface PendingQuestion {
  id: string;
  question: string;
  options: QuestionOption[];
}

function getSessionIdFromUrl(): string | null {
  const match = window.location.pathname.match(/^\/session\/(.+)$/);
  return match ? match[1] : null;
}

export function useChatSession() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const hasPushedUrl = useRef(false);

  // Initialize session: fresh on home (/), restore on session URL (/session/:id)
  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout>;

    async function init() {
      try {
        const urlSessionId = getSessionIdFromUrl();

        if (urlSessionId) {
          // Session URL — restore that session's messages
          setSessionId(urlSessionId);
          const existing = await loadMessages(urlSessionId);
          const restored: Message[] = [];
          for (const msg of existing) {
            const tp = msg.parts.filter((p: Record<string, unknown>) => p.type === "text" && p.text);
            const content = tp.map((p: Record<string, unknown>) => p.text).join("");

            // Build ordered MessagePart[] from all text + tool parts
            const msgParts: MessagePart[] = [];
            for (const p of msg.parts) {
              if (p.type === "text" && p.text) {
                msgParts.push({ type: "text", text: p.text as string });
              } else if (p.type === "tool") {
                const toolName = ((p.tool || p.toolName || p.name || "") as string).toLowerCase();
                msgParts.push({
                  type: "tool",
                  tool: {
                    id: String(p.id || p.callID || crypto.randomUUID()),
                    toolName,
                    label: TOOL_LABELS[toolName] || toolName || "working",
                    hint: extractToolHint(p as Record<string, unknown>),
                    status: "completed",
                    input: (p.state as Record<string, unknown>)?.input as Record<string, unknown> | undefined,
                    output: (p.state as Record<string, unknown>)?.output != null
                      ? String((p.state as Record<string, unknown>).output)
                      : undefined,
                  },
                });
              }
            }

            if (content || msgParts.length > 0) {
              restored.push({
                id: msg.info.id,
                role: msg.info.role,
                content: content || "",
                parts: msgParts.length > 0 ? msgParts : undefined,
              });
            }
          }
          if (restored.length > 0) {
            setMessages(restored);
            setExpanded(true);
          }
        } else {
          // Home — always create a fresh session
          const session = await createSession();
          setSessionId(session.id);
        }
      } catch (err) {
        console.error("Failed to init chat session, retrying in 3s...", err);
        retryTimer = setTimeout(init, 3000);
      }
    }

    init();

    // Listen for browser back/forward navigation
    function handlePopState() {
      const urlSid = getSessionIdFromUrl();
      if (urlSid) return; // staying on a session URL — nothing to reset

      // Navigating to home (/) or a space (/space/*) — reset chat to fresh state
      setMessages([]);
      setExpanded(false);
      setSessionId(null);
      hasPushedUrl.current = false;
      createSession().then((s) => setSessionId(s.id)).catch(console.error);
    }

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      clearTimeout(retryTimer);
    };
  }, []);

  function pushSessionUrl() {
    if (!hasPushedUrl.current && sessionId) {
      window.history.pushState(null, "", `/session/${sessionId}`);
      hasPushedUrl.current = true;
    }
  }

  return { messages, setMessages, sessionId, expanded, setExpanded, pushSessionUrl };
}
