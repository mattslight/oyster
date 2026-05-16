// "Add project" form — turns a folder on disk into a project tile.
// Hits the server's idempotent attach-folder endpoint which writes
// .oyster/id, creates or adopts the project row, and claims orphan
// sessions whose cwd matches.
import { useState } from "react";
import { attachFolder } from "../../data/projects-api";

export function AttachFolderForm({
  spaceId, onAttached, onCancel,
}: {
  spaceId: string;
  onAttached: () => void;
  onCancel: () => void;
}) {
  const [path, setPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!path.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await attachFolder(spaceId, path.trim());
      onAttached();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="home-memories-add" onSubmit={submit}>
      <input
        className="home-memories-add-text"
        style={{ minHeight: 0 }}
        placeholder="/absolute/path/to/folder (or ~/path)"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        autoFocus
      />
      <div className="home-memories-add-row">
        <span className="home-memories-add-error" style={{ flex: 1, color: "var(--text-dim)" }}>
          A `.oyster/id` marker will be written so the project survives renames + travels across machines.
        </span>
        <div className="home-memories-add-actions">
          <button type="button" className="home-memories-add-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="home-memories-add-save"
            disabled={!path.trim() || submitting}
          >
            {submitting ? "Adding…" : "Add project"}
          </button>
        </div>
      </div>
      {error && <div className="home-memories-add-error">Couldn't attach: {error}</div>}
    </form>
  );
}
