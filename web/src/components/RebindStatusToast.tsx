import { useEffect, useState } from "react";
import { subscribeUiEvents } from "../data/ui-events";

// Small floating status chip that surfaces longest-prefix rebind work after
// the user attaches a folder (or updates a folder's path). The server runs
// the rebind in the background via source_rebind_* SSE events so the attach
// API returns instantly; this component is what makes the work visible.

interface Active {
  done: number;
  path: string;
}

export function RebindStatusToast() {
  const [active, setActive] = useState<Map<string, Active>>(new Map());

  useEffect(() => subscribeUiEvents((event) => {
    if (event.command === "source_rebind_started") {
      const { sourceId, path } = event.payload as { sourceId: string; path: string };
      setActive((prev) => {
        const next = new Map(prev);
        next.set(sourceId, { done: 0, path });
        return next;
      });
    } else if (event.command === "source_rebind_progress") {
      const { sourceId, done } = event.payload as { sourceId: string; done: number };
      setActive((prev) => {
        const entry = prev.get(sourceId);
        if (!entry) return prev;
        const next = new Map(prev);
        next.set(sourceId, { ...entry, done });
        return next;
      });
    } else if (event.command === "source_rebind_completed") {
      const { sourceId } = event.payload as { sourceId: string };
      // Brief grace period so the user sees the final count before the chip
      // vanishes — otherwise a fast rebind blinks past them.
      setTimeout(() => {
        setActive((prev) => {
          if (!prev.has(sourceId)) return prev;
          const next = new Map(prev);
          next.delete(sourceId);
          return next;
        });
      }, 1200);
    }
  }), []);

  if (active.size === 0) return null;

  const entries = [...active.entries()];
  return (
    <div
      style={{
        position: "fixed",
        bottom: 18,
        right: 18,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        pointerEvents: "none",
      }}
    >
      {entries.map(([id, entry]) => {
        const leaf = leafName(entry.path);
        return (
          <div
            key={id}
            style={{
              background: "rgba(15, 20, 35, 0.88)",
              border: "1px solid rgba(124, 107, 255, 0.22)",
              color: "rgba(232, 233, 240, 0.92)",
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 11,
              padding: "8px 12px",
              borderRadius: 8,
              minWidth: 220,
              boxShadow: "0 6px 24px rgba(0,0,0,0.32)",
            }}
          >
            <span style={{ color: "rgba(232, 233, 240, 0.52)" }}>Re-binding</span>{" "}
            <strong>{entry.done}</strong>{" "}
            <span style={{ color: "rgba(232, 233, 240, 0.52)" }}>
              session{entry.done === 1 ? "" : "s"} to
            </span>{" "}
            {leaf}
            <span className="rebind-dot-ellipsis">…</span>
          </div>
        );
      })}
    </div>
  );
}

// Last path segment, with `~/` substitution if the path lives under the
// user's home tree — matches the Home view's homeRelative() so the chip
// reads the same way as the source tile that triggered it.
function leafName(path: string): string {
  const m = path.match(/^\/(?:Users|home)\/[^/]+(.*)$/);
  const tail = m ? "~" + m[1] : path;
  const parts = tail.split("/").filter(Boolean);
  if (parts.length === 0) return tail;
  return parts.slice(-2).join("/");
}
