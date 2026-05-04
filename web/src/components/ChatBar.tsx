import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { sendMessage, replyToQuestion, formatChatError, ChatSendError } from "../data/chat-api";
import { useChatSession } from "../hooks/useChatSession";
import { useChatEvents } from "../hooks/useChatEvents";
import type { ToolPart } from "../hooks/useChatSession";
import type { Space } from "../../../shared/types";
import type { Artifact } from "../data/artifacts-api";

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

const SLASH_COMMANDS = [
  { cmd: "/s", args: "<prefix>", desc: "Switch space", example: "/s bf → blunderfixer" },
  { cmd: "/o", args: "<search>", desc: "Open artifact", example: "/o competitor analysis" },
  { cmd: "/p", args: "<artefact>", desc: "Publish artifact", example: "/p competitor analysis" },
  { cmd: "#", args: "<space>", desc: "Quick switch", example: "#bf · #all · #archived" },
];

interface Props {
  onOpenTerminal: () => void;
  isHero?: boolean;
  spaces?: Space[];
  activeSpace?: string;
  onSpaceChange?: (space: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  artifacts?: Artifact[];
  onArtifactOpen?: (artifact: Artifact) => void;
  onArtifactPublish?: (artifact: Artifact) => void;
  isFirstRun?: boolean;
  onAiError?: (message: string | null) => void;
}

export function ChatBar({ onOpenTerminal, isHero: isHeroProp, spaces = [], activeSpace, onSpaceChange, inputRef: externalInputRef, artifacts = [], onArtifactOpen, onArtifactPublish, isFirstRun, onAiError }: Props) {
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [focused, setFocused] = useState(false);
  const [tagline, setTagline] = useState<{ dim: string; bright: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const taglineIndexRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const localInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef || localInputRef;
  const [placeholder, setPlaceholder] = useState(() => placeholders[Math.floor(Math.random() * placeholders.length)]);
  const placeholderIndexRef = useRef(0);
  const isHero = !!isHeroProp;

  const { messages, setMessages, sessionId, expanded, setExpanded, pushSessionUrl } = useChatSession();

  // Compute slash autocomplete items
  const subseq = useCallback((query: string, target: string) => {
    let qi = 0;
    for (let ti = 0; ti < target.length && qi < query.length; ti++) {
      if (target[ti] === query[qi]) qi++;
    }
    return qi === query.length;
  }, []);

  const scoreArtifacts = useCallback((query: string) => {
    const tokens = query.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    return artifacts.map(a => {
      let score = 0;
      const label = a.label.toLowerCase();
      const id = a.id.toLowerCase();
      const space = a.spaceId.toLowerCase();
      for (const t of tokens) {
        if (label.includes(t)) score += 5;
        else if (subseq(t, label)) score += 3;
        if (id.includes(t)) score += 4;
        if (space.startsWith(t) || subseq(t, space)) score += 10;
      }
      if (a.spaceId === activeSpace) score += 3;
      return { a, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  }, [artifacts, activeSpace, subseq]);

  const publishableArtifacts = useMemo(
    () => artifacts.filter((a) => !a.builtin && !a.plugin && a.status !== "generating"),
    [artifacts],
  );

  const slashItems = useMemo(() => {
    const lower = input.toLowerCase().trim();

    // # prefix — space switcher. Home is the unscoped feed (sessions arc
     // collapsed `#all` into Home — see #252). The `__all__` id stays only
     // as a defensive entry for old URL bookmarks; not surfaced in
     // autocomplete.
    if (input.startsWith("#")) {
      const q = lower.slice(1);
      const userSpaces = spaces.filter(s => s.id !== "home");
      const ordered = [
        { id: "home", displayName: "Home", hint: "#." },
        ...userSpaces.map((s, i) => ({ ...s, hint: `#${i + 1}` })),
        { id: "__archived__", displayName: "Archived", hint: "#archived" },
      ];
      return ordered
        .filter(s => !q || s.id.startsWith(q) || s.displayName.toLowerCase().startsWith(q) || (q.startsWith("arch") && s.id === "__archived__") || subseq(q, s.id) || subseq(q, s.displayName.toLowerCase()))
        .slice(0, 8)
        .map(s => ({ key: s.id, label: s.displayName, desc: s.hint, type: "space" as const }));
    }

    if (!input.startsWith("/")) return [];

    // /s prefix — space switcher (alias for #)
    const spaceArgMatch = lower.match(/^\/s(\s+(.*))?$/);
    if (spaceArgMatch !== null && (lower === "/s" || lower.startsWith("/s "))) {
      const q = (spaceArgMatch[2] || "").trim();
      return spaces
        .filter(s => !q || s.id.startsWith(q) || s.displayName.toLowerCase().startsWith(q) || subseq(q, s.id) || subseq(q, s.displayName.toLowerCase()))
        .slice(0, 8)
        .map(s => ({ key: s.id, label: s.displayName, desc: s.id, type: "space" as const }));
    }

    // /o prefix — artifact opener with token scoring
    const artifactArgMatch = lower.match(/^\/o(\s+(.*))?$/);
    if (artifactArgMatch !== null && (lower === "/o" || lower.startsWith("/o "))) {
      const q = (artifactArgMatch[2] || "").trim();
      if (!q) {
        const sorted = [...artifacts].sort((a, b) => {
          if (a.spaceId === activeSpace && b.spaceId !== activeSpace) return -1;
          if (b.spaceId === activeSpace && a.spaceId !== activeSpace) return 1;
          return a.label.localeCompare(b.label);
        });
        return sorted.slice(0, 8).map(a => ({ key: a.id, label: a.label, desc: a.spaceId, type: "artifact" as const, score: 0 }));
      }
      return scoreArtifacts(q).slice(0, 8).map(x => ({ key: x.a.id, label: x.a.label, desc: x.a.spaceId, type: "artifact" as const, score: x.score }));
    }

    // /p prefix — artifact publisher with token scoring
    const publishArgMatch = lower.match(/^\/p(\s+(.*))?$/);
    if (publishArgMatch !== null && (lower === "/p" || lower.startsWith("/p "))) {
      const q = (publishArgMatch[2] || "").trim();
      if (!q) {
        return publishableArtifacts.slice(0, 8).map(a => ({ key: a.id, label: a.label, desc: a.spaceId, type: "publish-artifact" as const, score: 0 }));
      }
      const allowed = new Set(publishableArtifacts.map((a) => a.id));
      return scoreArtifacts(q)
        .filter(({ a }) => allowed.has(a.id))
        .slice(0, 8)
        .map(x => ({ key: x.a.id, label: x.a.label, desc: x.a.spaceId, type: "publish-artifact" as const, score: x.score }));
    }

    // / prefix — command list
    if (!input.includes(" ") && lower !== "/s") {
      return SLASH_COMMANDS
        .filter(c => c.cmd.startsWith(lower))
        .map(c => ({ key: c.cmd, label: c.cmd, args: c.args, desc: c.desc, type: "command" as const }));
    }

    return [];
  }, [input, spaces, subseq, artifacts, activeSpace, scoreArtifacts, publishableArtifacts]);

  const slashOpen = slashItems.length > 0;

  // Reset index when items change
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setSlashIndex(0); }, [slashItems.length]);
  const { resetTracking } = useChatEvents({ sessionId, setMessages, setStreaming, setStatusText, setAiError: onAiError });

  // Clear any stale AI error when switching sessions — banner shouldn't leak across conversations.
  useEffect(() => {
    onAiError?.(null);
  }, [sessionId, onAiError]);

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

  const handleSend = useCallback(async (override?: string) => {
    const raw = override ?? input;
    if (!raw.trim() || streaming || !sessionId) return;
    const content = raw;

    // ── # commands — instant space switch, no LLM call ──
    if (content.trim().startsWith("#") && onSpaceChange) {
      setInput("");
      const q = content.trim().slice(1).toLowerCase();

      // Special: #. and #0 both go to Home (the unscoped feed). Pre-0.5.0
      // #0 meant the All meta-space; that collapsed into Home with #252
      // but the muscle-memory shortcut still works.
      if (q === "." || q === "0") { onSpaceChange("home"); return; }

      // Positional: #1 to #N = spaces in pill order (excluding home)
      const positional = q.match(/^(\d+)$/);
      if (positional) {
        const idx = parseInt(positional[1], 10);
        const userSpaces = spaces.filter(s => s.id !== "home");
        if (idx >= 1 && idx <= userSpaces.length) {
          onSpaceChange(userSpaces[idx - 1].id);
          return;
        }
      }

      // Named: #all → home (alias), #archived → __archived__, #bf → blunderfixer
      if (q === "all") { onSpaceChange("home"); return; }
      if (q === "archived") { onSpaceChange("__archived__"); return; }
      const match = spaces.find(s => s.id === q)
        || spaces.find(s => s.id.startsWith(q))
        || spaces.find(s => s.displayName.toLowerCase().startsWith(q))
        || spaces.find(s => subseq(q, s.id))
        || spaces.find(s => subseq(q, s.displayName.toLowerCase()));
      if (match) {
        onSpaceChange(match.id);
      } else {
        const available = spaces.map(s => s.id).join(", ");
        setMessages(prev => [...prev, { role: "assistant", content: `No space matching "${q}". Available: ${available}` }]);
        setExpanded(true);
      }
      return;
    }

    // ── / slash commands — instant, no LLM call ──
    // Nothing starting with "/" ever reaches the AI.
    if (content.trim().startsWith("/")) {
      setInput("");
      const slashMatch = content.trim().match(/^\/([a-z])\s+(.+)$/i);
      if (slashMatch) {
        const [, cmd, arg] = slashMatch;
        const q = arg.trim().toLowerCase();

        if (cmd === "s" && onSpaceChange) {
          if (q === "all") { onSpaceChange("home"); return; }
          const match = spaces.find(s => s.id === q)
            || spaces.find(s => s.id.startsWith(q))
            || spaces.find(s => s.displayName.toLowerCase().startsWith(q))
            || spaces.find(s => subseq(q, s.id))
            || spaces.find(s => subseq(q, s.displayName.toLowerCase()));
          if (match) {
            onSpaceChange(match.id);
          } else {
            const available = spaces.map(s => s.id).join(", ");
            setMessages(prev => [...prev, { role: "assistant", content: `No space matching "${arg.trim()}". Available: ${available}` }]);
            setExpanded(true);
          }
        }

        if (cmd === "o" && onArtifactOpen) {
          const scored = scoreArtifacts(q);

          if (scored.length === 0) {
            setMessages(prev => [...prev, { role: "assistant", content: `No artifact matching "${arg.trim()}"` }]);
            setExpanded(true);
          } else if (scored.length === 1 || scored[0].score >= scored[1].score * 2) {
            onArtifactOpen(scored[0].a);
          } else {
            setInput(`/o ${arg.trim()}`);
            return; // keep input, don't clear — dropdown stays open
          }
        }

        if (cmd === "p" && onArtifactPublish) {
          const allowed = new Set(publishableArtifacts.map((a) => a.id));
          const scored = scoreArtifacts(q).filter(({ a }) => allowed.has(a.id));
          if (scored.length === 0) {
            setMessages(prev => [...prev, { role: "assistant", content: `No artifact matching "${arg.trim()}"` }]);
            setExpanded(true);
          } else if (scored.length === 1 || scored[0].score >= scored[1].score * 2) {
            onArtifactPublish(scored[0].a);
          } else {
            setInput(`/p ${arg.trim()}`);
            return; // keep input, don't clear — dropdown stays open
          }
        }
      }
      return;
    }

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content }]);
    setStreaming(true);
    setExpanded(true);
    setStatusText("thinking...");
    onAiError?.(null);

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
      const msg = err instanceof ChatSendError
        ? formatChatError("http", err.status, err.body)
        : "Can't reach Oyster — check that the server is running";
      onAiError?.(msg);
    }
  }, [input, streaming, sessionId, setMessages, setExpanded, pushSessionUrl, resetTracking, spaces, onSpaceChange, subseq, artifacts, activeSpace, onArtifactOpen, scoreArtifacts, onAiError]);

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
      {/* Hero tagline — one block, three states */}
      {/* Hidden when the input is focused OR once any chat message exists,
          so it doesn't reappear behind streamed output if the user clicks
          out of the input. */}
      {isHero && (() => {
        const taglineHidden = focused || messages.length > 0;
        return (
        <div
          className={`chatbar-hero-tagline${taglineHidden ? " tagline-hidden" : ""}`}
          aria-hidden={taglineHidden || undefined}
        >
          {isFirstRun ? (
            <>
              <span className="tagline-bright">Welcome to your surface.</span>
              <div className="chatbar-hero-sub">
                Ask:{" "}
                <button
                  type="button"
                  className="chatbar-hero-prompt"
                  onClick={() => handleSend("Set up Oyster")}
                  disabled={!sessionId || streaming}
                  tabIndex={taglineHidden ? -1 : 0}
                  title="Click to send, or type it yourself"
                >
                  Set up Oyster
                </button>
              </div>
            </>
          ) : tagline ? (
            <>
              <span className="tagline-dim">{tagline.dim}</span>{" "}
              <span className="tagline-bright">{tagline.bright}</span>
            </>
          ) : (
            <>
              <span className="tagline-dim">Apps are dead.</span>{" "}
              <span className="tagline-bright">Welcome to your surface.</span>
            </>
          )}
        </div>
        );
      })()}

      {/* Messages panel — expands upward */}
      {messages.length > 0 && (
        <div className={`chatbar-messages ${expanded ? "chat-expanded" : "chat-collapsed"}${slashOpen ? " slash-dimmed" : ""}`}>
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
        {/* Slash command autocomplete — floats above input */}
        {slashOpen && (
          <div className="slash-autocomplete">
            {slashItems.map((item, i) => (
              <button
                key={item.key}
                className={`slash-autocomplete-item${i === slashIndex ? " active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (item.type === "space") { setInput(""); onSpaceChange?.(item.key); }
                  else if (item.type === "artifact") { setInput(""); const a = artifacts.find(x => x.id === item.key); if (a) onArtifactOpen?.(a); }
                  else if (item.type === "publish-artifact") { setInput(""); const a = artifacts.find(x => x.id === item.key); if (a) onArtifactPublish?.(a); }
                  else { setInput(item.label + ("args" in item && item.args ? " " : "")); inputRef.current?.focus(); }
                }}
                onMouseEnter={() => setSlashIndex(i)}
              >
                <span className="slash-cmd">{item.label}</span>
                {"args" in item && item.args && <span className="slash-args">{item.args}</span>}
                <span className="slash-desc">{item.desc}</span>
              </button>
            ))}
          </div>
        )}
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
          onChange={(e) => {
            const val = e.target.value;
            // Instant space switch for #0-#9 and #. (unambiguous — space names can't start with digit or dot)
            if (onSpaceChange && /^#[0-9.]$/.test(val)) {
              const ch = val[1];
              if (ch === "." || ch === "0") { setInput(""); onSpaceChange("home"); return; }
              const idx = parseInt(ch, 10);
              const userSpaces = spaces.filter(s => s.id !== "home");
              if (idx >= 1 && idx <= userSpaces.length) { setInput(""); onSpaceChange(userSpaces[idx - 1].id); return; }
            }
            setInput(val);
          }}
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex(i => Math.min(i + 1, slashItems.length - 1)); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSlashIndex(i => Math.max(i - 1, 0)); return; }
              if (e.key === "Tab") {
                // Tab = complete the current text to the highlighted item,
                // don't execute. User can inspect what it expanded to and
                // then hit Enter to run it. Mirrors shell behaviour.
                e.preventDefault();
                const item = slashItems[slashIndex];
                if (item.type === "space") {
                  const label = item.key === "__archived__" ? "archived" : item.key;
                  setInput(`#${label}`);
                } else if (item.type === "artifact") {
                  const a = artifacts.find((x) => x.id === item.key);
                  if (a) setInput(`/o ${a.label}`);
                } else if (item.type === "publish-artifact") {
                  const a = artifacts.find((x) => x.id === item.key);
                  if (a) setInput(`/p ${a.label}`);
                } else {
                  setInput(item.label + ("args" in item && item.args ? " " : ""));
                }
                return;
              }
              if (e.key === "Enter" && slashItems[slashIndex]) {
                // Enter = execute: switch space / open artifact / begin command
                e.preventDefault();
                const item = slashItems[slashIndex];
                if (item.type === "space") { setInput(""); onSpaceChange?.(item.key); }
                else if (item.type === "artifact") { setInput(""); const a = artifacts.find(x => x.id === item.key); if (a) onArtifactOpen?.(a); }
                else if (item.type === "publish-artifact") { setInput(""); const a = artifacts.find(x => x.id === item.key); if (a) onArtifactPublish?.(a); }
                else { setInput(item.label + ("args" in item && item.args ? " " : "")); }
                return;
              }
              if (e.key === "Escape") { setInput(""); return; }
            }
            if (e.key === "Enter") handleSend();
          }}
          onFocus={() => {
            setFocused(true);
            if (messages.length > 0) setExpanded(true);
          }}
          onBlur={() => {
            if (!input.trim()) {
              setFocused(false);
              setTagline(taglines[taglineIndexRef.current % taglines.length]);
              taglineIndexRef.current++;
              setPlaceholder(placeholders[placeholderIndexRef.current % placeholders.length]);
              placeholderIndexRef.current++;
            }
          }}
          placeholder={streaming ? "" : (isHero && !focused ? "" : placeholder)}
          disabled={streaming}
          className={`chatbar-input ${streaming ? "chatbar-input-streaming" : ""}`}
        />
        <button
          className="chatbar-send"
          onClick={() => handleSend()}
          disabled={streaming || !input.trim()}
        >
          {streaming ? "..." : "↑"}
        </button>
      </div>

    </div>
  );
}
