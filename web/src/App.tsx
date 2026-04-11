import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Desktop } from "./components/Desktop";
import { GroupPopup } from "./components/GroupPopup";
import { ChatBar } from "./components/ChatBar";
import { AddSpaceWizard } from "./components/AddSpaceWizard";
import { ViewerWindow } from "./components/ViewerWindow";
import { TerminalWindow } from "./components/TerminalWindow";
import { SpotlightSearch } from "./components/SpotlightSearch";
import { windowsReducer } from "./stores/windows";
import {
  type Artifact,
  fetchArtifacts,
  startApp as startAppApi,
  stopApp as stopAppApi,
} from "./data/artifacts-api";
import { shouldOpenFullscreen } from "../../shared/types";
import { fetchSpaces } from "./data/spaces-api";
import type { Space } from "../../shared/types";
import { createSession, sendMessage } from "./data/chat-api";
import "./App.css";

export default function App() {
  const [windows, dispatch] = useReducer(windowsReducer, []);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [showAddSpaceWizard, setShowAddSpaceWizard] = useState(false);
  const getUrlState = useCallback((): { space: string; artifactId: string | null; groupName: string | null; hash: string } => {
    const artifactMatch = window.location.pathname.match(/^\/s\/([^/]+)\/a\/([^/]+)$/);
    if (artifactMatch) {
      return { space: artifactMatch[1], artifactId: artifactMatch[2], groupName: null, hash: window.location.hash || "" };
    }
    const groupMatch = window.location.pathname.match(/^\/s\/([^/]+)\/g\/([^/]+)$/);
    if (groupMatch) {
      return { space: groupMatch[1], artifactId: null, groupName: decodeURIComponent(groupMatch[2]), hash: "" };
    }
    const spaceMatch = window.location.pathname.match(/^\/s\/([^/]+?)\/?$/);
    return { space: spaceMatch ? spaceMatch[1] : "home", artifactId: null, groupName: null, hash: "" };
  }, []);

  const [activeSpace, setActiveSpace] = useState<string>(() => getUrlState().space);

  // Global keyboard shortcuts
  const chatInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSpotlightOpen((v) => !v);
      }
      if (e.key === "Escape") setSpotlightOpen(false);
      // Any printable key focuses chat bar when not already in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "BUTTON" && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
        chatInputRef.current?.focus();
        // Don't preventDefault — let the character appear in the input
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Redirect bare `/` to `/s/home` so every space has a uniform URL
  useEffect(() => {
    if (window.location.pathname === "/") {
      window.history.replaceState(null, "", "/s/home");
    }
  }, []);
  const [loaded, setLoaded] = useState(false);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [showHardcoreGate, setShowHardcoreGate] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(() => getUrlState().groupName);
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  const [viewerHash, setViewerHash] = useState<string>(() => getUrlState().hash);
  const [connected, setConnected] = useState(true);

  // Fetch artifacts + spaces on mount; auto-open artifact if URL contains one
  useEffect(() => {
    fetchArtifacts().then((a) => {
      setArtifacts(a);
      setLoaded(true);
      setConnected(true);
      const { artifactId } = getUrlState();
      if (artifactId) {
        const artifact = a.find((x) => x.id === artifactId);
        if (artifact) {
          const fullscreen = shouldOpenFullscreen(artifact.artifactKind);
          dispatch({ type: "OPEN_VIEWER", title: artifact.label, path: artifact.url, fullscreen });
        }
      }
    }).catch((err) => { console.warn("[oyster] server unreachable:", err.message); setLoaded(true); setConnected(false); });
    fetchSpaces().then(setSpaces).catch(() => setConnected(false));
  }, []);

  // Poll for status updates every 5 seconds; handle pending reveals
  useEffect(() => {
    const interval = setInterval(() => {
      fetchArtifacts().then((arts) => {
        setArtifacts(arts);
        setConnected(true);
        const revealed = arts.find((a) => a.pendingReveal);
        if (revealed) {
          setActiveSpace(revealed.spaceId);
          window.history.pushState(null, "", `/s/${revealed.spaceId}`);
          if (revealed.groupName) setOpenGroup(revealed.groupName);
          setRevealId(revealed.id);
          setTimeout(() => setRevealId(null), 3000);
        }
      }).catch(() => setConnected(false));
      fetchSpaces().then(setSpaces).catch(() => setConnected(false));
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Subscribe to server-pushed UI commands (open artifact, switch space)
  useEffect(() => {
    const es = new EventSource("/api/ui/events");
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.command === "open_artifact") {
          const { spaceId, label, url, artifactKind } = event.payload;
          setActiveSpace(spaceId);
          window.history.pushState(null, "", `/s/${spaceId}/a/${event.payload.id}`);
          dispatch({ type: "CLOSE_ALL_VIEWERS" });
          dispatch({ type: "OPEN_VIEWER", title: label, path: url, fullscreen: shouldOpenFullscreen(artifactKind) });
        }
        if (event.command === "switch_space") {
          const { spaceId } = event.payload;
          setActiveSpace(spaceId);
          window.history.pushState(null, "", `/s/${spaceId}`);
          dispatch({ type: "CLOSE_ALL_VIEWERS" });
        }
      } catch { /* ignore malformed events */ }
    };
    return () => es.close();
  }, []);

  // Sync state from browser back/forward
  useEffect(() => {
    function handlePopState() {
      const { space, artifactId, groupName } = getUrlState();
      setActiveSpace(space);
      setOpenGroup(groupName);
      if (!artifactId) {
        dispatch({ type: "CLOSE_ALL_VIEWERS" });
      } else {
        const artifact = artifacts.find((a) => a.id === artifactId);
        if (artifact) {
          const hash = window.location.hash || "";
          const fullscreen = shouldOpenFullscreen(artifact.artifactKind);
          setViewerHash(hash);
          dispatch({ type: "CLOSE_ALL_VIEWERS" });
          dispatch({ type: "OPEN_VIEWER", title: artifact.label, path: artifact.url, fullscreen });
        }
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [getUrlState]);

  // Push URL when space changes via pill click
  const handleSpaceChange = useCallback((space: string) => {
    const target = `/s/${space}`;
    if (window.location.pathname !== target) {
      window.history.pushState(null, "", target);
    }
    setActiveSpace(space);
    setOpenGroup(null);
  }, []);

  const isHero = activeSpace === "home";

  const viewers = windows.filter((w) => w.type === "viewer");
  const terminalWindow = windows.find((w) => w.type === "terminal");

  async function handleArtifactClick(artifact: Artifact) {
    if (artifact.status === "generating") return;

    if (artifact.runtimeKind === "redirect") {
      window.open(artifact.url, "_blank");
      return;
    }

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
      const fullscreen = shouldOpenFullscreen(artifact.artifactKind);
      dispatch({ type: "OPEN_VIEWER", title: artifact.label, path: artifact.url, fullscreen });
      setViewerHash("");
      window.history.pushState(null, "", `/s/${activeSpace}/a/${artifact.id}`);
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

  async function handleFixError(error: { title: string; path: string; message: string; stack: string; console: Array<{ type: string; message: string }> }): Promise<string> {
    // Use a fresh session so Oyster has clean context for the fix
    const session = await createSession();
    const consoleText = error.console.length > 0
      ? "\n\nRecent console output:\n" + error.console.map((e) => `[${e.type}] ${e.message}`).join("\n")
      : "";

    // Try to resolve the actual file path from the server
    let fileHint = "";
    try {
      const res = await fetch(`/api/resolve-path?url=${encodeURIComponent(error.path)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.filePath) fileHint = `\n\nThe source file is: ${data.filePath}`;
      }
    } catch { /* best effort */ }

    const message = `The artifact "${error.title}" (served at ${error.path}) crashed with an error:\n\n${error.stack || error.message}${consoleText}${fileHint}\n\nPlease fix this error in the artifact source code.`;
    await sendMessage(session.id, message);
    return session.id;
  }

  return (
    <div className="oyster-shell">
      {!connected && (
        <div className="connection-banner">
          <span>Oyster server not connected</span>
          <span className="connection-hint">Run <code>npm run dev</code> to start</span>
        </div>
      )}
      <Desktop
        space={activeSpace}
        spaces={spaces.map(s => s.id)}
        isHero={isHero}
        artifacts={activeSpace === "__all__" ? artifacts : artifacts.filter((a) => a.spaceId === activeSpace)}
        onArtifactClick={handleArtifactClick}
        onArtifactStop={handleArtifactStop}
        onGroupClick={(name) => {
          setOpenGroup(name);
          window.history.pushState(null, "", `/s/${activeSpace}/g/${encodeURIComponent(name.toLowerCase())}`);
        }}
        onSpaceChange={handleSpaceChange}
        revealId={revealId}
      />

      <div className="windows-layer">
        {viewers.map((w, i) => {
          const docArtifacts = activeSpace === "__all__"
            ? artifacts.filter((a) => a.artifactKind !== "app")
            : artifacts.filter((a) => a.artifactKind !== "app" && a.spaceId === activeSpace);
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
              onClose={() => {
                dispatch({ type: "CLOSE", id: w.id });
                window.history.pushState(null, "", `/s/${activeSpace}`);
              }}
              onToggleFullscreen={() => dispatch({ type: "TOGGLE_FULLSCREEN", id: w.id })}
              hasPrev={hasPrev}
              hasNext={hasNext}
              initialHash={viewerHash}
              onHashChange={(hash) => {
                setViewerHash(hash);
                window.history.replaceState(null, "", `${window.location.pathname}${hash}`);
              }}
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
                  window.history.replaceState(null, "", `/s/${activeSpace}/a/${next.id}`);
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

      {openGroup && (() => {
        const groupArtifacts = artifacts.filter(
          (a) => a.spaceId === activeSpace && a.groupName?.toLowerCase() === openGroup.toLowerCase()
        );
        const displayName = groupArtifacts[0]?.groupName || openGroup;
        return (
        <GroupPopup
          name={displayName}
          artifacts={groupArtifacts}
          onArtifactClick={(artifact) => {
            if (artifact.runtimeKind !== "local_process") {
              setOpenGroup(null);
            }
            handleArtifactClick(artifact);
          }}
          onArtifactStop={handleArtifactStop}
          onClose={() => {
            setOpenGroup(null);
            window.history.pushState(null, "", `/s/${activeSpace}`);
          }}
        />
        );
      })()}

      <ChatBar
        onOpenTerminal={handleOpenTerminal}
        isHero={isHero}
        spaces={spaces}
        activeSpace={activeSpace}
        onSpaceChange={handleSpaceChange}
        inputRef={chatInputRef}
        onAddSpace={() => setShowAddSpaceWizard(true)}
      />

      {showAddSpaceWizard && (
        <AddSpaceWizard
          onClose={() => setShowAddSpaceWizard(false)}
          onComplete={() => {
            setShowAddSpaceWizard(false);
            fetchSpaces().then(setSpaces);
            fetchArtifacts().then(setArtifacts);
          }}
        />
      )}

      {spotlightOpen && (
        <SpotlightSearch
          artifacts={artifacts}
          onOpen={handleArtifactClick}
          onClose={() => setSpotlightOpen(false)}
        />
      )}
    </div>
  );
}
