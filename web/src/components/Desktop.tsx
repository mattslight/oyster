import { useRef, useState, useCallback, useEffect } from "react";
import { LayoutGrid, List, ArrowDownAZ, Tag, Clock, Folder, AlignLeft, AlignCenter, AlignRight } from "lucide-react";
import type { Artifact } from "../data/artifacts-api";
import { ArtifactIcon, typeConfig } from "./ArtifactIcon";
import { GroupIcon } from "./GroupIcon";
import Grainient from "./reactbits/Grainient";
import { spaceColor } from "../utils/spaceColor";
import { useDesktopPreferences } from "../hooks/useDesktopPreferences";
import { useDesktopSections, kindLabel } from "../hooks/useDesktopSections";
import { useDragOrder } from "../hooks/useDragOrder";

interface Props {
  space: string;
  spaces: string[];
  artifacts: Artifact[];
  isHero?: boolean;
  onArtifactClick: (artifact: Artifact) => void;
  onArtifactStop?: (artifact: Artifact) => void;
  onGroupClick: (groupName: string) => void;
  onSpaceChange: (space: string) => void;
}

export function Desktop({ space, artifacts, isHero, onArtifactClick, onArtifactStop, onGroupClick }: Props) {
  const isAllSpace = space === "__all__";

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
          timeSpeed={0.15}
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
          {!isAllSpace && (
            <div className="ctrl-group-labeled">
              <span className="ctrl-group-label">folders</span>
              <button
                className={`ios-toggle${!effectiveFlatMode ? " on" : ""}`}
                onClick={() => setAndSaveFlatMode(effectiveFlatMode)}
                title={effectiveFlatMode ? "Show folders" : "Flatten folders"}
                aria-pressed={!effectiveFlatMode}
              >
                <span className="ios-toggle-thumb" />
              </button>
            </div>
          )}
          {isAllSpace && (
            <>
              <div className="ctrl-group-labeled">
                <span className="ctrl-group-label">group</span>
                <div className="ctrl-group">
                  <button className={`view-btn filter-pill-btn${groupBy === "none" ? " active" : ""}`} onClick={() => setAndSaveGroupBy("none")}>none</button>
                  <button className={`view-btn filter-pill-btn${groupBy === "space" ? " active" : ""}`} onClick={() => setAndSaveGroupBy("space")}>space</button>
                  <button className={`view-btn filter-pill-btn${groupBy === "kind" ? " active" : ""}`} onClick={() => setAndSaveGroupBy("kind")}>kind</button>
                </div>
              </div>
              <div className="ctrl-group-labeled">
                <span className="ctrl-group-label">align</span>
                <div className="ctrl-group">
                  <button className={`view-btn${headerAlign === "left" ? " active" : ""}`} onClick={() => setAndSaveHeaderAlign("left")} title="Left"><AlignLeft size={13} /></button>
                  <button className={`view-btn${headerAlign === "center" ? " active" : ""}`} onClick={() => setAndSaveHeaderAlign("center")} title="Center"><AlignCenter size={13} /></button>
                  <button className={`view-btn${headerAlign === "right" ? " active" : ""}`} onClick={() => setAndSaveHeaderAlign("right")} title="Right"><AlignRight size={13} /></button>
                </div>
              </div>
            </>
          )}
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
        {activeKind ? (
          <div className="filter-notice">
            <span>Showing</span>
            <div className="filter-notice-kind-wrap">
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
                      onClick={() => { selectKind(k); setKindDropdownOpen(false); }}
                    >
                      {kindLabel(k)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="filter-notice-clear" onClick={() => { selectKind(null); setKindDropdownOpen(false); }}>✕</button>
          </div>
        ) : (
          <div className="view-toggle-float">
            <button className={`view-btn${viewMode === "grid" ? " active" : ""}`} onClick={() => setAndSaveViewMode("grid")} title="Grid">
              <LayoutGrid size={13} />
            </button>
            <button className={`view-btn${viewMode === "list" ? " active" : ""}`} onClick={() => setAndSaveViewMode("list")} title="List">
              <List size={13} />
            </button>
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
                      return <span className="list-row-space" style={{ color: c, background: `${c}28` }}>{a.spaceId}</span>;
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
                      <GroupIcon key={item.key} name={item.name} artifacts={item.artifacts} index={i} onClick={() => onGroupClick(item.name)} />
                    ) : (
                      <ArtifactIcon
                        key={item.key}
                        artifact={item.artifact}
                        index={i}
                        onClick={() => onArtifactClick(item.artifact)}
                        onStop={onArtifactStop ? () => onArtifactStop(item.artifact) : undefined}
                      />
                    )
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="icon-grid" ref={gridRef}>
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
                    <GroupIcon name={item.name} artifacts={item.artifacts} index={i} onClick={() => onGroupClick(item.name)} />
                  ) : (
                    <ArtifactIcon
                      artifact={item.artifact}
                      index={i}
                      onClick={() => onArtifactClick(item.artifact)}
                      onStop={onArtifactStop ? () => onArtifactStop(item.artifact) : undefined}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
