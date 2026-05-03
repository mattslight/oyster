// Folder attach form. Extracted from Home/index.tsx.
import { useState } from "react";
import { addSpaceSource } from "../../data/spaces-api";

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
      await addSpaceSource(spaceId, path.trim());
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
          The folder will be scanned in the background.
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
            {submitting ? "Attaching…" : "Attach"}
          </button>
        </div>
      </div>
      {error && <div className="home-memories-add-error">Couldn't attach: {error}</div>}
    </form>
  );
}
