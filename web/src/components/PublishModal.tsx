// web/src/components/PublishModal.tsx

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link2 } from "lucide-react";
import type { Artifact } from "../../../shared/types";
import { publishArtifact, unpublishArtifact, PublishApiError } from "../data/publish-api";
import { useCopyLink } from "../hooks/useCopyLink";
import { ConfirmModal } from "./ConfirmModal";
import { subscribeUiEvents } from "../data/ui-events";
import "./PublishModal.css";

interface Props {
  /** The artefact being published. Null = modal closed. */
  artifact: Artifact | null;
  onClose: () => void;
}

type Mode = "open" | "password";
type Phase = "idle" | "publishing" | "unpublishing";
type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signing-in"; signInUrl: string; expiresAt: number }
  | { status: "signed-in"; email: string };

export function PublishModal({ artifact, onClose }: Props) {
  const [mode, setMode] = useState<Mode>("open");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  // Reset internal state when the artefact changes (modal reopens on a different one).
  useEffect(() => {
    if (artifact) {
      setMode("open");
      setPassword("");
      setPhase("idle");
      setError(null);
    }
  }, [artifact?.id]);

  // Fetch whoami on open + subscribe to auth_changed events.
  useEffect(() => {
    if (!artifact) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch("/api/auth/whoami");
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { user: { email: string } | null };
        if (cancelled) return;
        setAuth(body.user ? { status: "signed-in", email: body.user.email } : { status: "signed-out" });
      } catch {
        if (cancelled) return;
        setAuth({ status: "signed-out" });
      }
    };
    refresh();
    const unsub = subscribeUiEvents((e) => {
      if (e.command === "auth_changed") refresh();
    });
    return () => { cancelled = true; unsub(); };
  }, [artifact?.id]);

  const publication = artifact?.publication?.unpublishedAt === null ? artifact.publication : null;
  const isPublished = !!publication;
  const isSigninMode = publication?.shareMode === "signin";

  useEffect(() => {
    if (!showQr || !publication?.shareUrl) {
      setQrSvg(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { default: qrcode } = await import("qrcode-generator");
      if (cancelled) return;
      // type 0 = auto type-number, 'M' = medium error correction.
      const q = qrcode(0, "M");
      q.addData(publication.shareUrl);
      q.make();
      // size:4 = 4-pixel module size; margin:0 = no quiet-zone in the SVG (we
      // pad with the surrounding container).
      setQrSvg(q.createSvgTag({ scalable: true, margin: 0 }));
    })();
    return () => { cancelled = true; };
  }, [showQr, publication?.shareUrl]);

  // When the modal opens on a published artefact, sync the picker to the current mode.
  useEffect(() => {
    if (publication) {
      if (publication.shareMode === "password" || publication.shareMode === "open") {
        setMode(publication.shareMode);
      }
      // signin mode: don't pre-select; the user must pick Open or Password to manage.
      setPassword("");  // re-open: password field always empty per spec
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publication?.shareToken]);

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

  const { copied, copy } = useCopyLink(publication?.shareUrl ?? "");

  const modeChanged = isPublished && publication.shareMode !== mode;
  const passwordChange = isPublished && mode === "password" && password.length > 0;
  const canSave = phase === "idle" && (modeChanged || passwordChange);

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

  async function handleSave() {
    if (!artifact || !canSave) return;
    setPhase("publishing");
    setError(null);
    try {
      await publishArtifact(artifact.id, mode, mode === "password" ? password : undefined);
      setPassword("");
      setPhase("idle");
      // SSE will refetch and re-pin the picker to the new mode.
    } catch (err) {
      setPhase("idle");
      setError(err instanceof PublishApiError ? (err.message || err.code) : "Couldn't update — try again.");
    }
  }

  async function handleUnpublish() {
    if (!artifact) return;
    setConfirmUnpublish(false);
    setPhase("unpublishing");
    setError(null);
    try {
      await unpublishArtifact(artifact.id);
      // SSE will flip publication.unpublishedAt → modal returns to unpublished state.
      setPhase("idle");
    } catch (err) {
      setPhase("idle");
      setError(err instanceof PublishApiError ? (err.message || err.code) : "Couldn't unpublish — try again.");
    }
  }

  function handleModeChange(next: Mode) {
    setMode(next);
    if (next === "open") setPassword("");  // see spec: switching to Open clears password
  }

  async function handleSignIn() {
    setError(null);
    try {
      const res = await fetch("/api/auth/login", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { sign_in_url: string; expires_in: number };
      window.open(body.sign_in_url, "_blank", "noopener,noreferrer");
      setAuth({
        status: "signing-in",
        signInUrl: body.sign_in_url,
        expiresAt: Date.now() + body.expires_in * 1000,
      });
    } catch (err) {
      setError("Couldn't start sign-in — try again.");
    }
  }

  // Polling fallback: while signing-in, check whoami every 3s.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (auth.status !== "signing-in") return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch("/api/auth/whoami");
        if (!res.ok) return;
        const body = (await res.json()) as { user: { email: string } | null };
        if (cancelled) return;
        if (body.user) {
          setAuth({ status: "signed-in", email: body.user.email });
        } else if (Date.now() > auth.expiresAt) {
          setAuth({ status: "signed-out" });
        }
      } catch {
        // network blip; next tick will retry
      }
    };
    const interval = setInterval(tick, 3000);
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.status, auth.status === "signing-in" ? auth.expiresAt : 0]);

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
        <div className="publish-modal-eyebrow">{isPublished ? "Published" : "Publish artefact"}</div>
        <h2 id="publish-modal-title" className="publish-modal-title">{artifact.label}</h2>

        {auth.status !== "signed-in" && auth.status !== "loading" && (
          <>
            <div className="publish-modal-helper">
              Sign in to Oyster to publish.<br />
              Publishing requires an account.
            </div>
            <div className="publish-modal-actions">
              <button type="button" className="publish-modal-btn publish-modal-btn--cancel" onClick={onClose}>
                Cancel
              </button>
              {auth.status === "signing-in" ? (
                <button type="button" className="publish-modal-btn" onClick={() => setAuth({ status: "signed-out" })}>
                  Cancel sign-in
                </button>
              ) : (
                <button type="button" className="publish-modal-btn publish-modal-btn--primary" onClick={handleSignIn}>
                  Sign in
                </button>
              )}
            </div>
            {auth.status === "signing-in" && (
              <div className="publish-modal-meta" style={{ marginTop: 14 }}>
                Sign-in opened in a new tab — return here when done.
              </div>
            )}
          </>
        )}

        {auth.status === "signed-in" && (
          <>
            {error && (
              <div className="publish-modal-error">
                <span>{error}</span>
              </div>
            )}

            {isPublished && publication && (
              <>
                <div className="publish-modal-url">
                  <div className="publish-modal-url__text">{publication.shareUrl}</div>
                  <div className="publish-modal-url__actions">
                    <button
                      type="button"
                      className={`publish-modal-url__copy${copied ? " publish-modal-url__copy--copied" : ""}`}
                      onClick={() => void copy()}
                    >
                      {copied ? "Copied" : "Copy link"}
                    </button>
                    <button
                      type="button"
                      className={`publish-modal-url__qr-toggle${showQr ? " publish-modal-url__qr-toggle--active" : ""}`}
                      onClick={() => setShowQr((v) => !v)}
                      aria-label={showQr ? "Hide QR code" : "Show QR code"}
                    >
                      <Link2 size={14} strokeWidth={2} />
                    </button>
                  </div>
                  {showQr && qrSvg && (
                    <div
                      style={{
                        marginTop: 14,
                        display: "flex",
                        justifyContent: "center",
                        background: "#fff",
                        borderRadius: 6,
                        padding: 12,
                      }}
                      dangerouslySetInnerHTML={{ __html: qrSvg }}
                    />
                  )}
                  {showQr && !qrSvg && (
                    <div style={{ marginTop: 14, textAlign: "center", fontSize: 11, color: "#64748b" }}>
                      Generating QR…
                    </div>
                  )}
                </div>
                <div className="publish-modal-meta">
                  Live · published {publication.publishedAt
                    ? new Date(publication.publishedAt).toLocaleString()
                    : "just now"}
                </div>

                {isSigninMode && (
                  <div className="publish-modal-helper">
                    This publication is sign-in restricted. Pick Open or Password to manage it from the UI.
                  </div>
                )}

                <div className="publish-modal-section-label">Access</div>
              </>
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
                placeholder={
                  isPublished && publication?.shareMode === "password"
                    ? "Password is set. Leave blank to keep it."
                    : "Enter a password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
            )}

            <div className={`publish-modal-actions${isPublished ? " publish-modal-actions--published" : ""}`}>
              {isPublished ? (
                <>
                  <button type="button" className="publish-modal-btn publish-modal-btn--unpublish" onClick={() => setConfirmUnpublish(true)} disabled={phase !== "idle"}>
                    {phase === "unpublishing" ? "Unpublishing…" : "Unpublish"}
                  </button>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(canSave || phase === "publishing") && (
                      <button type="button" className="publish-modal-btn publish-modal-btn--primary" onClick={handleSave} disabled={!canSave}>
                        {phase === "publishing" ? "Saving…" : "Save"}
                      </button>
                    )}
                    <button type="button" className="publish-modal-btn" onClick={onClose} disabled={phase !== "idle"}>Done</button>
                  </div>
                </>
              ) : (
                <>
                  <button type="button" className="publish-modal-btn publish-modal-btn--cancel" onClick={onClose} disabled={phase !== "idle"}>Cancel</button>
                  <button type="button" className="publish-modal-btn publish-modal-btn--primary" onClick={handlePublish} disabled={!canPublish}>
                    {phase === "publishing" ? "Publishing…" : "Publish"}
                  </button>
                </>
              )}
            </div>

            <ConfirmModal
              open={confirmUnpublish}
              title="Unpublish this artefact?"
              body="This retires the URL — re-publishing creates a new one."
              confirmLabel="Unpublish"
              destructive
              onConfirm={handleUnpublish}
              onCancel={() => setConfirmUnpublish(false)}
            />
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
