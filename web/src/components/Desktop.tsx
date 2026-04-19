import { useRef, useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { LayoutGrid, List, ArrowDownAZ, Tag, Clock, Folder, AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import type { Artifact } from "../data/artifacts-api";
import { archiveArtifact, archiveGroup, renameGroup, restoreArtifact, uninstallPlugin, updateArtifact } from "../data/artifacts-api";
import { ArtifactIcon, typeConfig } from "./ArtifactIcon";
import { GroupIcon } from "./GroupIcon";
import Grainient from "./reactbits/Grainient";
import { spaceColor } from "../utils/spaceColor";
import { useDesktopPreferences } from "../hooks/useDesktopPreferences";
import { useDesktopSections, kindLabel } from "../hooks/useDesktopSections";
import { useDragOrder } from "../hooks/useDragOrder";
import { OnboardingBanner } from "./OnboardingBanner";

interface Props {
  space: string;
  spaces: string[];
  artifacts: Artifact[];
  isHero?: boolean;
  onArtifactClick: (artifact: Artifact) => void;
  onArtifactStop?: (artifact: Artifact) => void;
  onGroupClick: (groupName: string) => void;
  onSpaceChange: (space: string) => void;
  onAddSpace?: (folderName?: string) => void;
  onConvertToSpace?: (groupName: string, merge?: boolean, sourceSpaceId?: string) => void;
  onImportFromAI?: (spaceId?: string) => void;
  onRefresh?: () => void;
  /** Patch a single artifact in the parent's state — used for optimistic UI on rename so the label swap is instant, not a fetch round-trip later. */
  onArtifactUpdate?: (id: string, fields: Partial<Artifact>) => void;
  /** Remove a single artifact from the parent's state — used for optimistic archive / uninstall / restore so the tile disappears instantly. */
  onArtifactRemove?: (id: string) => void;
  isFirstRun?: boolean;
  dragOver?: boolean;
  revealId?: string | null;
  /** When true, render the archived-items view: context menu shows Restore / Delete permanently. */
  isArchivedView?: boolean;
}

export function Desktop({ space, spaces, artifacts, isHero, onArtifactClick, onArtifactStop, onGroupClick, onAddSpace, onConvertToSpace, onImportFromAI, onRefresh, onArtifactUpdate, onArtifactRemove, dragOver, revealId, isFirstRun, isArchivedView }: Props) {
  const isAllSpace = space === "__all__";

  // ── Onboarding banner ──
  const [bannerDismissed, setBannerDismissed] = useState(
    () => localStorage.getItem("oyster-onboarding-dismissed") === "true"
  );
  const handleDismiss = () => {
    localStorage.setItem("oyster-onboarding-dismissed", "true");
    setBannerDismissed(true);
  };

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

  // ── Artifact context menu (right-click on a tile) ──
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

  // ── Inline rename state — when set, the matching tile swaps its label for an input ──
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // ── Context-menu action handlers ──
  // Every mutation calls onRefresh so the parent refetches fresh state.
  function handleRenameArtifact(artifact: Artifact) {
    setArtifactCtx(null);
    setRenamingId(artifact.id);
  }
  async function commitArtifactRename(artifact: Artifact, nextLabel: string) {
    const trimmed = nextLabel.trim();
    setRenamingId(null);
    if (!trimmed || trimmed === artifact.label) return;
    // Optimistic: flip the label immediately so there's no flicker between
    // the input disappearing and the server round-trip completing. The next
    // poll (or onRefresh below) converges the state.
    onArtifactUpdate?.(artifact.id, { label: trimmed });
    try {
      await updateArtifact(artifact.id, { label: trimmed });
    } catch (err) {
      // Revert the optimistic change on failure.
      onArtifactUpdate?.(artifact.id, { label: artifact.label });
      alert(`Rename failed: ${(err as Error).message}`);
    }
  }
  async function handleArchiveArtifact(artifact: Artifact) {
    setArtifactCtx(null);
    onArtifactRemove?.(artifact.id);
    try { await archiveArtifact(artifact.id); }
    catch (err) { onRefresh?.(); alert(`Archive failed: ${(err as Error).message}`); }
  }
  async function handleUninstallPlugin(artifact: Artifact) {
    setArtifactCtx(null);
    if (!window.confirm(`Uninstall "${artifact.label}"? This removes the plugin folder from ~/.oyster/userland/${artifact.id}.`)) return;
    onArtifactRemove?.(artifact.id);
    try { await uninstallPlugin(artifact.id); }
    catch (err) { onRefresh?.(); alert(`Uninstall failed: ${(err as Error).message}`); }
  }
  async function handleRestoreArtifact(artifact: Artifact) {
    setArtifactCtx(null);
    // Optimistically remove from the archived view; the next refresh
    // refetches the archived list and confirms.
    onArtifactRemove?.(artifact.id);
    try { await restoreArtifact(artifact.id); }
    catch (err) { onRefresh?.(); alert(`Restore failed: ${(err as Error).message}`); }
  }
  async function handleRenameGroup(oldName: string, sourceSpaceId?: string) {
    setFolderCtx(null);
    const next = window.prompt("Rename folder", oldName);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === oldName) return;
    const targetSpace = sourceSpaceId ?? space;
    try { await renameGroup(targetSpace, oldName, trimmed); onRefresh?.(); }
    catch (err) { alert(`Rename folder failed: ${(err as Error).message}`); }
  }
  async function handleArchiveGroup(name: string, sourceSpaceId?: string) {
    setFolderCtx(null);
    const targetSpace = sourceSpaceId ?? space;
    if (!window.confirm(`Archive folder "${name}" and all its artifacts?`)) return;
    try { await archiveGroup(targetSpace, name); onRefresh?.(); }
    catch (err) { alert(`Archive folder failed: ${(err as Error).message}`); }
  }

  // ── Topbar auto-hide ──
  const [topbarVisible, setTopbarVisible] = useState(true);
  const topbarHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showTopbar = useCallback(() => {
    if (topbarHideTimer.current) clearTimeout(topbarHideTimer.current);
    setTopbarVisible(true);
  }, []);

  const scheduleHideTopbar = useCallback(() => {
    if (topbarHideTimer.current) clearTimeout(topbarHideTimer.current);
    topbarHideTimer.current = setTimeout(() => setTopbarVisible(false), 2000);
  }, []);

  useEffect(() => {
    scheduleHideTopbar();
    return () => { if (topbarHideTimer.current) clearTimeout(topbarHideTimer.current); };
  }, [scheduleHideTopbar]);

  // ── Preferences (view/sort/filter, all localStorage-backed) ──
  const {
    viewMode, setAndSaveViewMode,
    sortMode, setAndSaveSortMode,
    sortDir,
    groupBy, setAndSaveGroupBy,
    headerAlign, setAndSaveHeaderAlign,
    activeKind, selectKind,
    flatMode, setAndSaveFlatMode, effectiveFlatMode,
    kindDropdownOpen, setKindDropdownOpen,
    handleColSort,
    uniqueKinds,
    filteredArtifacts,
  } = useDesktopPreferences(space, artifacts);

  // ── Derived sections (sorted/grouped item lists for grid and list views) ──
  const { orderedItems, listSections, allGridSections } = useDesktopSections({
    filteredArtifacts, isAllSpace, sortMode, sortDir, groupBy, space, flatMode: effectiveFlatMode,
  });

  // ── Drag-to-reorder ──
  const { gridRef, dragKey, displayItems, onPointerDown } = useDragOrder(space, sortMode, orderedItems);

  return (
    <div className="desktop">
      <div className="desktop-bg">
        <Grainient
          color1="#07060f"
          color2="#7c6bff"
          color3="#5227FF"
          timeSpeed={dragOver ? 2 : 0.15}
          colorBalance={0}
          warpStrength={2}
          warpFrequency={6.5}
          warpSpeed={2}
          warpAmplitude={20}
          blendAngle={0}
          blendSoftness={0.05}
          rotationAmount={500}
          noiseScale={2}
          grainAmount={0.15}
          grainScale={2}
          grainAnimated={false}
          contrast={1.2}
          gamma={0.8}
          saturation={0.7}
          centerX={0}
          centerY={0}
          zoom={1}
        />
      </div>

      <div className="topbar-hover-zone" onMouseEnter={showTopbar} />
      <div
        className={`desktop-topbar${topbarVisible ? "" : " desktop-topbar-hidden"}`}
        onMouseEnter={showTopbar}
        onMouseLeave={scheduleHideTopbar}
      >
        <div className="topbar-left">
          <div className="ctrl-group-labeled">
            <span className="ctrl-group-label">sort</span>
            <div className="ctrl-group">
              <button className={`view-btn${sortMode === "alpha" ? " active" : ""}`} onClick={() => setAndSaveSortMode("alpha")} title="A–Z">
                <ArrowDownAZ size={13} />
              </button>
              <button className={`view-btn${sortMode === "kind" ? " active" : ""}`} onClick={() => setAndSaveSortMode("kind")} title="By kind">
                <Tag size={13} />
              </button>
              <button className={`view-btn${sortMode === "timeline" ? " active" : ""}`} onClick={() => setAndSaveSortMode("timeline")} title="Recent">
                <Clock size={13} />
              </button>
              {!isAllSpace && (
                <button className={`view-btn${sortMode === "group" ? " active" : ""}`} onClick={() => setAndSaveSortMode("group")} title="By folder">
                  <Folder size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="ctrl-group-labeled">
            <span className="ctrl-group-label">folders</span>
            <button
              className={`ios-toggle${!effectiveFlatMode ? " on" : ""}`}
              onClick={() => setAndSaveFlatMode(!flatMode)}
              title={effectiveFlatMode ? "Show folders" : "Flatten folders"}
              aria-pressed={!effectiveFlatMode}
            >
              <span className="ios-toggle-thumb" />
            </button>
          </div>
          {isAllSpace && (
              <div className="ctrl-group-labeled">
                <span className="ctrl-group-label">group</span>
                <div className="ctrl-group">
                  <button className={`view-btn filter-pill-btn${groupBy === "none" ? " active" : ""}`} onClick={() => setAndSaveGroupBy("none")}>none</button>
                  <button className={`view-btn filter-pill-btn${groupBy === "space" ? " active" : ""}`} onClick={() => setAndSaveGroupBy("space")}>space</button>
                  <button className={`view-btn filter-pill-btn${groupBy === "kind" ? " active" : ""}`} onClick={() => setAndSaveGroupBy("kind")}>kind</button>
                </div>
              </div>
          )}
          <div className="ctrl-group-labeled">
            <span className="ctrl-group-label">align</span>
            <div className="ctrl-group">
              <button className={`view-btn${headerAlign === "left" ? " active" : ""}`} onClick={() => setAndSaveHeaderAlign("left")} title="Left"><AlignLeft size={13} /></button>
              <button className={`view-btn${headerAlign === "center" ? " active" : ""}`} onClick={() => setAndSaveHeaderAlign("center")} title="Center"><AlignCenter size={13} /></button>
              <button className={`view-btn${headerAlign === "right" ? " active" : ""}`} onClick={() => setAndSaveHeaderAlign("right")} title="Right"><AlignRight size={13} /></button>
            </div>
          </div>
          <div className="ctrl-group-labeled">
            <span className="ctrl-group-label">show</span>
            <div className="ctrl-group topbar-filter-pills">
              <button className={`view-btn filter-pill-btn${!activeKind ? " active" : ""}`} onClick={() => selectKind(null)}>all</button>
              {uniqueKinds.map((k) => (
                <button key={k} className={`view-btn filter-pill-btn${activeKind === k ? " active" : ""}`} onClick={() => selectKind(k)}>{kindLabel(k)}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="topbar-right" />
      </div>

      <div className={`desktop-scroll${isHero ? " desktop-scroll--hero" : ""}`}>
        {isFirstRun && !bannerDismissed && (
          <OnboardingBanner
            onImportFromAI={() => {
              const importArtifact = artifacts.find((a) => a.id.endsWith("import-from-ai"));
              if (importArtifact) onArtifactClick(importArtifact);
            }}
            onDismiss={handleDismiss}
          />
        )}
        <div className="filter-bar">
          {activeKind && (
            <div className="filter-notice">
              <div className="filter-notice-kind-wrap">
                {uniqueKinds.length > 1 ? (
                  <>
                    <button
                      className="filter-notice-kind"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => setKindDropdownOpen((v) => !v)}
                    >
                      {kindLabel(activeKind)} ▾
                    </button>
                    {kindDropdownOpen && (
                      <div className="filter-kind-dropdown">
                        {uniqueKinds.filter((k) => k !== activeKind).map((k) => (
                          <button
                            key={k}
                            className="filter-kind-option"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => { selectKind(k); setKindDropdownOpen(false); }}
                          >
                            {kindLabel(k)}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <span className="filter-notice-kind">{kindLabel(activeKind)}</span>
                )}
              </div>
              <button className="filter-notice-clear" onClick={() => { selectKind(null); setKindDropdownOpen(false); }}>✕</button>
            </div>
          )}
          <div className="view-toggle-float">
            <button className={`view-btn${viewMode === "grid" ? " active" : ""}`} onClick={() => setAndSaveViewMode("grid")} title="Grid">
              <LayoutGrid size={13} />
            </button>
            <button className={`view-btn${viewMode === "list" ? " active" : ""}`} onClick={() => setAndSaveViewMode("list")} title="List">
              <List size={13} />
            </button>
          </div>
        </div>

        {/* Empty space state */}
        {!isHero && !isAllSpace && artifacts.length === 0 && (
          <div className="empty-space-state">
            <div className="empty-space-hint">This space is empty</div>
            <div className="empty-space-actions">
              {onImportFromAI && (
                <button className="empty-space-action" onClick={() => onImportFromAI(space)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Import from AI
                </button>
              )}
              <button className="empty-space-action" onClick={() => onAddSpace?.()}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.7 }}>
                  <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
                </svg>
                Import folder
              </button>
            </div>
          </div>
        )}

        {viewMode === "list" ? (
          <div className={`list-view${isAllSpace && groupBy === "kind" ? " list-view--no-badge" : ""}${!isAllSpace || groupBy === "space" ? " list-view--no-space" : ""}`}>
            <div className="list-col-headers">
              <span />
              <button className={`list-col-header${sortMode === "alpha" ? " active" : ""}`} onClick={() => handleColSort("alpha")}>
                Name{sortMode === "alpha" ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
              </button>
              {(!isAllSpace || groupBy !== "kind") && (
                <button className={`list-col-header list-col-header--right${sortMode === "kind" ? " active" : ""}`} onClick={() => handleColSort("kind")}>
                  Kind{sortMode === "kind" ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
                </button>
              )}
              {isAllSpace && groupBy !== "space" && (
                <button className={`list-col-header list-col-header--right${sortMode === "space" ? " active" : ""}`} onClick={() => handleColSort("space")}>
                  Space{sortMode === "space" ? (sortDir === "desc" ? " ↓" : " ↑") : ""}
                </button>
              )}
            </div>
            {listSections.map((section) => (
              <div key={section.key} className="list-section">
                {section.header && (
                  <div className="list-section-header" style={{ textAlign: headerAlign }}>{section.header}</div>
                )}
                {section.artifacts.map((a) => (
                  <div key={a.id} className="list-row" onClick={() => onArtifactClick(a)}>
                    <div className="list-row-dot" style={{ background: (typeConfig[a.artifactKind] || typeConfig.app).color }} />
                    <span className="list-row-label">{a.label}</span>
                    {(!isAllSpace || groupBy !== "kind") && <span className="list-row-badge">{a.artifactKind}</span>}
                    {isAllSpace && groupBy !== "space" && (() => {
                      const c = spaceColor(a.spaceId);
                      return <span className="list-row-space" style={{ color: "rgba(255,255,255,0.7)", background: `${c}40` }}>{a.spaceId}</span>;
                    })()}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : isAllSpace && allGridSections ? (
          <div className="all-grid-view">
            {allGridSections.map((section) => (
              <div key={section.spaceId} className="all-grid-section">
                <div className="all-grid-section-header" style={{ textAlign: headerAlign }}>{section.header}</div>
                <div className="icon-grid icon-grid--inline" style={{ justifyContent: headerAlign === "left" ? "start" : headerAlign === "right" ? "end" : "center" }}>
                  {section.items.map((item, i) => (
                    item.type === "group" ? (
                      <GroupIcon key={item.key} name={item.name} artifacts={item.artifacts} index={i} onClick={() => onGroupClick(item.name)} onContextMenu={(e) => { e.preventDefault(); setFolderCtx({ name: item.name, sourceSpaceId: section.spaceId, x: e.clientX, y: e.clientY }); }} />
                    ) : (
                      <ArtifactIcon
                        key={item.key}
                        artifact={item.artifact}
                        index={i}
                        onClick={() => onArtifactClick(item.artifact)}
                        onStop={onArtifactStop ? () => onArtifactStop(item.artifact) : undefined}
                        reveal={item.artifact.id === revealId}
                      />
                    )
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="icon-grid" ref={gridRef} style={{ justifyContent: headerAlign === "left" ? "start" : headerAlign === "right" ? "end" : "center" }}>
            {displayItems.map((item, i) => {
              const isDragged = item.key === dragKey;
              return (
                <div
                  key={item.key}
                  data-drag-key={item.key}
                  className={isDragged ? "drag-placeholder" : ""}
                  onPointerDown={(e) => onPointerDown(e, item.key)}
                  style={isDragged ? undefined : { transition: "transform 0.25s ease" }}
                >
                  {item.type === "group" ? (
                    <GroupIcon name={item.name} artifacts={item.artifacts} index={i} onClick={() => onGroupClick(item.name)} onContextMenu={(e) => { e.preventDefault(); setArtifactCtx(null); setFolderCtx({ name: item.name, x: e.clientX, y: e.clientY }); }} />
                  ) : (
                    <ArtifactIcon
                      artifact={item.artifact}
                      index={i}
                      onClick={() => onArtifactClick(item.artifact)}
                      onStop={onArtifactStop ? () => onArtifactStop(item.artifact) : undefined}
                      onContextMenu={(e) => { e.preventDefault(); setFolderCtx(null); setArtifactCtx({ artifact: item.artifact, x: e.clientX, y: e.clientY }); }}
                      reveal={item.artifact.id === revealId}
                      isRenaming={renamingId === item.artifact.id}
                      onRenameCommit={(label) => commitArtifactRename(item.artifact, label)}
                      onRenameCancel={() => setRenamingId(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
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
                  <button className="space-ctx-item" onClick={() => { onConvertToSpace(folderCtx.name, true, folderCtx.sourceSpaceId); setFolderCtx(null); }}>
                    Merge
                  </button>
                  <button className="space-ctx-item" onClick={() => { onConvertToSpace(folderCtx.name + " (2)", false, folderCtx.sourceSpaceId); setFolderCtx(null); }}>
                    Create "{folderCtx.name} (2)"
                  </button>
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
            // In the Archived view the only supported action is Restore
            // (store.resurface clears removed_at). Hard-delete was cut for
            // v1 because we'd either leave orphan files on disk or risk
            // deleting onboarded files Oyster doesn't own.
            <button className="space-ctx-item" onClick={() => handleRestoreArtifact(artifactCtx.artifact)}>
              Restore
            </button>
          ) : artifactCtx.artifact.builtin ? (
            // Builtins are re-seeded from the package on every boot — the
            // menu is a no-op read-only marker rather than surfacing actions
            // that would either fail or be reverted on next start.
            <span className="space-ctx-confirm" style={{ padding: "6px 12px" }}>
              Read-only (built-in)
            </span>
          ) : (
            <>
              <button className="space-ctx-item" onClick={() => handleRenameArtifact(artifactCtx.artifact)}>
                Rename
              </button>
              <div className="space-ctx-sep" />
              {artifactCtx.artifact.plugin ? (
                <button className="space-ctx-item space-ctx-delete" onClick={() => handleUninstallPlugin(artifactCtx.artifact)}>
                  Uninstall
                </button>
              ) : (
                <button className="space-ctx-item space-ctx-delete" onClick={() => handleArchiveArtifact(artifactCtx.artifact)}>
                  Archive
                </button>
              )}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
