import { useEffect, useRef } from "react";
import { subscribeToEvents, type ChatEvent } from "../data/chat-api";
import type { Message, MessagePart, ToolPart, PendingQuestion, QuestionOption } from "./useChatSession";
import { TOOL_LABELS, extractToolHint } from "./tool-labels";

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
  // Track tool parts per message: messageID → Map<partID, ToolPart>
  const toolPartsMap = useRef<Map<string, Map<string, ToolPart>>>(new Map());
  // Track insertion order of all parts per message: messageID → partID[]
  const partsOrderMap = useRef<Map<string, string[]>>(new Map());

  function ensurePartOrder(messageId: string, partId: string) {
    const order = partsOrderMap.current.get(messageId);
    if (!order) {
      partsOrderMap.current.set(messageId, [partId]);
    } else if (!order.includes(partId)) {
      order.push(partId);
    }
  }

  function buildMessageParts(messageId: string): MessagePart[] {
    const order = partsOrderMap.current.get(messageId) || [];
    const texts = textPartsMap.current.get(messageId);
    const tools = toolPartsMap.current.get(messageId);
    return order.map((partId) => {
      const toolPart = tools?.get(partId);
      if (toolPart) return { type: "tool" as const, tool: toolPart };
      return { type: "text" as const, text: texts?.get(partId) || "" };
    });
  }

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
            const textParts = textPartsMap.current.get(messageId)!;
            const current = textParts.get(partId) || "";
            textParts.set(partId, current + delta);
            ensurePartOrder(messageId, partId);
            const fullContent = Array.from(textParts.values()).join("");
            const msgParts = buildMessageParts(messageId);

            setMessages((prev) => {
              if (!prev.some((m) => m.id === messageId)) {
                return [...prev, { id: messageId, role: "assistant", content: fullContent, parts: msgParts }];
              }
              return prev.map((m) =>
                m.id === messageId ? { ...m, content: fullContent, parts: msgParts } : m
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
            state?: { input?: Record<string, unknown>; output?: unknown; status?: string };
          };
          if (part.type === "text" && part.text !== undefined) {
            if (!textPartsMap.current.has(partMsgId)) {
              textPartsMap.current.set(partMsgId, new Map());
            }
            textPartsMap.current.get(partMsgId)!.set(part.id, part.text);
            ensurePartOrder(partMsgId, part.id);
          }
          const tool = part.toolName || part.name || part.tool;
          if (tool && part.type !== "text") {
            const toolKey = tool.toLowerCase();
            const label = TOOL_LABELS[toolKey] || "working";
            const hint = toolKey === "bash" ? null : extractToolHint(part as Record<string, unknown>);

            // Store tool part
            if (!toolPartsMap.current.has(partMsgId)) {
              toolPartsMap.current.set(partMsgId, new Map());
            }
            const state = part.state || {};
            const toolPart: ToolPart = {
              id: part.id,
              toolName: toolKey,
              label,
              hint,
              status: state.status === "completed" ? "completed" : "running",
              input: state.input,
              output: state.output != null ? String(state.output) : undefined,
            };
            toolPartsMap.current.get(partMsgId)!.set(part.id, toolPart);
            ensurePartOrder(partMsgId, part.id);

            // Rebuild parts on the message
            const msgParts = buildMessageParts(partMsgId);
            const fullContent = Array.from(textPartsMap.current.get(partMsgId)?.values() || []).join("");
            setMessages((prev) => prev.map((m) =>
              m.id === partMsgId ? { ...m, content: fullContent || m.content, parts: msgParts } : m
            ));

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
    toolPartsMap.current.clear();
    partsOrderMap.current.clear();
  }

  return { resetTracking };
}
