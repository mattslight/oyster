import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Desktop } from "./components/Desktop";
import { GroupPopup } from "./components/GroupPopup";
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
} from "./data/artifacts-api";
import { createSession, sendMessage } from "./data/chat-api";
import "./App.css";

export default function App() {
  const [windows, dispatch] = useReducer(windowsReducer, []);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const getSpaceFromUrl = useCallback((): string => {
    const match = window.location.pathname.match(/^\/s\/(.+)$/);
    return match ? match[1] : "home";
  }, []);

  const [activeSpace, setActiveSpace] = useState<string>(getSpaceFromUrl);

  // Redirect bare `/` to `/s/home` so every space has a uniform URL
  useEffect(() => {
    if (window.location.pathname === "/") {
      window.history.replaceState(null, "", "/s/home");
    }
  }, []);
  const [loaded, setLoaded] = useState(false);
  const [showHardcoreGate, setShowHardcoreGate] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

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

  // Sync activeSpace from browser back/forward
  useEffect(() => {
    function handlePopState() {
      setActiveSpace(getSpaceFromUrl());
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [getSpaceFromUrl]);

  // Push URL when space changes via pill click
  const handleSpaceChange = useCallback((space: string) => {
    const target = `/s/${space}`;
    if (window.location.pathname !== target) {
      window.history.pushState(null, "", target);
    }
    setActiveSpace(space);
  }, []);

  // Derive unique space IDs (excluding "home") for the pill row
  const spaces = useMemo(() => {
    const set = new Set<string>();
    for (const a of artifacts) {
      if (a.spaceId && a.spaceId !== "home") set.add(a.spaceId);
    }
    return Array.from(set);
  }, [artifacts]);

  const isHero = activeSpace === "home";

  const viewers = windows.filter((w) => w.type === "viewer");
  const terminalWindow = windows.find((w) => w.type === "terminal");

  async function handleArtifactClick(artifact: Artifact) {
    if (artifact.status === "generating") return;

    if (artifact.runtimeKind === "local_process") {
      // Managed app with a dev server
      if (artifact.status === "starting") return;

      if (artifact.status === "online") {
        window.open(artifact.url, artifact.id, "width=1280,height=900");
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
      window.open(artifact.url, artifact.id, "width=1280,height=900");
    } else {
      // Static artifact (generated app, doc, deck, diagram, etc.) — open in viewer
      const fullscreen = artifact.artifactKind === "deck" || artifact.artifactKind === "app";
      dispatch({ type: "OPEN_VIEWER", title: artifact.label, path: artifact.url, fullscreen });
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

  async function handleFixError(error: { title: string; message: string; stack: string; console: Array<{ type: string; message: string }> }): Promise<string> {
    // Use a fresh session so Oyster has clean context for the fix
    const session = await createSession();
    const consoleText = error.console.length > 0
      ? "\n\nRecent console output:\n" + error.console.map((e) => `[${e.type}] ${e.message}`).join("\n")
      : "";
    const message = `The artifact "${error.title}" crashed with an error:\n\n${error.stack || error.message}${consoleText}\n\nPlease fix this error in the artifact source code.`;
    await sendMessage(session.id, message);
    return session.id;
  }

  return (
    <div className="oyster-shell">
      <Clock />

      <Desktop
        artifacts={artifacts.filter((a) => a.spaceId === activeSpace)}
        onArtifactClick={handleArtifactClick}
        onArtifactStop={handleArtifactStop}
        onGroupClick={setOpenGroup}
      />

      <div className="windows-layer">
        {viewers.map((w, i) => {
          const docArtifacts = artifacts.filter(
            (a) => a.artifactKind !== "app" && a.spaceId === activeSpace
          );
          const currentIdx = docArtifacts.findIndex((a) => a.url === w.artifactPath);
          const hasPrev = currentIdx > 0;
          const hasNext = currentIdx >= 0 && currentIdx < docArtifacts.length - 1;

          return (
            <ViewerWindow
              key={w.id}
              title={w.title}
              path={w.artifactPath!}
              defaultX={200 + i * 20}
              defaultY={40 + i * 20}
              zIndex={w.zIndex}
              fullscreen={w.fullscreen}
              onFocus={() => dispatch({ type: "FOCUS", id: w.id })}
              onClose={() => dispatch({ type: "CLOSE", id: w.id })}
              onToggleFullscreen={() => dispatch({ type: "TOGGLE_FULLSCREEN", id: w.id })}
              hasPrev={hasPrev}
              hasNext={hasNext}
              onFixError={handleFixError}
              onNavigate={(dir) => {
                const nextIdx = currentIdx + dir;
                const next = docArtifacts[nextIdx];
                if (next) {
                  dispatch({
                    type: "NAVIGATE_VIEWER",
                    id: w.id,
                    title: next.label,
                    artifactPath: next.url,
                  });
                }
              }}
            />
          );
        })}
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
                    <stop offset="0%" stopColor="#7c6bff" />
                    <stop offset="100%" stopColor="#6366f1" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <h2 className="hardcore-title">Ultra Hardcore</h2>
            <p>This opens the shell. You're talking directly to the engine — no guardrails, no undo, full control.</p>
            <div className="hardcore-gate-actions">
              <button className="hardcore-cancel" onClick={() => setShowHardcoreGate(false)}>I'll pass</button>
              <button className="hardcore-confirm" onClick={confirmHardcore}>Game on</button>
            </div>
          </div>
        </div>
      )}

      {openGroup && (
        <GroupPopup
          name={openGroup}
          artifacts={artifacts.filter(
            (a) => a.spaceId === activeSpace && a.groupName === openGroup
          )}
          onArtifactClick={(artifact) => {
            setOpenGroup(null);
            handleArtifactClick(artifact);
          }}
          onArtifactStop={handleArtifactStop}
          onClose={() => setOpenGroup(null)}
        />
      )}

      <ChatBar
        onOpenTerminal={handleOpenTerminal}
        isHero={isHero}
        spaces={spaces}
        activeSpace={activeSpace}
        onSpaceChange={handleSpaceChange}
      />
    </div>
  );
}
