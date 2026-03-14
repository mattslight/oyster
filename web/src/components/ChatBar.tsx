import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { marked } from "marked";
import {
  createSession,
  sendMessage,
  subscribeToEvents,
  loadMessages,
  replyToQuestion,
  type ChatEvent,
} from "../data/chat-api";

// Configure marked for inline chat use
marked.setOptions({ breaks: true, gfm: true });

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
  spaces?: string[];
  activeSpace?: string | null;
  onSpaceChange?: (space: string | null) => void;
}

// Extract a short context hint from a tool event's state.input
function extractToolHint(part: Record<string, unknown>): string | null {
  const state = part.state as Record<string, unknown> | undefined;
  if (!state) return null;
  const input = state.input as Record<string, unknown> | undefined;
  if (!input) return null;
  // File-based tools: extract basename from file_path or path
  const filePath = (input.file_path || input.path) as string | undefined;
  if (filePath && typeof filePath === "string") {
    const name = filePath.split("/").pop() || null;
    if (name && name.length > 30) return name.slice(0, 27) + "...";
    return name;
  }
  // Glob: show pattern
  const pattern = input.pattern as string | undefined;
  if (pattern) return pattern.length > 30 ? pattern.slice(0, 27) + "..." : pattern;
  // Task/Agent: show description
  const desc = input.description as string | undefined;
  if (desc) return desc.length > 30 ? desc.slice(0, 27) + "..." : desc;
  return null;
}

