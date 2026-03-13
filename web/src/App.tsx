import { useEffect, useReducer, useState } from "react";
import { Desktop } from "./components/Desktop";
import { ChatBar } from "./components/ChatBar";
import { Clock } from "./components/Clock";
import { ViewerWindow } from "./components/ViewerWindow";
import { TerminalWindow } from "./components/TerminalWindow";
import { windowsReducer } from "./stores/windows";
import {
  type Artifact,
  fetchArtifacts,
  startApp as startAppApi,
  stopApp as stopAppApi,
} from "./data/mock-artifacts";
import "./App.css";

export default function App() {
  const [windows, dispatch] = useReducer(windowsReducer, []);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [activeSpace, setActiveSpace] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showHardcoreGate, setShowHardcoreGate] = useState(false);

  // Fetch artifacts on mount
  useEffect(() => {
    fetchArtifacts().then((a) => {
      setArtifacts(a);
      setLoaded(true);
    });
  }, []);

  // Poll for status updates every 5 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchArtifacts().then(setArtifacts);
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const viewers = windows.filter((w) => w.type === "viewer");
  const terminalWindow = windows.find((w) => w.type === "terminal");

  function handleArtifactGenerated(artifact: Artifact) {
    setArtifacts((prev) => [...prev, artifact]);
  }

  async function handleArtifactClick(artifact: Artifact) {
    if (artifact.type === "app") {
      if (artifact.status === "starting") return;

      if (artifact.status === "online") {
        window.open(artifact.path, artifact.id, "width=1280,height=900");
        return;
      }

      // offline — optimistically set to starting, then start
      setArtifacts((prev) =>
        prev.map((a) =>
          a.id === artifact.id ? { ...a, status: "starting" as const } : a
        )
      );
      const appName = artifact.id.replace("app:", "");
      await startAppApi(appName);
      window.open(artifact.path, artifact.id, "width=1280,height=900");
    } else {
      dispatch({ type: "OPEN_VIEWER", title: artifact.name, path: artifact.path });
    }
  }

  function handleOpenTerminal() {
    const seen = localStorage.getItem("oyster-hardcore-seen");
    if (!seen) {
      setShowHardcoreGate(true);
      return;
    }
    dispatch({ type: "OPEN_TERMINAL" });
  }

  function confirmHardcore() {
    localStorage.setItem("oyster-hardcore-seen", "1");
    setShowHardcoreGate(false);
    dispatch({ type: "OPEN_TERMINAL" });
  }

  async function handleArtifactStop(artifact: Artifact) {
    const appName = artifact.id.replace("app:", "");
    await stopAppApi(appName);
  }

  return (
    <div className="oyster-shell">
      <Clock />

      {activeSpace && (
        <div className="space-header">
          <button className="space-back" onClick={() => setActiveSpace(null)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="space-name">{activeSpace}</span>
        </div>
      )}

      <Desktop
        artifacts={activeSpace ? artifacts.filter((a) => a.space === activeSpace) : []}
        onArtifactClick={handleArtifactClick}
        onArtifactStop={handleArtifactStop}
      />

      <div className="windows-layer">
        {viewers.map((w, i) => (
          <ViewerWindow
            key={w.id}
            title={w.title}
            path={w.artifactPath!}
            defaultX={200 + i * 20}
            defaultY={40 + i * 20}
            zIndex={w.zIndex}
            onFocus={() => dispatch({ type: "FOCUS", id: w.id })}
            onClose={() => dispatch({ type: "CLOSE", id: w.id })}
          />
        ))}
        {terminalWindow && (
          <TerminalWindow
            key={terminalWindow.id}
            defaultX={120}
            defaultY={60}
            zIndex={terminalWindow.zIndex}
            onFocus={() => dispatch({ type: "FOCUS", id: terminalWindow.id })}
            onClose={() => dispatch({ type: "CLOSE", id: terminalWindow.id })}
          />
        )}
      </div>

      {showHardcoreGate && (
        <div className="hardcore-gate-overlay" onClick={() => setShowHardcoreGate(false)}>
          <div className="hardcore-gate" onClick={(e) => e.stopPropagation()}>
            <div className="hardcore-gate-icon">
              <div className="hardcore-glow" />
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="url(#bolt-grad)" />
                <defs>
                  <linearGradient id="bolt-grad" x1="3" y1="2" x2="20" y2="22">
                    <stop offset="0%" stopColor="#21b981" />
                    <stop offset="100%" stopColor="#6366f1" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <h2 className="hardcore-title">Ultra Hardcore</h2>
            <p>This opens a raw terminal. You're talking directly to the engine — no guardrails, no undo, full control.</p>
            <div className="hardcore-gate-actions">
              <button className="hardcore-cancel" onClick={() => setShowHardcoreGate(false)}>I'll pass</button>
              <button className="hardcore-confirm" onClick={confirmHardcore}>Game on</button>
            </div>
          </div>
        </div>
      )}

      <ChatBar
        onArtifactGenerated={handleArtifactGenerated}
        onOpenTerminal={handleOpenTerminal}
        isEmpty={!activeSpace}
        onOpenSpace={(space) => setActiveSpace(space)}
        hasArtifacts={loaded && artifacts.length > 0}
      />
    </div>
  );
}
