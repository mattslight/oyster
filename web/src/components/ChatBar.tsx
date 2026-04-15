import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, LayoutGroup } from "framer-motion";
import { spaceColor } from "../utils/spaceColor";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { sendMessage, replyToQuestion } from "../data/chat-api";
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
  { cmd: "#", args: "<space>", desc: "Quick switch", example: "#bf or #1" },
];

interface Props {
  onOpenTerminal: () => void;
  isHero?: boolean;
  spaces?: Space[];
  activeSpace?: string;
  onSpaceChange?: (space: string) => void;
  onAddSpace?: () => void;
  onSpaceUpdate?: (id: string, fields: { displayName?: string; color?: string }) => void;
  onSpaceDelete?: (id: string, folderName?: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  artifacts?: Artifact[];
  onArtifactOpen?: (artifact: Artifact) => void;
  isFirstRun?: boolean;
}

const SPACE_PALETTE = [
  "#6057c4", "#3d8aaa", "#3a8f64", "#b06840",
  "#8f5a9e", "#3a8a7a", "#9e7c2a", "#8f4a5a",
];

export function ChatBar({ onOpenTerminal, isHero: isHeroProp, spaces = [], activeSpace, onSpaceChange, onAddSpace, onSpaceUpdate, onSpaceDelete, inputRef: externalInputRef, artifacts = [], onArtifactOpen, isFirstRun }: Props) {
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

  // Space context menu
  const [ctxMenu, setCtxMenu] = useState<{ spaceId: string; rect: DOMRect } | null>(null);
  const [renaming, setRenaming] = useState<{ spaceId: string; name: string } | null>(null);
  const [showColors, setShowColors] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ctxRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // Close context menu on outside click
  useEffect(() => {
    if (!ctxMenu) return;
    function handleClick(e: MouseEvent) {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
        setShowColors(false);
        setConfirmDelete(false);
      }
    }
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [ctxMenu]);

  // Focus rename input when it appears
  useEffect(() => { renameRef.current?.focus(); }, [renaming]);

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

  const slashItems = useMemo(() => {
    const lower = input.toLowerCase().trim();

    // # prefix — space switcher
    if (input.startsWith("#")) {
      const q = lower.slice(1);
      const userSpaces = spaces.filter(s => s.id !== "home" && s.id !== "__all__");
      const ordered = [
        { id: "home", displayName: "Home", hint: "#." },
        { id: "__all__", displayName: "All", hint: "#0" },
        ...userSpaces.map((s, i) => ({ ...s, hint: `#${i + 1}` })),
      ];
      return ordered
        .filter(s => !q || s.id.startsWith(q) || s.displayName.toLowerCase().startsWith(q) || (q === "all" && s.id === "__all__") || subseq(q, s.id) || subseq(q, s.displayName.toLowerCase()))
        .slice(0, 8)
        .map(s => ({ key: s.id, label: `#${s.id === "__all__" ? "all" : s.id}`, desc: s.hint, type: "space" as const }));
    }

    if (!input.startsWith("/")) return [];

    // /s prefix — space switcher (alias for #)
    const spaceArgMatch = lower.match(/^\/s(\s+(.*))?$/);
    if (spaceArgMatch !== null && (lower === "/s" || lower.startsWith("/s "))) {
      const q = (spaceArgMatch[2] || "").trim();
      return spaces
        .filter(s => !q || s.id.startsWith(q) || s.displayName.toLowerCase().startsWith(q) || (q === "all" && s.id === "__all__") || subseq(q, s.id) || subseq(q, s.displayName.toLowerCase()))
        .slice(0, 8)
        .map(s => ({ key: s.id, label: s.id, desc: s.displayName, type: "space" as const }));
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

    // / prefix — command list
    if (!input.includes(" ") && lower !== "/s") {
      return SLASH_COMMANDS
        .filter(c => c.cmd.startsWith(lower))
        .map(c => ({ key: c.cmd, label: c.cmd, args: c.args, desc: c.desc, type: "command" as const }));
    }

    return [];
  }, [input, spaces, subseq, artifacts, activeSpace, scoreArtifacts]);

  const slashOpen = slashItems.length > 0;

  // Reset index when items change
  useEffect(() => { setSlashIndex(0); }, [slashItems.length]);
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

    // ── # commands — instant space switch, no LLM call ──
    if (content.trim().startsWith("#") && onSpaceChange) {
      setInput("");
      const q = content.trim().slice(1).toLowerCase();

      // Special: #. = home, #0 = all
      if (q === ".") { onSpaceChange("home"); return; }
      if (q === "0") { onSpaceChange("__all__"); return; }

      // Positional: #1 to #N = spaces in pill order (excluding home and all)
      const positional = q.match(/^(\d+)$/);
      if (positional) {
        const idx = parseInt(positional[1], 10);
        const userSpaces = spaces.filter(s => s.id !== "home" && s.id !== "__all__");
        if (idx >= 1 && idx <= userSpaces.length) {
          onSpaceChange(userSpaces[idx - 1].id);
          return;
        }
      }

      // Named: #all → __all__, #bf → blunderfixer
      if (q === "all") { onSpaceChange("__all__"); return; }
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
          if (q === "all") { onSpaceChange("__all__"); return; }
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
      }
      return;
    }

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
  }, [input, streaming, sessionId, setMessages, setExpanded, pushSessionUrl, resetTracking, spaces, onSpaceChange, subseq, artifacts, activeSpace, onArtifactOpen, scoreArtifacts]);

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
      {isHero && (
        <div className={`chatbar-hero-tagline${focused ? " tagline-hidden" : ""}`}>
          {isFirstRun ? (
            <>
              <span className="tagline-bright">Drop a folder to get started</span>
              <br />
              <div className="chatbar-onboarding-hint" style={{ marginTop: "8px" }}>
                We'll organise your projects into spaces
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
      )}

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
              if (ch === ".") { setInput(""); onSpaceChange("home"); return; }
              if (ch === "0") { setInput(""); onSpaceChange("__all__"); return; }
              const idx = parseInt(ch, 10);
              const userSpaces = spaces.filter(s => s.id !== "home" && s.id !== "__all__");
              if (idx >= 1 && idx <= userSpaces.length) { setInput(""); onSpaceChange(userSpaces[idx - 1].id); return; }
            }
            setInput(val);
          }}
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSlashIndex(i => Math.min(i + 1, slashItems.length - 1)); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSlashIndex(i => Math.max(i - 1, 0)); return; }
              if (e.key === "Tab" || (e.key === "Enter" && slashItems[slashIndex])) {
                e.preventDefault();
                const item = slashItems[slashIndex];
                if (item.type === "space") { setInput(""); onSpaceChange?.(item.key); }
                else if (item.type === "artifact") { setInput(""); const a = artifacts.find(x => x.id === item.key); if (a) onArtifactOpen?.(a); }
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
              <span style={{ position: "relative", zIndex: 1 }}>All</span>
            </button>

            {/* Named spaces */}
            {spaces.filter(s => s.id !== "home").map((s) => {
              const color = s.color ?? spaceColor(s.id);
              const isActive = activeSpace === s.id;
              const isRenaming = renaming?.spaceId === s.id;
              return (
                <button
                  key={s.id}
                  className={`space-pill${isActive ? " active" : ""}`}
                  onClick={() => !isRenaming && onSpaceChange?.(s.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setCtxMenu({ spaceId: s.id, rect });
                    setShowColors(false);
                    setConfirmDelete(false);
                    setRenaming(null);
                  }}
                  style={{ position: "relative" }}
                >
                  {isActive && (
                    <motion.span layoutId="space-pill-bg" className="space-pill-bg" style={{ background: color }} transition={{ type: "spring", stiffness: 400, damping: 35 }} />
                  )}
                  {isRenaming ? (
                    <input
                      ref={renameRef}
                      className="space-pill-rename"
                      value={renaming.name}
                      onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && renaming.name.trim()) {
                          onSpaceUpdate?.(s.id, { displayName: renaming.name.trim() });
                          setRenaming(null);
                        }
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={() => {
                        if (renaming.name.trim() && renaming.name.trim() !== s.displayName) {
                          onSpaceUpdate?.(s.id, { displayName: renaming.name.trim() });
                        }
                        setRenaming(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span style={{ position: "relative", zIndex: 1 }}>{s.displayName}</span>
                  )}
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

      {/* Onboarding hint */}
      {isFirstRun && isHero && (
        <div className="chatbar-onboarding-hint">
          or click <code>+</code> to add your projects
        </div>
      )}

      {/* Space context menu — portaled to body to escape transforms */}
      {ctxMenu && createPortal(
        <div
          ref={ctxRef}
          className="space-ctx-menu"
          style={{ left: ctxMenu.rect.left + ctxMenu.rect.width / 2, top: ctxMenu.rect.top }}
        >
          {!showColors && !confirmDelete && (
            <>
              <button className="space-ctx-item" onClick={() => {
                const s = spaces.find(sp => sp.id === ctxMenu.spaceId);
                if (s) setRenaming({ spaceId: s.id, name: s.displayName });
                setCtxMenu(null);
              }}>
                Rename
              </button>
              <button className="space-ctx-item" onClick={() => setShowColors(true)}>
                Color
              </button>
              <div className="space-ctx-sep" />
              <button className="space-ctx-item space-ctx-delete" onClick={() => setConfirmDelete(true)}>
                Remove
              </button>
            </>
          )}
          {showColors && (
            <div className="space-ctx-colors">
              {SPACE_PALETTE.map((c) => (
                <button
                  key={c}
                  className="space-ctx-swatch"
                  style={{ background: c }}
                  onClick={() => {
                    onSpaceUpdate?.(ctxMenu.spaceId, { color: c });
                    setCtxMenu(null);
                    setShowColors(false);
                  }}
                />
              ))}
            </div>
          )}
          {confirmDelete && (() => {
            const sp = spaces.find(s => s.id === ctxMenu.spaceId);
            const folderName = sp?.displayName ?? ctxMenu.spaceId;
            const hasConflict = artifacts.some(a => a.spaceId === "home" && a.groupName === folderName);
            const altName = folderName + " (2)";
            return (
              <div className="space-ctx-confirm">
                {hasConflict ? (
                  <>
                    <span>"{folderName}" folder exists on Home.</span>
                    <div className="space-ctx-confirm-actions">
                      <button className="space-ctx-item" onClick={() => { setConfirmDelete(false); setCtxMenu(null); }}>Cancel</button>
                      <button className="space-ctx-item" onClick={() => {
                        onSpaceDelete?.(ctxMenu.spaceId);
                        setCtxMenu(null); setConfirmDelete(false);
                      }}>Merge</button>
                      <button className="space-ctx-item" onClick={() => {
                        onSpaceDelete?.(ctxMenu.spaceId, altName);
                        setCtxMenu(null); setConfirmDelete(false);
                      }}>Keep "{altName}"</button>
                    </div>
                  </>
                ) : (
                  <>
                    <span>Moves to a folder on Home.</span>
                    <div className="space-ctx-confirm-actions">
                      <button className="space-ctx-item" onClick={() => { setConfirmDelete(false); setCtxMenu(null); }}>Cancel</button>
                      <button className="space-ctx-item space-ctx-delete" onClick={() => {
                        onSpaceDelete?.(ctxMenu.spaceId);
                        setCtxMenu(null); setConfirmDelete(false);
                      }}>Remove</button>
                    </div>
                  </>
                )}
              </div>
            );
          })()}
        </div>,
        document.body,
      )}

    </div>
  );
}
