import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { spaceColor } from "../utils/spaceColor";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { sendMessage, replyToQuestion } from "../data/chat-api";
import { useChatSession } from "../hooks/useChatSession";
import { useChatEvents } from "../hooks/useChatEvents";
import type { ToolPart } from "../hooks/useChatSession";
import type { Space } from "../../../shared/types";

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

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const firstLine = text.split("\n").find((l) => l.trim()) || "thinking...";
  const summary = firstLine.replace(/^\*\*(.+)\*\*$/, "$1").slice(0, 50);

  return (
    <div className="tool-block" onClick={() => setOpen(!open)}>
      <div className="tool-block-header">
        <span className="tool-block-chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-block-summary">{summary}</span>
      </div>
      {open && (
        <div className="tool-block-details">
          <pre className="tool-block-io">{text}</pre>
        </div>
      )}
    </div>
  );
}

function ToolBlock({ tool }: { tool: ToolPart }) {
  const [open, setOpen] = useState(false);
  const isRunning = tool.status === "running";
  const summary = tool.hint ? `${tool.label} ${tool.hint}` : tool.label;

  return (
    <div className={`tool-block ${isRunning ? "tool-running" : ""}`} onClick={() => setOpen(!open)}>
      <div className="tool-block-header">
        <span className="tool-block-chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-block-summary">{summary}</span>
        {isRunning && <span className="tool-block-spinner" />}
      </div>
      {open && (
        <div className="tool-block-details">
          {tool.input && (
            <pre className="tool-block-io">{JSON.stringify(tool.input, null, 2)}</pre>
          )}
          {tool.output && (
            <pre className="tool-block-io tool-block-output">{
              tool.output.length > 2000 ? tool.output.slice(0, 2000) + "\n... (truncated)" : tool.output
            }</pre>
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  onOpenTerminal: () => void;
  isHero?: boolean;
  spaces?: Space[];
  activeSpace?: string;
  onSpaceChange?: (space: string) => void;
  onAddSpace?: () => void;
}

export function ChatBar({ onOpenTerminal, isHero: isHeroProp, spaces = [], activeSpace, onSpaceChange, onAddSpace }: Props) {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [focused, setFocused] = useState(false);
  const [tagline, setTagline] = useState<{ dim: string; bright: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const taglineIndexRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const placeholder = useMemo(() => placeholders[Math.floor(Math.random() * placeholders.length)], []);
  const isHero = !!isHeroProp;

  const { messages, setMessages, sessionId, expanded, setExpanded, pushSessionUrl } = useChatSession();
  const { resetTracking } = useChatEvents({ sessionId, setMessages, setStreaming, setStatusText });

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
  }, [expanded, setExpanded]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || streaming || !sessionId) return;
    const content = input;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content }]);
    setStreaming(true);
    setExpanded(true);
    setStatusText("thinking...");

    // Push session URL on first message so refresh reloads this conversation
    pushSessionUrl();

    // Reset tracking for new response
    resetTracking();

    try {
      await sendMessage(sessionId, content);
    } catch (err) {
      console.error("Failed to send message:", err);
      setStreaming(false);
      setStatusText("");
    }
  }, [input, streaming, sessionId, setMessages, setExpanded, pushSessionUrl, resetTracking]);

  function handleCopyChat() {
    const text = messages
      .filter((m) => m.content)
      .map((m) => `${m.role === "user" ? "You" : "Oyster"}: ${m.content}`)
      .join("\n\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

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
              <span className="tagline-bright">Welcome to your surface.</span>
            </>
          )}
        </div>
      )}

      {/* Messages panel — expands upward */}
      {messages.length > 0 && (
        <div className={`chatbar-messages ${expanded ? "chat-expanded" : "chat-collapsed"}`}>
          <div className="chatbar-actions">
            <button
              className={`chatbar-copy ${copied ? "copied" : ""}`}
              onClick={handleCopyChat}
              title="Copy chat"
            >
              {copied ? "copied" : "copy"}
            </button>
            <button
              className="chatbar-collapse"
              onClick={() => setExpanded(false)}
              title="Collapse"
            >
              ↓
            </button>
          </div>
          {messages.filter((msg) => msg.content || msg.parts?.length || msg.question || msg.role === "user").map((msg, i) => (
            <div key={msg.id || i} className={`chat-bubble ${msg.role}`}>
              {msg.role === "assistant" && msg.parts && msg.parts.length > 0 ? (
                msg.parts.map((part, pi) =>
                  part.type === "text" && part.text ? (
                    <div key={pi} className="chat-markdown" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(part.text) as string) }} />
                  ) : part.type === "tool" && part.tool ? (
                    <ToolBlock key={part.tool.id} tool={part.tool} />
                  ) : part.type === "reasoning" && part.text ? (
                    <ReasoningBlock key={pi} text={part.text} />
                  ) : null
                )
              ) : msg.role === "assistant" && msg.content ? (
                <div className="chat-markdown" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(marked.parse(msg.content) as string) }} />
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
                        setMessages((prev) =>
                          prev.map((m) =>
                            m.question?.id === qId
                              ? { ...m, question: undefined }
                              : m
                          )
                        );
                        setMessages((prev) => [
                          ...prev,
                          { role: "user", content: opt.label },
                        ]);
                        setStreaming(true);
                        setStatusText("thinking...");
                        resetTracking();
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

      {/* Space pills — below the input bar */}
      {(spaces.length > 0 || activeSpace) && onSpaceChange && (
        <div className="space-pills-inline">
          <LayoutGroup id="space-pill">
          <div className="space-pills">
            {/* Home */}
            <button className={`space-pill space-pill--icon${activeSpace === "home" ? " active" : ""}`} onClick={() => onSpaceChange("home")} title="Home" style={{ position: "relative" }}>
              {activeSpace === "home" && (
                <motion.span layoutId="space-pill-bg" className="space-pill-bg" style={{ background: "#7c6bff" }} transition={{ type: "spring", stiffness: 400, damping: 35 }} />
              )}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style={{ position: "relative", zIndex: 1 }}>
                <path d="M11.03 2.59a1.5 1.5 0 0 1 1.94 0l7.5 6.363A1.5 1.5 0 0 1 21 10.097V19.5a2.5 2.5 0 0 1-2.5 2.5H15v-4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v4H5.5A2.5 2.5 0 0 1 3 19.5v-9.403a1.5 1.5 0 0 1 .53-1.137l7.5-6.37Z"/>
              </svg>
            </button>

            {/* All */}
            <button className={`space-pill${activeSpace === "__all__" ? " active" : ""}`} onClick={() => onSpaceChange("__all__")} style={{ position: "relative" }}>
              {activeSpace === "__all__" && (
                <motion.span layoutId="space-pill-bg" className="space-pill-bg" style={{ background: "#7c6bff" }} transition={{ type: "spring", stiffness: 400, damping: 35 }} />
              )}
              <span style={{ position: "relative", zIndex: 1 }}>all</span>
            </button>

            {/* Named spaces */}
            {spaces.filter(s => s.id !== "home").map((s) => {
              const color = s.color ?? spaceColor(s.id);
              const isActive = activeSpace === s.id;
              return (
                <button key={s.id} className={`space-pill${isActive ? " active" : ""}`} onClick={() => onSpaceChange(s.id)} style={{ position: "relative" }}>
                  {isActive && (
                    <motion.span layoutId="space-pill-bg" className="space-pill-bg" style={{ background: color }} transition={{ type: "spring", stiffness: 400, damping: 35 }} />
                  )}
                  <span style={{ position: "relative", zIndex: 1 }}>{s.displayName}</span>
                </button>
              );
            })}

            {/* Add space */}
            {onAddSpace && (
              <button
                className="space-pill space-pill--add"
                onClick={onAddSpace}
                title="Add space"
                style={{ position: "relative" }}
              >
                <span style={{ position: "relative", zIndex: 1 }}>+</span>
              </button>
            )}
          </div>
          </LayoutGroup>
        </div>
      )}

    </div>
  );
}
