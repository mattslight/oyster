import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Home } from "./components/Home";
import { GroupPopup } from "./components/GroupPopup";
import { ChatBar } from "./components/ChatBar";
import { PublishModal } from "./components/PublishModal";
import { ViewerWindow } from "./components/ViewerWindow";
import { TerminalWindow } from "./components/TerminalWindow";
import { SpotlightSearch } from "./components/SpotlightSearch";
import { OnboardingDock } from "./components/OnboardingDock";
import { SetupProposalPanel } from "./components/SetupProposalPanel";
import { AuthBadge } from "./components/AuthBadge";
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
import { fetchSpaces, updateSpace, deleteSpace, convertFolderToSpace, promoteFolderToSpace } from "./data/spaces-api";
import type { Space, SetupProposal } from "../../shared/types";
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
  const [publishingArtifact, setPublishingArtifact] = useState<Artifact | null>(null);
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
  // True when the user is on a Home sub-view (Pro vault preview or Unsorted
  // orphans) rather than the bare Home feed. Lifted from Home so the chat
  // bar can drop out of hero mode and stop occluding sub-view content.
  const [homeSubViewActive, setHomeSubViewActive] = useState(false);
  // Active proposal from the agent's `propose_setup` MCP tool (broadcast
  // via SSE). Standalone overlay — not coupled to the chat. Triggered by
  // the agent during first-run setup; cleared on Apply / Close.
  const [setupProposal, setSetupProposal] = useState<SetupProposal | null>(null);

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
    if (event.command === "artifact_changed") {
      void loadArtifacts()
        .then(setArtifacts)
        .catch((err) => console.warn("[oyster] artifact_changed refetch failed:", err));
      return;
    }
    if (event.command === "setup_proposal_ready") {
      setSetupProposal(event.payload as SetupProposal);
    }
    if (event.command === "setup_applied") {
      // Another tab just applied a setup proposal. Refresh spaces +
      // artefacts so this tab reflects what the apply created without
      // waiting for the regular polling tick.
      void fetchSpaces().then(setSpaces).catch(() => undefined);
      void loadArtifacts().then(setArtifacts).catch(() => undefined);
    }
  }), [loadArtifacts]);

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

  const handlePromoteFolderToSpace = useCallback(async (path: string): Promise<Space | null> => {
    try {
      const newSpace = await promoteFolderToSpace(path);
      setSpaces((prev) => prev.some(s => s.id === newSpace.id) ? prev : [...prev, newSpace]);
      handleSpaceChange(newSpace.id);
      return newSpace;
    } catch (err) {
      console.error("[space] promote folder failed:", err);
      return null;
    }
  }, [handleSpaceChange]);

  // Hero mode = chat bar centred + large. Reserved for the truly empty Home
  // (no spaces, no work yet). The moment a user has real spaces, the chat
  // bar drops to its compact bottom position even on the Home pill —
  // otherwise the spaces / sessions / artefacts feed reads as decoration
  // beneath an oversized prompt.
  const isFirstRun = FORCE_ONBOARDING ||
    spaces.filter(s => s.id !== "home" && s.id !== "__all__").length === 0;
  // Hero only on the bare Home feed. The Pro and Unsorted pills are sub-views
  // *inside* Home (activeSpace stays "home"), so we also gate on the lifted
  // sub-view flag — otherwise the centered hero chat bar would occlude the
  // vault preview / orphan tiles behind it.
  const isHero = activeSpace === "home" && isFirstRun && !homeSubViewActive;

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

  // T16-T18 will pass this to Desktop, ViewerWindow, and ChatBar.
  const handleArtifactPublish = useCallback((artifact: Artifact) => {
    if (artifact.builtin || artifact.plugin || artifact.status === "generating") return;
    setPublishingArtifact(artifact);
  }, []);
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
      <AuthBadge />
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
      <Home
        activeSpace={activeSpace}
        spaces={spaces}
        isHero={isHero}
        onSpaceChange={handleSpaceChange}
        onPromoteFolderToSpace={handlePromoteFolderToSpace}
        onSpaceDelete={handleSpaceDelete}
        onSpaceUpdate={handleSpaceUpdate}
        onSubViewActiveChange={setHomeSubViewActive}
        desktopProps={{
          space: activeSpace,
          spaces: spaces.map((s) => s.id),
          // Home is the unscoped feed (matches the prototype's only-pill model
          // — see #252). Per-space pills scope. __all__ kept as alias for old
          // bookmarks; __archived__ stays as its own meta-view.
          artifacts: (activeSpace === "home" || activeSpace === "__all__" || activeSpace === "__archived__")
            ? artifacts
            : artifacts.filter((a) => a.spaceId === activeSpace),
          isArchivedView,
          onArtifactClick: handleArtifactClick,
          onArtifactStop: handleArtifactStop,
          onGroupClick: (name) => {
            setOpenGroup(name);
            window.history.pushState(null, "", `/s/${activeSpace}/g/${encodeURIComponent(name.toLowerCase())}`);
          },
          onSpaceChange: handleSpaceChange,
          onConvertToSpace: handleConvertToSpace,
          onRefresh: () =>
            loadArtifacts()
              .then((nextArtifacts) => { setArtifacts(nextArtifacts); setConnected(true); })
              .catch(() => setConnected(false)),
          onArtifactUpdate: (id, fields) =>
            setArtifacts((prev) => prev.map((a) => (a.id === id ? { ...a, ...fields } : a))),
          onArtifactRemove: (id) =>
            setArtifacts((prev) => prev.filter((a) => a.id !== id)),
          revealId,
          onArtifactPublish: handleArtifactPublish,
        }}
      />

      <div className="windows-layer">
        {viewers.map((w, i) => {
          const isUnscoped = activeSpace === "home" || activeSpace === "__all__";
          const docArtifacts = isUnscoped
            ? artifacts.filter((a) => a.artifactKind !== "app")
            : artifacts.filter((a) => a.artifactKind !== "app" && a.spaceId === activeSpace);
          const currentIdx = docArtifacts.findIndex((a) => a.url === w.artifactPath);
          const hasPrev = currentIdx > 0;
          const hasNext = currentIdx >= 0 && currentIdx < docArtifacts.length - 1;
          const viewerArtifact = currentIdx >= 0 ? docArtifacts[currentIdx] : undefined;

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
              onShare={viewerArtifact ? () => handleArtifactPublish(viewerArtifact) : undefined}
              shareDisabled={!viewerArtifact || viewerArtifact.builtin || viewerArtifact.plugin || viewerArtifact.status === "generating"}
              shareLabel={viewerArtifact?.publication?.unpublishedAt === null ? "Published" : "Publish"}
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

      {publishingArtifact && (() => {
        const fresh = artifacts.find((a) => a.id === publishingArtifact.id) ?? publishingArtifact;
        return <PublishModal artifact={fresh} onClose={() => setPublishingArtifact(null)} />;
      })()}

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
        artifacts={artifacts}
        onArtifactOpen={handleArtifactClick}
        onArtifactPublish={handleArtifactPublish}
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

      {setupProposal && (
        <SetupProposalPanel
          proposal={setupProposal}
          onClose={() => setSetupProposal(null)}
          onApplied={() => {
            // Refresh spaces + artefacts so the surface reflects the new
            // structure immediately. The server's `setup_applied` SSE event
            // can also fan out to other tabs; this branch handles the apply
            // tab itself.
            void fetchSpaces().then(setSpaces).catch(() => undefined);
            void loadArtifacts().then(setArtifacts).catch(() => undefined);
            setSetupProposal(null);
          }}
        />
      )}
    </div>
  );
}
