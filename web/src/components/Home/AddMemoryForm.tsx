// Memory creation form. Extracted from Home/index.tsx.
import { useMemo, useState } from "react";
import type { Space } from "../../../../shared/types";
import { createMemory } from "../../data/memories-api";

interface AddMemoryFormProps {
  defaultSpaceId: string | null;
  spaces: Space[];
  onSaved: () => void;
  onCancel: () => void;
}

export function AddMemoryForm({ defaultSpaceId, spaces, onSaved, onCancel }: AddMemoryFormProps) {
  const [content, setContent] = useState("");
  const [spaceId, setSpaceId] = useState<string>(defaultSpaceId ?? "");
  const [tagsInput, setTagsInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const realSpaces = useMemo(
    () => spaces.filter((s) => s.id !== "home" && s.id !== "__all__" && s.id !== "__archived__"),
    [spaces],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await createMemory({
        content: content.trim(),
        space_id: spaceId || undefined,
        tags: tags.length ? tags : undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="home-memories-add" onSubmit={submit}>
      <textarea
        className="home-memories-add-text"
        placeholder="What should I remember?"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        autoFocus
      />
      <div className="home-memories-add-row">
        <select
          className="home-memories-add-select"
          value={spaceId}
          onChange={(e) => setSpaceId(e.target.value)}
        >
          <option value="">No space (global)</option>
          {realSpaces.map((s) => (
            <option key={s.id} value={s.id}>{s.displayName}</option>
          ))}
        </select>
        <input
          className="home-memories-add-tags"
          placeholder="tags, comma-separated"
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
        />
        <div className="home-memories-add-actions">
          <button type="button" className="home-memories-add-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="home-memories-add-save"
            disabled={!content.trim() || submitting}
          >
            {submitting ? "Saving…" : "Save memory"}
          </button>
        </div>
      </div>
      {error && <div className="home-memories-add-error">Couldn't save: {error}</div>}
    </form>
  );
}
