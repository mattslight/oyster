import { useState, useRef, useEffect } from "react";
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
  onOpenSurface?: () => void;
}

export function ChatBar({ onArtifactGenerated, onOpenTerminal, isEmpty, onOpenSurface }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12a4 4 0 004 4M16 12a4 4 0 00-4-4" />
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
          onFocus={() => messages.length > 0 && setExpanded(true)}
          placeholder="Talk to Oyster..."
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

      {/* Space buttons — shown in hero state */}
      {isEmpty && messages.length === 0 && (
        <div className="chatbar-spaces">
          {onOpenSurface && (
            <button className="chatbar-space-btn resume" onClick={onOpenSurface}>
              Resume last workspace
            </button>
          )}
          <div className="chatbar-spaces-row">
            <button className="chatbar-space-btn" onClick={onOpenSurface}>tokinvest</button>
            <button className="chatbar-space-btn" onClick={() => {}}>personal</button>
            <button className="chatbar-space-btn" onClick={() => {}}>kps</button>
          </div>
        </div>
      )}
    </div>
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
