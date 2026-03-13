import { useState, useRef, useEffect, useMemo } from "react";

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
import { mockResponses, defaultChunks } from "../data/mock-chat";
import type { Artifact } from "../data/mock-artifacts";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  onArtifactGenerated: (artifact: Artifact) => void;
  onOpenTerminal: () => void;
  isEmpty?: boolean;
  onOpenSpace?: (space: string) => void;
  hasArtifacts?: boolean;
}

export function ChatBar({ onArtifactGenerated, onOpenTerminal, isEmpty, onOpenSpace, hasArtifacts }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tagline, setTagline] = useState<{ dim: string; bright: string } | null>(null);
  const taglineIndexRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const placeholder = useMemo(() => placeholders[Math.floor(Math.random() * placeholders.length)], []);
  const inputRef = useRef<HTMLInputElement>(null);
  const isHero = isEmpty && messages.length === 0;

  useEffect(() => {
    if (expanded) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, expanded]);

  async function handleSend() {
    if (!input.trim() || streaming) return;
    const content = input;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content }]);
    setStreaming(true);
    setExpanded(true);
    setStatusText("thinking...");

    const match = mockResponses.find((r) => r.trigger.test(content));
    const chunks = match ? match.chunks : defaultChunks;

    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    let accumulated = "";
    for (const chunk of chunks) {
      await delay(400 + Math.random() * 300);
      accumulated += chunk;
      const text = accumulated;
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: "assistant", content: text };
        return updated;
      });
      setStatusText(chunk.trim().slice(0, 40) + "...");
    }

    if (match?.generatesArtifact) {
      await delay(600);
      onArtifactGenerated({
        ...match.generatesArtifact,
        id: "gen-" + Date.now(),
        createdAt: new Date().toISOString(),
      });
    }

    setStreaming(false);
    setStatusText("");
  }

  return (
    <div className={`chatbar-wrapper ${isEmpty && messages.length === 0 ? "chatbar-hero" : ""}`}>
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
            <div key={i} className={`chat-bubble ${msg.role}`}>
              {msg.content}
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
            if (messages.length > 0) setExpanded(true);
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
        {isEmpty && hasArtifacts && !input.trim() ? (
          <button
            className="chatbar-resume-inline"
            onClick={() => onOpenSpace?.("tokinvest")}
          >
            Resume session
          </button>
        ) : (
          <button
            className="chatbar-send"
            onClick={handleSend}
            disabled={streaming || !input.trim()}
          >
            {streaming ? "..." : "↑"}
          </button>
        )}
      </div>

      {/* Space buttons — shown in hero state */}
      {isEmpty && messages.length === 0 && (
        <div className="chatbar-spaces">
          <div className="chatbar-spaces-row">
            <button className="chatbar-space-btn" onClick={() => onOpenSpace?.("tokinvest")}>tokinvest</button>
            <button className="chatbar-space-btn" onClick={() => onOpenSpace?.("personal")}>personal</button>
            <button className="chatbar-space-btn" onClick={() => onOpenSpace?.("kps")}>kps</button>
          </div>
        </div>
      )}
    </div>
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
