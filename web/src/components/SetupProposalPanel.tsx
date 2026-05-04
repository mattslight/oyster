import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type {
  SetupProposal,
  SetupProposalFolder,
  SetupApplyResult,
} from "../../../shared/types";
import "./SetupProposalPanel.css";

// Container ids used by dnd-kit to identify drop targets. Spaces use the
// proposal-space `key` (stable for the lifetime of the panel); Everything
// else has a single fixed id.
const ELSEWHERE_ID = "elsewhere";
const spaceDropId = (key: string) => `space:${key}`;

interface SpaceRow {
  key: string;
  name: string;
  reason?: string;
  folders: SetupProposalFolder[];
}

interface DragData {
  folder: SetupProposalFolder;
  fromContainer: string;
}

interface Props {
  proposal: SetupProposal;
  onClose: () => void;
  onApplied: (results: SetupApplyResult[]) => void;
}

export function SetupProposalPanel({ proposal, onClose, onApplied }: Props) {
  const [spaces, setSpaces] = useState<SpaceRow[]>(() =>
    proposal.spaces.map((s) => ({ ...s })),
  );
  const [elsewhere, setElsewhere] = useState<SetupProposalFolder[]>(
    proposal.everythingElse,
  );
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Pointer + keyboard dnd. 4px activation distance on pointer keeps
  // regular clicks (rename, ×, toggle) from being interpreted as drag-
  // starts. Keyboard sensor restores arrow-key chip moves so this flow
  // isn't pointer-only — chip reassignment is core to setup, not optional
  // polish.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const includedCount = useMemo(
    () =>
      spaces.filter((s) => s.name.trim() !== "" && s.folders.length > 0).length,
    [spaces],
  );

  // Untick = bulk demote. The chips drop into Everything else and the
  // space row goes away — cleaner than the soft-dim alternative, which
  // left chips stranded in a row that wouldn't apply anywhere. If the
  // user changes their mind, "+ Add space" + drag-back is the path.
  // Toggle is therefore one-way: a row only exists when it's a real
  // candidate for creation.
  const handleToggle = useCallback((key: string) => {
    let dropped: SetupProposalFolder[] = [];
    setSpaces((prev) => {
      const target = prev.find((x) => x.key === key);
      if (!target) return prev;
      dropped = target.folders;
      return prev.filter((x) => x.key !== key);
    });
    if (dropped.length > 0) {
      setElsewhere((e) => {
        const seen = new Set(e.map((f) => f.path));
        const additions = dropped.filter((f) => !seen.has(f.path));
        return additions.length > 0 ? [...e, ...additions] : e;
      });
    }
  }, []);

  const handleStartRename = useCallback((key: string) => {
    setRenamingKey(key);
  }, []);

  const handleCommitRename = useCallback((key: string, nextName: string) => {
    const trimmed = nextName.trim();
    setSpaces((s) =>
      s.map((x) => (x.key === key ? { ...x, name: trimmed || x.name } : x)),
    );
    setRenamingKey(null);
  }, []);

  const handleAddSpace = useCallback(() => {
    const key = `s${Date.now()}-new`;
    setSpaces((s) => [...s, { key, name: "", folders: [] }]);
    setRenamingKey(key);
  }, []);

  const handleRemoveSpace = useCallback((key: string) => {
    // Defensive: only allow remove on empty rows. The button shouldn't be
    // visible otherwise, but enforce it here too in case of stale DOM.
    setSpaces((s) =>
      s.filter((x) => x.key !== key || x.folders.length > 0),
    );
  }, []);

  const handleDemoteChip = useCallback(
    (folder: SetupProposalFolder, fromSpaceKey: string) => {
      setSpaces((s) =>
        s
          .map((x) =>
            x.key === fromSpaceKey
              ? { ...x, folders: x.folders.filter((f) => f.path !== folder.path) }
              : x,
          )
          // Auto-remove on last-chip-out: an empty space mid-flow is just
          // visual noise. The "Remove space" button is still there as an
          // escape hatch for "+ Add space" rows the user creates and then
          // abandons before dragging anything in.
          .filter((x) => x.key !== fromSpaceKey || x.folders.length > 0),
      );
      setElsewhere((e) =>
        e.some((f) => f.path === folder.path) ? e : [...e, folder],
      );
    },
    [],
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const data = active.data.current as DragData | undefined;
    if (!data) return;
    const targetId = String(over.id);
    if (data.fromContainer === targetId) return;

    setSpaces((prev) => {
      // Remove from source space (if applicable)
      let next = prev.map((x) =>
        spaceDropId(x.key) === data.fromContainer
          ? {
              ...x,
              folders: x.folders.filter((f) => f.path !== data.folder.path),
            }
          : x,
      );
      // Add to target space (if target is a space)
      if (targetId.startsWith("space:")) {
        next = next.map((x) =>
          spaceDropId(x.key) === targetId
            ? x.folders.some((f) => f.path === data.folder.path)
              ? x
              : { ...x, folders: [...x.folders, data.folder] }
            : x,
        );
      }
      // Auto-remove the source space if the drag emptied it. Only matches
      // the source — newly-empty target spaces don't exist (a target is
      // either Everything else, an existing populated space, or a "+ Add"
      // row the user is intentionally filling).
      next = next.filter(
        (x) =>
          spaceDropId(x.key) !== data.fromContainer || x.folders.length > 0,
      );
      return next;
    });

    setElsewhere((prev) => {
      // Remove from elsewhere if dragged out of it
      let next =
        data.fromContainer === ELSEWHERE_ID
          ? prev.filter((f) => f.path !== data.folder.path)
          : prev;
      // Add to elsewhere if dropped there
      if (targetId === ELSEWHERE_ID) {
        next = next.some((f) => f.path === data.folder.path)
          ? next
          : [...next, data.folder];
      }
      return next;
    });
  }, []);

  const handleApply = useCallback(async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const body = {
        proposalId: proposal.proposalId,
        spaces: spaces
          .filter((s) => s.name.trim() !== "" && s.folders.length > 0)
          .map((s) => ({
            name: s.name.trim(),
            paths: s.folders.map((f) => f.path),
          })),
      };
      const res = await fetch("/api/setup/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Server returns JSON envelopes like `{ error: "..." }`. Parse
        // when possible so the user sees the actual message instead of
        // raw JSON. Fall through to the status text only on parse failure.
        let message = `apply failed (HTTP ${res.status})`;
        try {
          const data = (await res.json()) as { error?: string };
          if (typeof data.error === "string" && data.error.length > 0) {
            message = data.error;
          }
        } catch {
          const text = await res.text().catch(() => "");
          if (text) message = text;
        }
        throw new Error(message);
      }
      const data = (await res.json()) as { results: SetupApplyResult[] };
      onApplied(data.results);
    } catch (err) {
      setApplyError(
        err instanceof Error ? err.message : "Couldn't apply your setup",
      );
      setApplying(false);
    }
    // On success: stay disabled; onApplied closes the panel.
  }, [proposal.proposalId, spaces, onApplied]);

  // Reset the panel state when a new proposal arrives. Without this, a
  // second `setup_proposal_ready` event (e.g. user re-runs setup, or a
  // future re-scan flow) would leave the panel rendering stale chips
  // because useState only initialises on first mount. proposalId is the
  // server-issued identity for the proposal, so a change there means new
  // payload — clear edits and start fresh.
  useEffect(() => {
    setSpaces(proposal.spaces.map((s) => ({ ...s })));
    setElsewhere(proposal.everythingElse);
    setRenamingKey(null);
    setApplyError(null);
  }, [proposal.proposalId, proposal.spaces, proposal.everythingElse]);

  // Esc closes when not in the middle of an apply.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !applying) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, applying]);

  const totalProjects = proposal.spaces.length;
  const headline =
    totalProjects === 0
      ? "No projects detected"
      : `Found ${totalProjects} ${totalProjects === 1 ? "project" : "projects"} across your dev folder`;

  return (
    <div className="setup-overlay" role="dialog" aria-label="Set up Oyster" aria-modal="true">
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="setup-panel" onClick={(e) => e.stopPropagation()}>
          <header className="setup-header">
            <h2 className="setup-title">{headline}</h2>
            <p className="setup-sub">
              Untick spaces you don't want, click <strong>×</strong> on a folder
              to push it back to <em>Everything else</em>, or drag chips to
              rearrange.
            </p>
            <button
              type="button"
              className="setup-close"
              onClick={onClose}
              aria-label="Close"
              // Block all dismissal paths while a request is in flight —
              // unmounting mid-apply hides applyError and the user never
              // learns whether their write succeeded. Esc handler also
              // gates on `applying`.
              disabled={applying}
            >
              ×
            </button>
          </header>

          <div className="setup-rows">
            {spaces.map((space) => (
              <SpaceRowView
                key={space.key}
                space={space}
                renaming={renamingKey === space.key}
                onToggle={handleToggle}
                onStartRename={handleStartRename}
                onCommitRename={handleCommitRename}
                onRemove={handleRemoveSpace}
                onDemoteChip={handleDemoteChip}
              />
            ))}

            <div className="setup-add-row">
              <span className="setup-row-spacer" />
              <button
                type="button"
                className="setup-add-btn"
                onClick={handleAddSpace}
              >
                + Add space
              </button>
            </div>

            <ElsewhereView folders={elsewhere} />
          </div>

          {applyError && <div className="setup-error">{applyError}</div>}

          <div className="setup-actions">
            <button
              type="button"
              className="setup-btn-primary"
              disabled={includedCount === 0 || applying}
              onClick={handleApply}
            >
              {applying
                ? "Creating…"
                : includedCount === 0
                  ? "Nothing to create"
                  : `Create ${includedCount} space${includedCount === 1 ? "" : "s"}`}
            </button>
            <button
              type="button"
              className="setup-btn-ghost"
              onClick={onClose}
              disabled={applying}
            >
              Not now
            </button>
          </div>
        </div>
      </DndContext>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Space row                                                           */
/* ------------------------------------------------------------------ */

interface SpaceRowProps {
  space: SpaceRow;
  renaming: boolean;
  onToggle: (key: string) => void;
  onStartRename: (key: string) => void;
  onCommitRename: (key: string, nextName: string) => void;
  onRemove: (key: string) => void;
  onDemoteChip: (folder: SetupProposalFolder, fromSpaceKey: string) => void;
}

function SpaceRowView({
  space,
  renaming,
  onToggle,
  onStartRename,
  onCommitRename,
  onRemove,
  onDemoteChip,
}: SpaceRowProps) {
  const dropId = spaceDropId(space.key);
  const { isOver, setNodeRef } = useDroppable({ id: dropId });
  const isEmpty = space.folders.length === 0;

  return (
    <div
      ref={setNodeRef}
      className={`setup-row${isOver ? " setup-row--over" : ""}`}
    >
      <button
        type="button"
        className="setup-check setup-check--on"
        onClick={() => onToggle(space.key)}
        aria-label="Untick — drop chips into Everything else and remove this space"
        title="Untick to drop chips into Everything else"
      >
        <span aria-hidden="true">✓</span>
      </button>

      <div className="setup-row-body">
        <div className="setup-row-name">
          {renaming ? (
            <RenameInput
              initial={space.name}
              onCommit={(v) => onCommitRename(space.key, v)}
              onCancel={() => onCommitRename(space.key, space.name)}
            />
          ) : (
            <button
              type="button"
              className="setup-name-btn"
              onClick={() => onStartRename(space.key)}
              title="Click to rename"
            >
              {space.name || <span className="setup-name-empty">untitled</span>}
            </button>
          )}
          <span className="setup-count">
            {isEmpty
              ? "empty"
              : `${space.folders.length} ${space.folders.length === 1 ? "folder" : "folders"}`}
          </span>
        </div>
        {space.reason && !isEmpty && (
          <div className="setup-reason">{space.reason}</div>
        )}

        {isEmpty ? (
          <div className="setup-empty-msg">
            Nothing here yet.
            <button
              type="button"
              className="setup-remove-btn"
              onClick={() => onRemove(space.key)}
            >
              Remove space
            </button>
          </div>
        ) : (
          <div className="setup-chips">
            {space.folders.map((folder) => (
              <ChipView
                key={folder.path}
                folder={folder}
                fromContainer={dropId}
                onDemote={() => onDemoteChip(folder, space.key)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Everything else                                                     */
/* ------------------------------------------------------------------ */

function ElsewhereView({ folders }: { folders: SetupProposalFolder[] }) {
  const { isOver, setNodeRef } = useDroppable({ id: ELSEWHERE_ID });
  return (
    <div
      ref={setNodeRef}
      className={`setup-row setup-row--elsewhere${isOver ? " setup-row--over" : ""}`}
    >
      <span className="setup-row-spacer" />
      <div className="setup-row-body">
        <div className="setup-row-name">
          <span className="setup-name-static">Everything else</span>
          <span className="setup-count">
            {folders.length === 0
              ? "0 folders"
              : `${folders.length} ${folders.length === 1 ? "folder" : "folders"}`}
          </span>
        </div>
        {folders.length > 0 && (
          <div className="setup-chips">
            {folders.map((folder) => (
              <ChipView
                key={folder.path}
                folder={folder}
                fromContainer={ELSEWHERE_ID}
                hideX
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Chip                                                                */
/* ------------------------------------------------------------------ */

interface ChipProps {
  folder: SetupProposalFolder;
  fromContainer: string;
  hideX?: boolean;
  onDemote?: () => void;
}

function ChipView({ folder, fromContainer, hideX, onDemote }: ChipProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `chip:${fromContainer}:${folder.path}`,
    data: { folder, fromContainer } satisfies DragData,
  });
  return (
    <span
      ref={setNodeRef}
      className={`setup-chip${isDragging ? " setup-chip--dragging" : ""}${fromContainer === ELSEWHERE_ID ? " setup-chip--elsewhere" : ""}`}
      {...listeners}
      {...attributes}
    >
      <span className="setup-chip-label">{folder.label}</span>
      {!hideX && onDemote && (
        <button
          type="button"
          className="setup-chip-x"
          // Stop dnd-kit's listeners from intercepting the click — without
          // this, click registers as a drag-start and the demote never fires.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDemote();
          }}
          title="Move to Everything else"
        >
          ×
        </button>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Inline rename input                                                 */
/* ------------------------------------------------------------------ */

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="setup-name-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value);
        if (e.key === "Escape") onCancel();
      }}
      placeholder="space name"
      // Stop dnd from picking up keystrokes / pointer events on the input
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
