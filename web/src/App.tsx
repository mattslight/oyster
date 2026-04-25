import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Desktop } from "./components/Desktop";
import { GroupPopup } from "./components/GroupPopup";
import { ChatBar } from "./components/ChatBar";
import { ViewerWindow } from "./components/ViewerWindow";
import { TerminalWindow } from "./components/TerminalWindow";
import { SpotlightSearch } from "./components/SpotlightSearch";
import { OnboardingDock } from "./components/OnboardingDock";
import { windowsReducer } from "./stores/windows";
import {
  type Artifact,
  type ArtifactKind,
  fetchArtifacts,
  listArchivedArtifacts,
  startApp as startAppApi,
  stopApp as stopAppApi,
} from "./data/artifacts-api";
import { subscribeUiEvents } from "./data/ui-events";
import { shouldOpenFullscreen } from "../../shared/types";
import { fetchSpaces, updateSpace, deleteSpace, convertFolderToSpace } from "./data/spaces-api";
import type { Space } from "../../shared/types";
import { createSession, sendMessage } from "./data/chat-api";
import "./App.css";

// `?onboarding=force` wipes the dock's persisted state and pretends this
// is a fresh install — lets us iterate on 0/3 hero copy without touching
// the real userland. Gated on `import.meta.env.DEV` so it's a strict
// no-op in production builds (Vite dead-code-strips the block). Runs
// synchronously at module load so the clear happens before
// <OnboardingDock> reads localStorage in its useState initialiser.
const FORCE_ONBOARDING = import.meta.env.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("onboarding") === "force";
if (FORCE_ONBOARDING) {
  try {
    localStorage.removeItem("oyster-onboarding-state");
  } catch { /* privacy-mode browsers can throw — matches OnboardingDock */ }
}

