import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  createSession,
  sendMessage,
  subscribeToEvents,
  loadMessages,
  replyToQuestion,
  type ChatEvent,
} from "../data/chat-api";

const placeholders = [
  "What are you working on?",
  "Build something...",
  "What's on your mind?",
  "Start with an idea...",
  "What do you need?",
  "Describe what you're building...",
];

const taglines = [
  { dim: "Go on,", bright: "open the shell." },
  { dim: "Your next idea", bright: "is waiting." },
  { dim: "The pearl", bright: "won't find itself." },
  { dim: "Still thinking?", bright: "Good. Type it." },
  { dim: "One prompt away", bright: "from something great." },
  { dim: "Don't be shy.", bright: "The shell listens." },
];

interface QuestionOption {
  label: string;
  description: string;
}

interface PendingQuestion {
  id: string;
  question: string;
  options: QuestionOption[];
}

interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  question?: PendingQuestion;
}

interface Props {
  onOpenTerminal: () => void;
  isHero?: boolean;
}

export function ChatBar({ onOpenTerminal, isHero: isHeroProp }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tagline, setTagline] = useState<{ dim: string; bright: string } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const taglineIndexRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const placeholder = useMemo(() => placeholders[Math.floor(Math.random() * placeholders.length)], []);
  const inputRef = useRef<HTMLInputElement>(null);
  const isHero = !!isHeroProp;

  // Track current assistant message being streamed
  const currentAssistantMsg = useRef<string | null>(null);
  // Track text parts by partID for delta accumulation
  const textParts = useRef<Map<string, string>>(new Map());

  // Parse session ID from URL if present (/session/:id)
  function getSessionIdFromUrl(): string | null {
    const match = window.location.pathname.match(/^\/session\/(.+)$/);
    return match ? match[1] : null;
  }

  // Initialize session: fresh on home (/), restore on session URL (/session/:id)
  useEffect(() => {
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
        console.error("Failed to init chat session:", err);
      }
    }

    init();

    // Listen for browser back/forward navigation
    function handlePopState() {
      const urlSid = getSessionIdFromUrl();
      if (!urlSid) {
        // Navigated back to home — reset to fresh state
        setMessages([]);
        setExpanded(false);
        setSessionId(null);
        createSession().then((s) => setSessionId(s.id)).catch(console.error);
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Subscribe to SSE events once we have a session
  useEffect(() => {
    if (!sessionId) return;

    const unsubscribe = subscribeToEvents((event: ChatEvent) => {
      const props = event.properties;

      // Only handle events for our session
      const eventSessionId =
        (props.sessionID as string) ||
        (props.info as { sessionID?: string })?.sessionID ||
        (props.part as { sessionID?: string })?.sessionID;
      if (eventSessionId && eventSessionId !== sessionId) return;

      switch (event.type) {
        case "session.status": {
          const status = props.status as { type: string };
          if (status.type === "busy") {
            setStreaming(true);
            setStatusText("thinking...");
          } else if (status.type === "idle") {
            setStreaming(false);
            setStatusText("");
            currentAssistantMsg.current = null;
            textParts.current.clear();
          }
          break;
        }

        case "message.updated": {
          const info = props.info as {
            id: string;
            role: string;
            sessionID: string;
          };
          if (info.role === "assistant" && !currentAssistantMsg.current) {
            currentAssistantMsg.current = info.id;
            setMessages((prev) => [...prev, { id: info.id, role: "assistant", content: "" }]);
          }
          break;
        }

        case "message.part.delta": {
          const messageId = props.messageID as string;
          const partId = props.partID as string;
          const field = props.field as string;
          const delta = props.delta as string;

          // Only accumulate deltas for the current assistant message
          if (field === "text" && messageId === currentAssistantMsg.current) {
            const current = textParts.current.get(partId) || "";
            const updated = current + delta;
            textParts.current.set(partId, updated);

            // Build full content from all text parts for this message
            const fullContent = Array.from(textParts.current.values()).join("");

            setMessages((prev) => {
              const msgs = [...prev];
              const lastIdx = msgs.length - 1;
              if (lastIdx >= 0 && msgs[lastIdx].role === "assistant") {
                msgs[lastIdx] = { ...msgs[lastIdx], content: fullContent };
              }
              return msgs;
            });

            // Update status with latest chunk
            if (delta.trim()) {
              setStatusText(delta.trim().slice(0, 40) + "...");
            }
          }
          break;
        }

        case "message.part.updated": {
          const part = props.part as {
            type: string;
            text?: string;
            id: string;
          };
          if (part.type === "text" && part.text !== undefined) {
            textParts.current.set(part.id, part.text);
          }
          break;
        }

        case "question.asked": {
          const q = props as {
            id: string;
            questions: Array<{ question: string; options: QuestionOption[] }>;
          };
          if (q.questions?.length > 0) {
            const first = q.questions[0];
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: first.question,
                question: {
                  id: q.id,
                  question: first.question,
                  options: first.options,
                },
              },
            ]);
            setStatusText("waiting for your choice...");
          }
          break;
        }
      }
    });

    return unsubscribe;
  }, [sessionId]);

  useEffect(() => {
    if (expanded) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, expanded]);

  const hasPushedUrl = useRef(false);

  const handleSend = useCallback(async () => {
    if (!input.trim() || streaming || !sessionId) return;
    const content = input;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content }]);
    setStreaming(true);
    setExpanded(true);
    setStatusText("thinking...");

    // Push session URL on first message so refresh reloads this conversation
    if (!hasPushedUrl.current) {
      window.history.pushState(null, "", `/session/${sessionId}`);
      hasPushedUrl.current = true;
    }

    // Reset text parts tracking for new response
    textParts.current.clear();
    currentAssistantMsg.current = null;

    try {
      await sendMessage(sessionId, content);
    } catch (err) {
      console.error("Failed to send message:", err);
      setStreaming(false);
      setStatusText("");
    }
  }, [input, streaming, sessionId]);

  return (
    <div className={`chatbar-wrapper ${isHero ? "chatbar-hero" : ""}`}>
      {/* Hero tagline — fades out on focus, cycles on blur */}
      {isHero && (
        <div className={`chatbar-hero-tagline ${focused ? "tagline-hidden" : ""}`}>
          {tagline ? (
            <>
              <span className="tagline-dim">{tagline.dim}</span>{" "}
              <span className="tagline-bright">{tagline.bright}</span>
            </>
          ) : (
            <>
              <span className="tagline-dim">Tools are dead.</span>{" "}
              <span className="tagline-bright">Welcome to the shell.</span>
            </>
          )}
        </div>
      )}

      {/* Messages panel — expands upward */}
      {expanded && messages.length > 0 && (
        <div className="chatbar-messages">
          <button
            className="chatbar-collapse"
            onClick={() => setExpanded(false)}
          >
            ✕
          </button>
          {messages.map((msg, i) => (
            <div key={msg.id || i} className={`chat-bubble ${msg.role}`}>
              {msg.content || (msg.role === "assistant" && streaming ? "..." : "")}
              {msg.question && (
                <div className="question-options">
                  {msg.question.options.map((opt) => (
                    <button
                      key={opt.label}
                      className="question-option-btn"
                      onClick={async () => {
                        const qId = msg.question!.id;
                        // Remove the question from this message
                        setMessages((prev) =>
                          prev.map((m) =>
                            m.question?.id === qId
                              ? { ...m, question: undefined }
                              : m
                          )
                        );
                        // Add user's choice as a message
                        setMessages((prev) => [
                          ...prev,
                          { role: "user", content: opt.label },
                        ]);
                        try {
                          await replyToQuestion(qId, [[opt.label]]);
                        } catch (err) {
                          console.error("Failed to reply to question:", err);
                        }
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Input bar */}
      <div className="chatbar-bar">
        <div
          className="chatbar-oyster"
          onClick={onOpenTerminal}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="currentColor"
            stroke="none"
          >
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
        </div>
        {streaming && statusText ? (
          <div className="chatbar-status">{statusText}</div>
        ) : null}
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          onFocus={() => {
            setFocused(true);
          }}
          onBlur={() => {
            if (!input.trim()) {
              setFocused(false);
              setTagline(taglines[taglineIndexRef.current % taglines.length]);
              taglineIndexRef.current++;
            }
          }}
          placeholder={isHero && !focused ? "" : placeholder}
          disabled={streaming}
          className="chatbar-input"
        />
        <button
          className="chatbar-send"
          onClick={handleSend}
          disabled={streaming || !input.trim()}
        >
          {streaming ? "..." : "↑"}
        </button>
      </div>

    </div>
  );
}
