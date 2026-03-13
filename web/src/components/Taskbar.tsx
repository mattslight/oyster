import { useEffect, useState } from "react";
import type { WindowState } from "../stores/windows";

interface Props {
  windows: WindowState[];
  onOysterClick: () => void;
  onChipClick: (id: string) => void;
}

export function Taskbar({ windows, onOysterClick, onChipClick }: Props) {
  const [time, setTime] = useState(formatTime());
  const minimized = windows.filter((w) => w.minimized);

  useEffect(() => {
    const interval = setInterval(() => setTime(formatTime()), 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="taskbar">
      <div className="taskbar-left">
        <button className="start-btn" onClick={onOysterClick}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 12a4 4 0 004 4M16 12a4 4 0 00-4-4" />
          </svg>
          Oyster
        </button>
        <div className="taskbar-divider" />
        {minimized.map((w) => (
          <button
            key={w.id}
            className="taskbar-chip"
            onClick={() => onChipClick(w.id)}
          >
            <span className="chip-icon">{w.type === "chat" ? "💬" : "📄"}</span>
            <span className="chip-text">
              {w.statusText || w.title}
            </span>
          </button>
        ))}
      </div>
      <div className="taskbar-right">
        <div className="taskbar-status">
          <div className="status-dot" />
          <span className="status-label">Local</span>
        </div>
        <div className="taskbar-clock">{time}</div>
      </div>
    </div>
  );
}

function formatTime(): string {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