export default function App() {
  const [windows, dispatch] = useReducer(windowsReducer, []);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
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
  const [spotlightOpen, setSpotlightOpen] = useState(false);
  // Agent-driven desktop filter, set by the `filter_desktop` MCP tool. Layered
  // on top of the user's space-pill / kind-pill state — see line 365.
  const [agentFilter, setAgentFilter] = useState<{ kind: ArtifactKind | null; search: string | null } | null>(null);

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
    // Prevent browser from opening dropped files/folders (but allow text drops)
    function preventFileDrop(e: DragEvent) {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    }
    document.addEventListener("dragover", preventFileDrop);
    document.addEventListener("drop", preventFileDrop);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("dragover", preventFileDrop);
      document.removeEventListener("drop", preventFileDrop);
    };
  }, []);

  // Redirect bare `/` to `/s/home` so every space has a uniform URL
  useEffect(() => {
    if (window.location.pathname === "/") {
      window.history.replaceState(null, "", "/s/home");
    }
  }, []);
  const [, setLoaded] = useState(false);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [showHardcoreGate, setShowHardcoreGate] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(() => getUrlState().groupName);
  // Auto-close the group popup when the group goes empty (e.g. the user
  // archived the last artifact from within it). Without this, the popup
  // keeps rendering an empty shell until the user manually dismisses.
  useEffect(() => {
    if (!openGroup) return;
    const stillHas = artifacts.some(
      (a) =>
        a.groupName?.toLowerCase() === openGroup.toLowerCase() &&
        (activeSpace === "__all__" || activeSpace === "__archived__" || a.spaceId === activeSpace),
    );
    if (!stillHas) setOpenGroup(null);
  }, [artifacts, openGroup, activeSpace]);
  const [viewerHash, setViewerHash] = useState<string>(() => getUrlState().hash);
  const [connected, setConnected] = useState(true);
  const [aiError, setAiError] = useState<string | null>(null);

  // Apply the agent-driven desktop filter on top of the space-scoped list.
  // Intersection semantics — kind + search both narrow further. Search matches
  // label, space id/name, or sourceLabel (basename of linked source folder).
  function applyAgentFilter(list: Artifact[]): Artifact[] {
    if (!agentFilter) return list;
    const { kind, search } = agentFilter;
    let next = list;
    if (kind) next = next.filter((a) => a.artifactKind === kind);
    if (search) {
      const q = search.toLowerCase();
      const space = spaces.find((s) => s.id === activeSpace);
      next = next.filter((a) => {
        if (a.label.toLowerCase().includes(q)) return true;
        if (a.spaceId.toLowerCase().includes(q)) return true;
        if (space && space.displayName.toLowerCase().includes(q)) return true;
        if (a.sourceLabel && a.sourceLabel.toLowerCase().includes(q)) return true;
        return false;
      });
    }
    return next;
  }

  // Active-space-aware artifact loader. Mirrors current activeSpace via a ref
  // so callers don't have to thread it through every closure (polling,
  // onRefresh, mutation handlers all call loadArtifacts with no args).
  const isArchivedView = activeSpace === "__archived__";
  const activeSpaceRef = useRef(activeSpace);
  useEffect(() => { activeSpaceRef.current = activeSpace; }, [activeSpace]);
  const loadArtifacts = useCallback(() => {
    return activeSpaceRef.current === "__archived__"
      ? listArchivedArtifacts()
      : fetchArtifacts();
  }, []);

  // Refetch whenever the mode toggles (archive ↔ normal) so the view flips
  // to the right dataset instantly rather than waiting for the next poll.
  // Skip the initial mount — the separate mount effect below handles that
  // fetch, and firing both racing fetches at startup would waste a round-
  // trip and leave the faster result under-written by the slower one.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    loadArtifacts()
      .then((a) => { setArtifacts(a); setConnected(true); })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[oyster] failed to refetch on mode toggle:", msg);
        setConnected(false);
      });
  }, [isArchivedView, loadArtifacts]);

  // Fetch artifacts + spaces on mount; auto-open artifact if URL contains one
  useEffect(() => {
    loadArtifacts().then((a) => {
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
      loadArtifacts().then((arts) => {
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

  // Subscribe to server-pushed UI commands (open artifact, switch space).
  // Uses the shared ui-events subscription so we don't hold a second
  // EventSource alongside OnboardingDock's.
  useEffect(() => subscribeUiEvents((event) => {
    if (event.command === "open_artifact") {
      const { spaceId, label, url, artifactKind, id } = event.payload as { spaceId: string; label: string; url: string; artifactKind: ArtifactKind; id: string };
      setActiveSpace(spaceId);
      window.history.pushState(null, "", `/s/${spaceId}/a/${id}`);
      dispatch({ type: "CLOSE_ALL_VIEWERS" });
      dispatch({ type: "OPEN_VIEWER", title: label, path: url, fullscreen: shouldOpenFullscreen(artifactKind) });
    }
    if (event.command === "switch_space") {
      const { spaceId } = event.payload as { spaceId: string };
      setActiveSpace(spaceId);
      window.history.pushState(null, "", `/s/${spaceId}`);
      dispatch({ type: "CLOSE_ALL_VIEWERS" });
    }
    if (event.command === "desktop_filter_changed") {
      const { spaceId, kind, search, cleared } = event.payload as { spaceId: string | null; kind: ArtifactKind | null; search: string | null; cleared: boolean };
      if (cleared) { setAgentFilter(null); return; }
      if (spaceId) {
        setActiveSpace(spaceId);
        window.history.pushState(null, "", `/s/${spaceId}`);
      }
      setAgentFilter(kind || search ? { kind, search } : null);
    }
  }), []);

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

  const handleSpaceUpdate = useCallback(async (id: string, fields: { displayName?: string; color?: string }) => {
    try {
      const updated = await updateSpace(id, fields);
      setSpaces((prev) => prev.map((s) => s.id === id ? updated : s));
    } catch (err) {
      console.error("[space] update failed:", err);
    }
  }, []);

  const handleSpaceDelete = useCallback(async (id: string, folderName?: string) => {
    try {
      await deleteSpace(id, folderName);
      setSpaces((prev) => prev.filter((s) => s.id !== id));
      if (activeSpace === id) handleSpaceChange("home");
    } catch (err) {
      console.error("[space] delete failed:", err);
    }
  }, [activeSpace, handleSpaceChange]);

  const handleConvertToSpace = useCallback(async (groupName: string, merge?: boolean, sourceSpaceId?: string) => {
    try {
      const newSpace = await convertFolderToSpace(groupName, sourceSpaceId ?? activeSpace, merge);
      setSpaces((prev) => prev.some(s => s.id === newSpace.id) ? prev : [...prev, newSpace]);
      handleSpaceChange(newSpace.id);
    } catch (err) {
      console.error("[space] convert folder failed:", err);
    }
  }, [activeSpace, handleSpaceChange]);

  const isHero = activeSpace === "home";
  const isFirstRun = FORCE_ONBOARDING ||
    spaces.filter(s => s.id !== "home" && s.id !== "__all__").length === 0;

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
          <span className="connection-hint">Run <code>oyster</code> to start</span>
        </div>
      )}
      {connected && aiError && (
        <div className="connection-banner ai-error-banner">
          <span>{aiError}</span>
        </div>
      )}
      <Desktop
        space={activeSpace}
        spaces={spaces.map(s => s.id)}
        isHero={isHero}
        artifacts={applyAgentFilter((activeSpace === "__all__" || activeSpace === "__archived__") ? artifacts : artifacts.filter((a) => a.spaceId === activeSpace))}
        agentFilter={agentFilter}
        onClearAgentFilter={() => setAgentFilter(null)}
        isArchivedView={isArchivedView}
        onArtifactClick={handleArtifactClick}
        onArtifactStop={handleArtifactStop}
        onGroupClick={(name) => {
          setOpenGroup(name);
          window.history.pushState(null, "", `/s/${activeSpace}/g/${encodeURIComponent(name.toLowerCase())}`);
        }}
        onSpaceChange={handleSpaceChange}
        onConvertToSpace={handleConvertToSpace}
        onRefresh={() =>
          loadArtifacts()
            .then((nextArtifacts) => { setArtifacts(nextArtifacts); setConnected(true); })
            .catch(() => setConnected(false))
        }
        onArtifactUpdate={(id, fields) => setArtifacts((prev) => prev.map((a) => (a.id === id ? { ...a, ...fields } : a)))}
        onArtifactRemove={(id) => setArtifacts((prev) => prev.filter((a) => a.id !== id))}
        onImportFromAI={(spaceId) => {
          const importArtifact = artifacts.find((a) => a.id.endsWith("import-from-ai"));
          if (!importArtifact) return;
          if (spaceId) {
            const sp = spaces.find((s) => s.id === spaceId);
            const params = `?spaceId=${encodeURIComponent(spaceId)}&spaceName=${encodeURIComponent(sp?.displayName ?? spaceId)}`;
            const scoped = { ...importArtifact, url: importArtifact.url + params };
            handleArtifactClick(scoped);
          } else {
            handleArtifactClick(importArtifact);
          }
        }}
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
        // In __all__ and __archived__ views, artifacts have real space_ids
        // (home, oyster, …) — not the meta-space's id. Skip the space-match
        // filter in those cases; the `artifacts` prop is already scoped to
        // the right dataset (all artifacts, or archived artifacts).
        const isMetaSpace = activeSpace === "__all__" || activeSpace === "__archived__";
        const groupArtifacts = artifacts.filter(
          (a) => (isMetaSpace || a.spaceId === activeSpace) && a.groupName?.toLowerCase() === openGroup.toLowerCase()
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
        onSpaceUpdate={handleSpaceUpdate}
        onSpaceDelete={handleSpaceDelete}
        artifacts={artifacts}
        onArtifactOpen={handleArtifactClick}
        isFirstRun={isFirstRun}
        onAiError={setAiError}
      />

      {spotlightOpen && (
        <SpotlightSearch
          artifacts={artifacts}
          onOpen={handleArtifactClick}
          onClose={() => setSpotlightOpen(false)}
        />
      )}

      <OnboardingDock
        userSpaceCount={FORCE_ONBOARDING ? 0 : spaces.filter((s) => s.id !== "home" && s.id !== "__all__" && s.id !== "__archived__").length}
      />
    </div>
  );
}
