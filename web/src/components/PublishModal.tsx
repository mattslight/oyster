// web/src/components/PublishModal.tsx

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Artifact } from "../../../shared/types";
import { publishArtifact, PublishApiError } from "../data/publish-api";
import "./PublishModal.css";

interface Props {
  /** The artefact being published. Null = modal closed. */
  artifact: Artifact | null;
  onClose: () => void;
}

type Mode = "open" | "password";
type Phase = "idle" | "publishing";

export function PublishModal({ artifact, onClose }: Props) {
  const [mode, setMode] = useState<Mode>("open");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);

  // Reset internal state when the artefact changes (modal reopens on a different one).
  useEffect(() => {
    if (artifact) {
      setMode("open");
      setPassword("");
      setPhase("idle");
      setError(null);
    }
  }, [artifact?.id]);

  // Esc to close — but only when not in-flight.
  useEffect(() => {
    if (!artifact) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && phase === "idle") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [artifact, phase, onClose]);

  if (!artifact) return null;

  const canPublish = phase === "idle"
    && (mode === "open" || (mode === "password" && password.length > 0));

  async function handlePublish() {
    if (!artifact || !canPublish) return;
    setPhase("publishing");
    setError(null);
    try {
      await publishArtifact(artifact.id, mode, mode === "password" ? password : undefined);
      // Optimistic close on success — the SSE artifact_changed event will
      // trigger an artefact list refetch, which surfaces the chip and updates
      // any future re-open of the modal with the published state.
      onClose();
    } catch (err) {
      setPhase("idle");
      if (err instanceof PublishApiError) {
        setError(err.message || err.code);
      } else {
        setError("Couldn't publish — try again.");
      }
    }
  }

  function handleModeChange(next: Mode) {
    setMode(next);
    if (next === "open") setPassword("");  // see spec: switching to Open clears password
  }

  return createPortal(
    <div
      className="confirm-modal-overlay"
      onMouseDown={(e) => {
        if (phase === "idle" && e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-modal-title"
    >
      <div className="publish-modal-panel">
        <div className="publish-modal-eyebrow">Publish artefact</div>
        <h2 id="publish-modal-title" className="publish-modal-title">{artifact.label}</h2>

        {error && (
          <div className="publish-modal-error">
            <span>{error}</span>
          </div>
        )}

        <div className="publish-modal-modes">
          <label className={`publish-modal-mode${mode === "open" ? " publish-modal-mode--selected" : ""}`}>
            <input type="radio" name="publish-mode" value="open" checked={mode === "open"} onChange={() => handleModeChange("open")} style={{ display: "none" }} />
            <span className="publish-modal-mode__radio" />
            <span><strong>Open</strong> · <span style={{ color: "#94a3b8" }}>anyone with the link</span></span>
          </label>
          <label className={`publish-modal-mode${mode === "password" ? " publish-modal-mode--selected" : ""}`}>
            <input type="radio" name="publish-mode" value="password" checked={mode === "password"} onChange={() => handleModeChange("password")} style={{ display: "none" }} />
            <span className="publish-modal-mode__radio" />
            <span><strong>Password</strong> · <span style={{ color: "#94a3b8" }}>link + password</span></span>
          </label>
        </div>

        {mode === "password" && (
          <input
            type="password"
            className="publish-modal-password"
            placeholder="Enter a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        )}

        <div className="publish-modal-actions">
          <button type="button" className="publish-modal-btn publish-modal-btn--cancel" onClick={onClose} disabled={phase !== "idle"}>
            Cancel
          </button>
          <button type="button" className="publish-modal-btn publish-modal-btn--primary" onClick={handlePublish} disabled={!canPublish}>
            {phase === "publishing" ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
