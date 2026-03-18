import { useEffect, useRef } from "react";
import { subscribeToEvents, type ChatEvent } from "../data/chat-api";
import type { Message, PendingQuestion, QuestionOption } from "./useChatSession";

// Friendly progress labels for tool names
const TOOL_LABELS: Record<string, string> = {
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

interface UseChatEventsOptions {
  sessionId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setStreaming: (streaming: boolean) => void;
  setStatusText: (text: string) => void;
}

export function useChatEvents({
  sessionId,
  setMessages,
  setStreaming,
  setStatusText,
}: UseChatEventsOptions) {
  // Track current assistant message being streamed
  const currentAssistantMsg = useRef<string | null>(null);
  // Track text parts per message: messageID → Map<partID, text>
  const textPartsMap = useRef<Map<string, Map<string, string>>>(new Map());

  useEffect(() => {
    if (!sessionId) return;

    const unsubscribe = subscribeToEvents((event: ChatEvent) => {
      const props = event.properties;

      // Debug: log events, filtering out noisy ones
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
          const info = props.info as { id: string; role: string; sessionID: string };
          if (info.role === "assistant") {
            currentAssistantMsg.current = info.id;
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
            if (!textPartsMap.current.has(messageId)) {
              textPartsMap.current.set(messageId, new Map());
            }
            const parts = textPartsMap.current.get(messageId)!;
            const current = parts.get(partId) || "";
            parts.set(partId, current + delta);
            const fullContent = Array.from(parts.values()).join("");

            setMessages((prev) => {
              if (!prev.some((m) => m.id === messageId)) {
                return [...prev, { id: messageId, role: "assistant", content: fullContent }];
              }
              return prev.map((m) =>
                m.id === messageId ? { ...m, content: fullContent } : m
              );
            });

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
          const tool = part.toolName || part.name || part.tool;
          if (tool && part.type !== "text") {
            const toolKey = tool.toLowerCase();
            const label = TOOL_LABELS[toolKey] || "working";
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
  }, [sessionId, setMessages, setStreaming, setStatusText]);

  function resetTracking() {
    currentAssistantMsg.current = null;
  }

  return { resetTracking };
}
