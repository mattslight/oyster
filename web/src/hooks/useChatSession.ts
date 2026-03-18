import { useState, useEffect, useRef } from "react";
import { createSession, loadMessages } from "../data/chat-api";

export interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
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
            const tp = msg.parts.filter((p) => p.type === "text" && p.text);
            const content = tp.map((p) => p.text).join("");
            if (content) {
              restored.push({
                id: msg.info.id,
                role: msg.info.role as "user" | "assistant",
                content,
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
