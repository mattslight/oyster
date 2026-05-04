import { useRef, useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { Archive } from "lucide-react";
import type { Artifact } from "../data/artifacts-api";
import { archiveArtifact, archiveGroup, regenerateIcon, renameGroup, restoreArtifact, uninstallPlugin, updateArtifact } from "../data/artifacts-api";
import { unpublishArtifact } from "../data/publish-api";
import { ArtifactIcon } from "./ArtifactIcon";
import { ConfirmModal } from "./ConfirmModal";
import { PromptModal } from "./PromptModal";
import { GroupIcon } from "./GroupIcon";

interface Props {
  space: string;
  spaces: string[];
  artifacts: Artifact[];
  isHero?: boolean;
  onArtifactClick: (artifact: Artifact) => void;
  onArtifactStop?: (artifact: Artifact) => void;
  onGroupClick: (groupName: string) => void;
  onSpaceChange: (space: string) => void;
  onConvertToSpace?: (groupName: string, merge?: boolean, sourceSpaceId?: string) => void;
  onRefresh?: () => void;
  onArtifactUpdate?: (id: string, fields: Partial<Artifact>) => void;
  onArtifactRemove?: (id: string) => void;
  revealId?: string | null;
  isArchivedView?: boolean;
  /** Render relative-time meta line under each artifact label. Used by Home. */
  showMeta?: boolean;
  /** Bypass the groupName → folder-tile bucketing and render every artefact
   *  as its own tile. Used by status-style filters like "published" where
   *  bucketing by source-folder hides the result the user just asked for. */
  flatten?: boolean;
  onArtifactPublish?: (artifact: Artifact) => void;
}

type DisplayItem =
  | { type: "group"; key: string; name: string; artifacts: Artifact[] }
  | { type: "artifact"; key: string; artifact: Artifact };

export function Desktop({ space, spaces, artifacts, isHero, onArtifactClick, onArtifactStop, onGroupClick, onSpaceChange, onConvertToSpace, onRefresh, onArtifactUpdate, onArtifactRemove, revealId, isArchivedView, showMeta, flatten, onArtifactPublish }: Props) {
  const isAllSpace = space === "__all__";
  // Meta-spaces span multiple real spaces, so groupName is no longer unique —
  // `notes` from space A would merge with `notes` from space B into a single
  // tile. Flatten in those views. With #252 collapsing the `All` pill into
  // Home, `home` is now the unscoped view too and gets the same treatment.
  const isMetaSpace = space === "home" || isAllSpace || isArchivedView === true;

  // ── Folder context menu ──
  const [folderCtx, setFolderCtx] = useState<{ name: string; sourceSpaceId?: string; x: number; y: number } | null>(null);
  const folderCtxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!folderCtx) return;
    function handleClick(e: MouseEvent) {
      if (folderCtxRef.current && !folderCtxRef.current.contains(e.target as Node)) setFolderCtx(null);
    }
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [folderCtx]);

  // ── Artifact context menu ──
  const [artifactCtx, setArtifactCtx] = useState<{ artifact: Artifact; x: number; y: number } | null>(null);
  const artifactCtxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!artifactCtx) return;
    function handleClick(e: MouseEvent) {
      if (artifactCtxRef.current && !artifactCtxRef.current.contains(e.target as Node)) setArtifactCtx(null);
    }
    window.addEventListener("mousedown", handleClick);
    return () => window.removeEventListener("mousedown", handleClick);
  }, [artifactCtx]);

  // ── Inline rename ──
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // ── Modals ──
  type ConfirmState = { open: boolean; title: string; body?: React.ReactNode; confirmLabel?: string; destructive?: boolean; onConfirm: () => void };
  const [confirmState, setConfirmState] = useState<ConfirmState>({ open: false, title: "", onConfirm: () => {} });
  type AlertState = { open: boolean; title: string; body?: React.ReactNode };
  const [alertState, setAlertState] = useState<AlertState>({ open: false, title: "" });
  type PromptState = { open: boolean; title: string; body?: React.ReactNode; initialValue?: string; confirmLabel?: string; onSubmit: (value: string) => void };
  const [promptState, setPromptState] = useState<PromptState>({ open: false, title: "", onSubmit: () => {} });

  // ── Action handlers ──
  function handleRenameArtifact(artifact: Artifact) {
    setArtifactCtx(null);
    setRenamingId(artifact.id);
  }
  async function commitArtifactRename(artifact: Artifact, nextLabel: string) {
    const trimmed = nextLabel.trim();
    setRenamingId(null);
    if (!trimmed || trimmed === artifact.label) return;
    onArtifactUpdate?.(artifact.id, { label: trimmed });
    try {
      await updateArtifact(artifact.id, { label: trimmed });
    } catch (err) {
      onArtifactUpdate?.(artifact.id, { label: artifact.label });
      setAlertState({ open: true, title: "Rename failed", body: (err as Error).message });
    }
  }
  async function handleArchiveArtifact(artifact: Artifact) {
    setArtifactCtx(null);
    onArtifactRemove?.(artifact.id);
    try { await archiveArtifact(artifact.id); }
    catch (err) { onRefresh?.(); setAlertState({ open: true, title: "Archive failed", body: (err as Error).message }); }
  }
  function handleUninstallPlugin(artifact: Artifact) {
    setArtifactCtx(null);
    const folderId = artifact.pluginId ?? artifact.id;
    setConfirmState({
      open: true,
      title: `Uninstall "${artifact.label}"?`,
      body: <>This removes the app's folder from your Oyster workspace.</>,
      confirmLabel: "Uninstall",
      destructive: true,
      onConfirm: async () => {
        setConfirmState((s) => ({ ...s, open: false }));
        onArtifactRemove?.(artifact.id);
        try { await uninstallPlugin(folderId); }
        catch (err) { onRefresh?.(); setAlertState({ open: true, title: "Uninstall failed", body: (err as Error).message }); }
      },
    });
  }
  async function handleRegenerateIcon(artifact: Artifact) {
    setArtifactCtx(null);
    try { await regenerateIcon(artifact.id); onRefresh?.(); }
    catch (err) { setAlertState({ open: true, title: "Regenerate icon failed", body: (err as Error).message }); }
  }
  async function handleRestoreArtifact(artifact: Artifact) {
    setArtifactCtx(null);
    onArtifactRemove?.(artifact.id);
    try { await restoreArtifact(artifact.id); }
    catch (err) { onRefresh?.(); setAlertState({ open: true, title: "Restore failed", body: (err as Error).message }); }
  }
  function handleRenameGroup(oldName: string, sourceSpaceId?: string) {
    setFolderCtx(null);
    const targetSpace = sourceSpaceId ?? space;
    setPromptState({
      open: true, title: "Rename folder", initialValue: oldName, confirmLabel: "Rename",
      onSubmit: async (value: string) => {
        setPromptState((s) => ({ ...s, open: false }));
        const trimmed = value.trim();
        if (!trimmed || trimmed === oldName) return;
        try { await renameGroup(targetSpace, oldName, trimmed); onRefresh?.(); }
        catch (err) { setAlertState({ open: true, title: "Rename folder failed", body: (err as Error).message }); }
      },
    });
  }
  function handleArchiveGroup(name: string, sourceSpaceId?: string) {
    setFolderCtx(null);
    const targetSpace = sourceSpaceId ?? space;
    setConfirmState({
      open: true, title: `Archive folder "${name}"?`,
      body: <>All artifacts inside are archived with it. You can restore from the archived view later.</>,
      confirmLabel: "Archive", destructive: true,
      onConfirm: async () => {
        setConfirmState((s) => ({ ...s, open: false }));
        try { await archiveGroup(targetSpace, name); onRefresh?.(); }
        catch (err) { setAlertState({ open: true, title: "Archive folder failed", body: (err as Error).message }); }
      },
    });
  }

  // ── Display items — groups first (alpha), then ungrouped (alpha) ──
  const displayItems = useMemo((): DisplayItem[] => {
    const sorted = [...artifacts].sort((a, b) => a.label.localeCompare(b.label));
    if (isMetaSpace || flatten) {
      return sorted.map((a): DisplayItem => ({ type: "artifact", key: a.id, artifact: a }));
    }
    const groupMap = new Map<string, Artifact[]>();
    const ungrouped: Artifact[] = [];
    for (const a of sorted) {
      if (a.groupName) {
        const g = groupMap.get(a.groupName) ?? [];
        g.push(a);
        groupMap.set(a.groupName, g);
      } else {
        ungrouped.push(a);
      }
    }
    const items: DisplayItem[] = [];
    for (const [name, arts] of [...groupMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      items.push({ type: "group", key: `group:${name}`, name, artifacts: arts });
    }
    for (const a of ungrouped) {
      items.push({ type: "artifact", key: a.id, artifact: a });
    }
    return items;
  }, [artifacts, isMetaSpace, flatten]);

  return (
    <div className="desktop">
      <div className="desktop-glow" />
      <div className="desktop-orb" />
      <div className="desktop-grain" />

      <div className={`desktop-scroll${isHero ? " desktop-scroll--hero" : ""}`}>
        {!isHero && !isAllSpace && artifacts.length === 0 && (
          <div className="empty-space-state">
            <div className="empty-space-hint">This space is empty</div>
          </div>
        )}

        <div className="icon-grid">
          {displayItems.map((item, i) => (
            item.type === "group" ? (
              <GroupIcon
                key={item.key}
                name={item.name}
                artifacts={item.artifacts}
                index={i}
                onClick={() => onGroupClick(item.name)}
                onContextMenu={
                  isArchivedView || isAllSpace
                    ? (e) => e.preventDefault()
                    : (e) => { e.preventDefault(); setArtifactCtx(null); setFolderCtx({ name: item.name, x: e.clientX, y: e.clientY }); }
                }
              />
            ) : (
              <ArtifactIcon
                key={item.key}
                artifact={item.artifact}
                index={i}
                onClick={() => onArtifactClick(item.artifact)}
                onStop={onArtifactStop ? () => onArtifactStop(item.artifact) : undefined}
                onContextMenu={(e) => { e.preventDefault(); setFolderCtx(null); setArtifactCtx({ artifact: item.artifact, x: e.clientX, y: e.clientY }); }}
                reveal={item.artifact.id === revealId}
                isRenaming={renamingId === item.artifact.id}
                onRenameCommit={(label) => commitArtifactRename(item.artifact, label)}
                onRenameCancel={() => setRenamingId(null)}
                showMeta={showMeta}
              />
            )
          ))}
        </div>
      </div>

      <div className="version-badge">v{__APP_VERSION__} · {__APP_ENV__}</div>

      {folderCtx && createPortal(
        <div
          ref={folderCtxRef}
          className="space-ctx-menu"
          style={{ left: folderCtx.x, top: folderCtx.y, transform: "translateY(-100%)", marginTop: -8 }}
        >
          <button className="space-ctx-item" onClick={() => handleRenameGroup(folderCtx.name, folderCtx.sourceSpaceId)}>
            Rename folder
          </button>
          {onConvertToSpace && (() => {
            const slug = folderCtx.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
            const hasConflict = spaces.includes(slug);
            if (hasConflict) {
              return (
                <>
                  <span className="space-ctx-confirm" style={{ padding: "6px 12px" }}>"{folderCtx.name}" space exists.</span>
                  <button className="space-ctx-item" onClick={() => { onConvertToSpace(folderCtx.name, true, folderCtx.sourceSpaceId); setFolderCtx(null); }}>Merge</button>
                  <button className="space-ctx-item" onClick={() => { onConvertToSpace(folderCtx.name + " (2)", false, folderCtx.sourceSpaceId); setFolderCtx(null); }}>Create "{folderCtx.name} (2)"</button>
                </>
              );
            }
            return (
              <button className="space-ctx-item" onClick={() => { onConvertToSpace(folderCtx.name, false, folderCtx.sourceSpaceId); setFolderCtx(null); }}>
                Convert to Space
              </button>
            );
          })()}
          <div className="space-ctx-sep" />
          <button className="space-ctx-item space-ctx-delete" onClick={() => handleArchiveGroup(folderCtx.name, folderCtx.sourceSpaceId)}>
            Archive folder
          </button>
        </div>,
        document.body,
      )}

      {artifactCtx && createPortal(
        <div
          ref={artifactCtxRef}
          className="space-ctx-menu"
          style={{ left: artifactCtx.x, top: artifactCtx.y, transform: "translateY(-100%)", marginTop: -8 }}
        >
          {isArchivedView ? (
            <button className="space-ctx-item" onClick={() => handleRestoreArtifact(artifactCtx.artifact)}>Restore</button>
          ) : artifactCtx.artifact.builtin ? (
            <button className="space-ctx-item" onClick={() => handleRegenerateIcon(artifactCtx.artifact)}>Regenerate icon</button>
          ) : (
            <>
              <button className="space-ctx-item" onClick={() => handleRenameArtifact(artifactCtx.artifact)}>Rename</button>
              <button className="space-ctx-item" onClick={() => handleRegenerateIcon(artifactCtx.artifact)}>Regenerate icon</button>
              {!isArchivedView && !artifactCtx.artifact.builtin && !artifactCtx.artifact.plugin && artifactCtx.artifact.status !== "generating" && onArtifactPublish && (
                artifactCtx.artifact.publication?.unpublishedAt === null ? (
                  <>
                    <button
                      className="space-ctx-item"
                      onClick={() => {
                        const a = artifactCtx.artifact;
                        setArtifactCtx(null);
                        onArtifactPublish(a);
                      }}
                    >
                      Edit share…
                    </button>
                    <button
                      className="space-ctx-item"
                      onClick={async () => {
                        const a = artifactCtx.artifact;
                        setArtifactCtx(null);
                        try { await unpublishArtifact(a.id); }
                        catch (err) { setAlertState({ open: true, title: "Unpublish failed", body: (err as Error).message }); }
                      }}
                    >
                      Unpublish
                    </button>
                  </>
                ) : (
                  <button
                    className="space-ctx-item"
                    onClick={() => {
                      const a = artifactCtx.artifact;
                      setArtifactCtx(null);
                      onArtifactPublish(a);
                    }}
                  >
                    Publish…
                  </button>
                )
              )}
              <div className="space-ctx-sep" />
              {artifactCtx.artifact.plugin ? (
                <button className="space-ctx-item space-ctx-delete" onClick={() => handleUninstallPlugin(artifactCtx.artifact)}>Uninstall</button>
              ) : (
                <button className="space-ctx-item space-ctx-delete" onClick={() => handleArchiveArtifact(artifactCtx.artifact)}>Archive</button>
              )}
            </>
          )}
        </div>,
        document.body,
      )}

      <ConfirmModal
        open={confirmState.open}
        title={confirmState.title}
        body={confirmState.body}
        confirmLabel={confirmState.confirmLabel}
        destructive={confirmState.destructive}
        onConfirm={confirmState.onConfirm}
        onCancel={() => setConfirmState((s) => ({ ...s, open: false }))}
      />
      <ConfirmModal
        open={alertState.open}
        title={alertState.title}
        body={alertState.body}
        confirmLabel="OK"
        cancelLabel={null}
        onConfirm={() => setAlertState({ open: false, title: "" })}
        onCancel={() => setAlertState({ open: false, title: "" })}
      />
      <PromptModal
        open={promptState.open}
        title={promptState.title}
        body={promptState.body}
        initialValue={promptState.initialValue}
        confirmLabel={promptState.confirmLabel}
        onSubmit={promptState.onSubmit}
        onCancel={() => setPromptState((s) => ({ ...s, open: false }))}
      />

      {space !== "__archived__" && renamingId === null && (
        <button
          className="archived-shortcut"
          onClick={() => onSpaceChange("__archived__")}
          title="Archived"
          aria-label="View archived artifacts"
        >
          <Archive size={20} strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
