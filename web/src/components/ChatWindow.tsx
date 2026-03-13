import { useState, useRef, useEffect } from "react";
import { WindowChrome } from "./WindowChrome";
import { mockResponses, defaultChunks } from "../data/mock-chat";
import type { Artifact } from "../data/mock-artifacts";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  defaultX: number;
  defaultY: number;
  zIndex: number;
  onMinimize: () => void;
  onClose: () => void;
  onStatusUpdate: (text: string) => void;
  onArtifactGenerated: (artifact: Artifact) => void;
}

export function ChatWindow({
  defaultX,
  defaultY,
  zIndex,
  onMinimize,
  onClose,
  onStatusUpdate,
  onArtifactGenerated,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: "Hey! I'm Oyster. What are you working on?" },
  ]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    if (!input.trim() || streaming) return;
    const content = input;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content }]);
    setStreaming(true);
    onStatusUpdate("thinking...");

    const match = mockResponses.find((r) => r.trigger.test(content));
    const chunks = match ? match.chunks : defaultChunks;

    // Add empty assistant bubble first
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
      onStatusUpdate(chunk.trim().slice(0, 40) + "...");
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
    onStatusUpdate("");
  }

  return (
    <WindowChrome
      title="Chat"
      onMinimize={onMinimize}
      onClose={onClose}
      defaultX={defaultX}
      defaultY={defaultY}
      defaultW={440}
      defaultH={500}
      zIndex={zIndex}
    >
      <div className="chat-messages">
        {messages.map((msg, i) => (
          <div key={i} className={`chat-bubble ${msg.role}`}>
            {msg.content}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-row">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          placeholder="Talk to Oyster..."
          disabled={streaming}
        />
        <button onClick={handleSend} disabled={streaming || !input.trim()}>
          {streaming ? "..." : "↑"}
        </button>
      </div>
    </WindowChrome>
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
