// Artefact table view. Extracted from Home/index.tsx.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Lock } from "lucide-react";
import type { Artifact, Space } from "../../../../shared/types";
import type { Desktop } from "../Desktop";
import { parseTimestamp } from "../../utils/parseTimestamp";
import { formatRelative } from "./utils";
import { pinArtifact, unpinArtifact } from "../../data/artifacts-api";
import { unpublishArtifact, unpublishCloudShare } from "../../data/publish-api";

interface ArtefactTableProps {
  artifacts: Parameters<typeof Desktop>[0]["artifacts"];
  spaces: Space[];
  onArtifactClick: Parameters<typeof Desktop>[0]["onArtifactClick"];
  onArtifactPublish?: (artifact: Artifact) => void;
}

export function ArtefactTable({ artifacts, spaces, onArtifactClick, onArtifactPublish }: ArtefactTableProps) {
  const [ctx, setCtx] = useState<{ artifact: Artifact; x: number; y: number } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Click-outside / Escape closes the menu.
  useEffect(() => {
    if (!ctx) return;
    function onDocClick(e: MouseEvent) {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) setCtx(null);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setCtx(null); }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctx]);

  if (artifacts.length === 0) {
    return <div className="home-empty">No artefacts here yet.</div>;
  }
  const sorted = [...artifacts].sort((a, b) => {
    // Pinned-first (#387) — pinned artefacts always bubble to the top in
    // both icon and table views. Order within the pinned group is by pin
    // time DESC (newest pin first); unpinned rows then fall through to
    // the existing createdAt DESC sort.
    const ap = a.pinnedAt ?? 0;
    const bp = b.pinnedAt ?? 0;
    if (ap !== bp) return bp - ap;
    const ta = parseTimestamp(a.createdAt);
    const tb = parseTimestamp(b.createdAt);
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
  });

  const isPublished = ctx?.artifact.publication?.unpublishedAt === null;
  const isCloudOnly = !!ctx?.artifact.cloudOnly;

  return (
    <div className="home-table-wrap">
      <div className="home-table">
        {sorted.map((art) => {
          const space = spaces.find((s) => s.id === art.spaceId);
          return (
            <div
              key={art.id}
              className="home-artefact-row"
              role="button"
              tabIndex={0}
              onClick={() => onArtifactClick(art)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtx({ artifact: art, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onArtifactClick(art);
                }
              }}
            >
              <span className="home-artefact-row-title">
                {art.label}
                {art.publication?.unpublishedAt === null && art.publication.shareMode === "password" && (
                  <Lock
                    size={11}
                    strokeWidth={2.5}
                    style={{ marginLeft: 6, color: "#fbbf24", verticalAlign: "-1px" }}
                    aria-label="Password-protected"
                  />
                )}
              </span>
              <span className="home-artefact-row-space">
                {art.cloudOnly ? "Cloud" : (space?.displayName ?? art.spaceId)}
              </span>
              <span className="home-artefact-row-kind">{art.artifactKind}</span>
              <span className="home-artefact-row-time">{formatRelative(art.createdAt) ?? "—"}</span>
            </div>
          );
        })}
      </div>

      {ctx && createPortal(
        <div
          ref={ctxRef}
          className="space-ctx-menu"
          style={{ left: ctx.x, top: ctx.y, transform: "translateY(-100%)", marginTop: -8 }}
        >
          {/* Cloud-only ghosts: Edit share + Unpublish. Both go through routes
              that don't require local bytes (PATCH for mode change, DELETE for
              retire). No pin / rename — those need a local row. */}
          {isCloudOnly && isPublished && (
            <>
              {onArtifactPublish && (
                <button
                  className="space-ctx-item"
                  onClick={() => {
                    const a = ctx.artifact;
                    setCtx(null);
                    onArtifactPublish(a);
                  }}
                >
                  Publish settings…
                </button>
              )}
              <button
                className="space-ctx-item"
                onClick={async () => {
                  const a = ctx.artifact;
                  setCtx(null);
                  try { await unpublishCloudShare(a.publication!.shareToken); }
                  catch (err) { setError((err as Error).message); }
                }}
              >
                Unpublish
              </button>
            </>
          )}

          {!isCloudOnly && (
            <>
              {ctx.artifact.pinnedAt != null ? (
                <button
                  className="space-ctx-item"
                  onClick={async () => {
                    const a = ctx.artifact;
                    setCtx(null);
                    try { await unpinArtifact(a.id); }
                    catch (err) { setError((err as Error).message); }
                  }}
                >
                  Unpin
                </button>
              ) : (
                <button
                  className="space-ctx-item"
                  onClick={async () => {
                    const a = ctx.artifact;
                    setCtx(null);
                    try { await pinArtifact(a.id); }
                    catch (err) { setError((err as Error).message); }
                  }}
                >
                  Pin
                </button>
              )}

              {!ctx.artifact.builtin && !ctx.artifact.plugin && onArtifactPublish && (
                isPublished ? (
                  <>
                    <button
                      className="space-ctx-item"
                      onClick={() => {
                        const a = ctx.artifact;
                        setCtx(null);
                        onArtifactPublish(a);
                      }}
                    >
                      Publish settings…
                    </button>
                    <button
                      className="space-ctx-item"
                      onClick={async () => {
                        const a = ctx.artifact;
                        setCtx(null);
                        try { await unpublishArtifact(a.id); }
                        catch (err) { setError((err as Error).message); }
                      }}
                    >
                      Unpublish
                    </button>
                  </>
                ) : (
                  <button
                    className="space-ctx-item"
                    onClick={() => {
                      const a = ctx.artifact;
                      setCtx(null);
                      onArtifactPublish(a);
                    }}
                  >
                    Publish…
                  </button>
                )
              )}
            </>
          )}
        </div>,
        document.body,
      )}

      {error && createPortal(
        <div
          className="space-ctx-menu"
          style={{ left: "50%", top: "50%", transform: "translate(-50%, -50%)", padding: "12px 16px", maxWidth: 360 }}
        >
          <div style={{ marginBottom: 8 }}>{error}</div>
          <button className="space-ctx-item" onClick={() => setError(null)}>Dismiss</button>
        </div>,
        document.body,
      )}
    </div>
  );
}
