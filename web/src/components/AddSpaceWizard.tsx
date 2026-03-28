import { useState, useCallback } from "react";
import type { ScanResult } from "../../../shared/types";
import { createSpace, triggerScan, deleteSpace } from "../data/spaces-api";

interface Props {
  onClose: () => void;
  onComplete: () => void;
}

export function AddSpaceWizard({ onClose, onComplete }: Props) {
  const [step, setStep] = useState<"name-path" | "results">("name-path");
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [pathAmbiguous, setPathAmbiguous] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [dragging, setDragging] = useState(false);

  const resolveFolder = useCallback(async (folderName: string) => {
    if (!name.trim()) setName(folderName);
    setPathAmbiguous([]);
    try {
      const res = await fetch(`/api/resolve-folder?name=${encodeURIComponent(folderName)}`);
      const data = await res.json() as { matches: string[] };
      if (data.matches.length === 1) {
        setRepoPath(data.matches[0]);
      } else if (data.matches.length > 1) {
        setPathAmbiguous(data.matches);
      } else {
        setRepoPath(`~/${folderName}`);
      }
    } catch {
      setRepoPath(`~/${folderName}`);
    }
  }, [name]);

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  async function handleScan() {
    if (!name.trim()) { setError("Name is required"); return; }
    setError(null);
    setScanning(true);
    let createdSpaceId: string | null = null;
    try {
      const space = await createSpace({ name: name.trim(), repoPath: repoPath.trim() || undefined });
      createdSpaceId = space.id;
      const result = await triggerScan(space.id);
      setScanResult(result);
      setStep("results");
    } catch (err) {
      if (createdSpaceId) await deleteSpace(createdSpaceId);
      setError((err as Error).message);
    } finally {
      setScanning(false);
    }
  }

  const appItems = scanResult?.artifacts.filter(a => a.kind === "app") ?? [];
  const docItems = scanResult?.artifacts.filter(a => a.kind !== "app") ?? [];
  const totalFound = (scanResult?.discovered ?? 0) + (scanResult?.resurfaced ?? 0);

  return (
    <div className="add-space-overlay" onClick={handleBackdrop}>
      <div className="add-space-modal">
        <div className="add-space-stepper">
          {[1, 2, 3].map((n) => {
            const currentStep = step === "name-path" ? 1 : 2;
            const active = n === currentStep;
            const done = n < currentStep;
            return <div key={n} className={`add-space-step-bar ${active ? "active" : done ? "done" : "future"}`} />;
          })}
        </div>

        {step === "name-path" && (
          <>
            <div className="add-space-title">Add space</div>
            <div className="add-space-fields">
              <input
                className="add-space-input"
                placeholder="Name"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !scanning && handleScan()}
                autoFocus
              />
              <div
                className={`add-space-drop-zone${dragging ? " add-space-drop-zone--over" : ""}${repoPath ? " add-space-drop-zone--filled" : ""}`}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => {
                  e.preventDefault();
                  setDragging(false);
                  const item = e.dataTransfer.items[0];
                  if (!item) return;
                  const entry = item.webkitGetAsEntry?.();
                  if (entry?.isDirectory) {
                    resolveFolder(entry.name);
                  }
                }}
              >
                {repoPath ? (
                  <>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0, opacity: 0.7 }}>
                      <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
                    </svg>
                    <span className="add-space-drop-path">{repoPath}</span>
                    <button className="add-space-drop-clear" onClick={() => { setRepoPath(""); setPathAmbiguous([]); }}>×</button>
                  </>
                ) : (
                  <div className="add-space-drop-empty">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.2 }}>
                      <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
                    </svg>
                    <span>Drop project or repo folder to import</span>
                  </div>
                )}
              </div>
              {pathAmbiguous.length > 1 && (
                <div className="add-space-ambiguous">
                  <div className="add-space-ambiguous-label">Multiple matches — pick one:</div>
                  {pathAmbiguous.map(p => (
                    <button key={p} className="add-space-ambiguous-option" onClick={() => { setRepoPath(p); setPathAmbiguous([]); }}>
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {error && <div className="add-space-error">{error}</div>}
            <button
              className="add-space-btn-primary"
              onClick={handleScan}
              disabled={scanning || !name.trim()}
            >
              {scanning ? (repoPath ? "Scanning…" : "Adding…") : repoPath ? "Scan" : "Add"}
            </button>
          </>
        )}

        {step === "results" && scanResult && (
          <>
            <div className="add-space-found-count">{totalFound} {totalFound === 1 ? "item" : "items"}</div>
            <div className="add-space-found-label">
              {totalFound === 0
                ? "Nothing detected — add artifacts manually from the desktop."
                : "Added to your surface"}
            </div>
            {totalFound > 0 && (
              <div className="add-space-found-list">
                {appItems.length > 0 && (
                  <>
                    <div className="add-space-section-label">Apps</div>
                    {appItems.map(a => (
                      <div key={a.id} className="add-space-found-item">
                        <div className="add-space-item-dot add-space-item-dot--app" />
                        <span className="add-space-item-name">{a.label}</span>
                        <span className="add-space-item-kind">App</span>
                      </div>
                    ))}
                  </>
                )}
                {docItems.length > 0 && (
                  <>
                    <div className="add-space-section-label">Docs</div>
                    {docItems.map(a => (
                      <div key={a.id} className="add-space-found-item">
                        <div className="add-space-item-dot add-space-item-dot--doc" />
                        <span className="add-space-item-name">{a.label}</span>
                        <span className="add-space-item-kind">
                          {a.kind === "diagram" ? "Diagram" : "Notes"}
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
            <button className="add-space-btn-primary" onClick={onComplete}>
              Done
            </button>
          </>
        )}

      </div>
    </div>
  );
}