export function ChatBar({ onOpenTerminal, isHero: isHeroProp, spaces = [], activeSpace, onSpaceChange }: Props) {
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
  const wrapperRef = useRef<HTMLDivElement>(null);
  const placeholder = useMemo(() => placeholders[Math.floor(Math.random() * placeholders.length)], []);
  const inputRef = useRef<HTMLInputElement>(null);
  const isHero = !!isHeroProp;

  // Track current assistant message being streamed
  const currentAssistantMsg = useRef<string | null>(null);
  // Track text parts per message: messageID → Map<partID, text>
  const textPartsMap = useRef<Map<string, Map<string, string>>>(new Map());

  // Friendly progress labels for tool names (ellipsis appended during construction)
  // OpenCode sends lowercase tool names (e.g. "read", "glob", "task")
  const toolProgress: Record<string, string> = {
    read: "reading",
    edit: "editing",
    write: "writing",
    bash: "running command",
    glob: "searching files",
    grep: "searching code",
    webfetch: "fetching",
    websearch: "searching the web",
    task: "delegating",
  };

  // Parse session ID from URL if present (/session/:id)
  function getSessionIdFromUrl(): string | null {
    const match = window.location.pathname.match(/^\/session\/(.+)$/);
    return match ? match[1] : null;
  }

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
      if (!urlSid) {
        // Navigated back to home — reset to fresh state
        setMessages([]);
        setExpanded(false);
        setSessionId(null);
        createSession().then((s) => setSessionId(s.id)).catch(console.error);
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      clearTimeout(retryTimer);
    };
  }, []);

  // Subscribe to SSE events once we have a session
  useEffect(() => {
    if (!sessionId) return;

    const unsubscribe = subscribeToEvents((event: ChatEvent) => {
      const props = event.properties;

      // Debug: log events, filtering out noisy ones (heartbeat, deltas, diffs)
      const noisy = new Set(["message.part.delta", "server.heartbeat", "session.diff", "session.updated"]);
      if (!noisy.has(event.type)) {
        console.log("[oyster-event]", event.type, JSON.stringify(props).slice(0, 200));
      }

      // Only handle events for our session
      const eventSessionId =
        (props.sessionID as string) ||
        (props.info as { sessionID?: string })?.sessionID ||
        (props.part as { sessionID?: string })?.sessionID;
      const isOurSession = !eventSessionId || eventSessionId === sessionId;
      // Allow tool progress events from sub-agents to update status bar,
      // but filter everything else to our session only
      const isToolEvent = event.type === "message.part.updated" &&
        (props.part as { type?: string })?.type === "tool";
      if (!isOurSession && !isToolEvent) return;

      switch (event.type) {
        case "session.status": {
          const status = props.status as { type: string };
          if (status.type === "busy") {
            setStreaming(true);
            setStatusText("thinking...");
          } else if (status.type === "idle") {
            setStreaming(false);
            setStatusText("");
          }
          break;
        }

        case "message.updated": {
          const info = props.info as {
            id: string;
            role: string;
            sessionID: string;
          };
          if (info.role === "assistant") {
            // Always track the latest assistant message
            currentAssistantMsg.current = info.id;
            // Add to messages if not already present
            setMessages((prev) => {
              if (prev.some((m) => m.id === info.id)) return prev;
              return [...prev, { id: info.id, role: "assistant", content: "" }];
            });
          }
          break;
        }

        case "message.part.delta": {
          const messageId = props.messageID as string;
          const partId = props.partID as string;
          const field = props.field as string;
          const delta = props.delta as string;

          if (field === "text") {
            // Get or create part map for this message
            if (!textPartsMap.current.has(messageId)) {
              textPartsMap.current.set(messageId, new Map());
            }
            const parts = textPartsMap.current.get(messageId)!;
            const current = parts.get(partId) || "";
            parts.set(partId, current + delta);

            // Build full content from all text parts for this message
            const fullContent = Array.from(parts.values()).join("");

            setMessages((prev) => {
              // Create the message entry if it doesn't exist yet
              if (!prev.some((m) => m.id === messageId)) {
                return [...prev, { id: messageId, role: "assistant", content: fullContent }];
              }
              return prev.map((m) =>
                m.id === messageId ? { ...m, content: fullContent } : m
              );
            });

            // Update status with latest chunk
            if (delta.trim()) {
              setStatusText(delta.trim().slice(0, 40) + "...");
            }
          }
          break;
        }

        case "message.part.updated": {
          const partMsgId = props.messageID as string;
          const part = props.part as {
            type: string;
            text?: string;
            id: string;
            toolName?: string;
            name?: string;
            tool?: string;
          };
          if (part.type === "text" && part.text !== undefined) {
            if (!textPartsMap.current.has(partMsgId)) {
              textPartsMap.current.set(partMsgId, new Map());
            }
            textPartsMap.current.get(partMsgId)!.set(part.id, part.text);
          }
          // Show tool progress — extract tool name from whichever field OpenCode uses
          const tool = part.toolName || part.name || part.tool;
          if (tool && part.type !== "text") {
            const toolKey = tool.toLowerCase();
            const label = toolProgress[toolKey] || "working";
            const hint = toolKey === "bash" ? null : extractToolHint(part as Record<string, unknown>);
            setStatusText(hint ? `${label} ${hint}...` : `${label}...`);
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

  // Click outside chatbar collapses the messages panel
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (expanded && wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [expanded]);

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

    // Reset tracking for new response
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
    <div ref={wrapperRef} className={`chatbar-wrapper ${isHero ? "chatbar-hero" : ""}`}>
      {/* Hero tagline — only shows before any messages, fades on focus */}
      {isHero && messages.length === 0 && (
        <div className={`chatbar-hero-tagline ${focused ? "tagline-hidden" : ""}`}>
          {tagline ? (
            <>
              <span className="tagline-dim">{tagline.dim}</span>{" "}
              <span className="tagline-bright">{tagline.bright}</span>
            </>
          ) : (
            <>
              <span className="tagline-dim">Tools are dead.</span>{" "}
              <span className="tagline-bright">Welcome to the surface.</span>
            </>
          )}
        </div>
      )}

      {/* Messages panel — expands upward */}
      {messages.length > 0 && (
        <div className={`chatbar-messages ${expanded ? "chat-expanded" : "chat-collapsed"}`}>
          <button
            className="chatbar-collapse"
            onClick={() => setExpanded(false)}
          >
            ✕
          </button>
          {messages.filter((msg) => msg.content || msg.question || msg.role === "user").map((msg, i) => (
            <div key={msg.id || i} className={`chat-bubble ${msg.role}`}>
              {msg.role === "assistant" && msg.content ? (
                <div className="chat-markdown" dangerouslySetInnerHTML={{ __html: marked.parse(msg.content) as string }} />
              ) : (
                msg.content
              )}
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
                        // Show immediate progress feedback
                        setStreaming(true);
                        setStatusText("thinking...");
                        currentAssistantMsg.current = null;
                        try {
                          await replyToQuestion(qId, [[opt.label]]);
                        } catch (err) {
                          console.error("Failed to reply to question:", err);
                          setStreaming(false);
                          setStatusText("");
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
      <div className="chatbar-bar" onClick={() => { if (messages.length > 0 && !expanded) setExpanded(true); }}>
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
            if (messages.length > 0) setExpanded(true);
          }}
          onBlur={() => {
            if (!input.trim()) {
              setFocused(false);
              setTagline(taglines[taglineIndexRef.current % taglines.length]);
              taglineIndexRef.current++;
            }
          }}
          placeholder={streaming ? "" : (isHero && !focused ? "" : placeholder)}
          disabled={streaming}
          className={`chatbar-input ${streaming ? "chatbar-input-streaming" : ""}`}
        />
        <button
          className="chatbar-send"
          onClick={handleSend}
          disabled={streaming || !input.trim()}
        >
          {streaming ? "..." : "↑"}
        </button>
      </div>

      {/* Space pills — always below the input */}
      {spaces.length > 0 && (
        <div className="space-pills-inline">
          <div className="space-pills">
            <button
              className={`space-pill ${!activeSpace ? "active" : ""}`}
              onClick={() => onSpaceChange?.(null)}
            >
              home
            </button>
            {spaces.map((s) => (
              <button
                key={s}
                className={`space-pill ${activeSpace === s ? "active" : ""}`}
                onClick={() => onSpaceChange?.(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
