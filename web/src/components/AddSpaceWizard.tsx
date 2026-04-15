import { useState, useCallback, useEffect, useRef } from "react";
import type { Space, ScanResult } from "../../../shared/types";
import { createSpace, addPath, triggerScan, deleteSpace } from "../data/spaces-api";

interface Props {
  spaces: Space[];
  initialFolder?: string;
  onClose: () => void;
  onComplete: () => void;
}

interface Suggestion {
  name: string;
  folders: string[];
  enabled: boolean;
}

export function AddSpaceWizard({ spaces, initialFolder, onClose, onComplete }: Props) {
  const [step, setStep] = useState<"name-path" | "discovery" | "results">(initialFolder ? "discovery" : "name-path");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [existingSpaceId, setExistingSpaceId] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [pathAmbiguous, setPathAmbiguous] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [dragging, setDragging] = useState(false);

  // Discovery state
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [discovering, setDiscovering] = useState(!!initialFolder);
  const [importResult, setImportResult] = useState<Array<{ name: string; scanned: number }> | null>(null);
  const [dragItem, setDragItem] = useState<{ fromIdx: number | "loose"; folder: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<number | "loose" | "new" | null>(null);
  const [looseFolders, setLooseFolders] = useState<string[]>([]);

  const resolveFolder = useCallback(async (folderName: string) => {
    if (mode === "new" && !name.trim()) setName(folderName);
    setPathAmbiguous([]);
    try {
      const res = await fetch(`/api/resolve-folder?name=${encodeURIComponent(folderName)}`);
      const data = await res.json() as { matches: string[] };
      if (data.matches.length === 1) {
        await checkAndAddFolder(data.matches[0]);
      } else if (data.matches.length > 1) {
        setPathAmbiguous(data.matches);
      } else {
        await checkAndAddFolder(`~/${folderName}`);
      }
    } catch {
      await checkAndAddFolder(`~/${folderName}`);
    }
  }, [name, mode]);

  // Auto-resolve folder dropped on the surface
  const resolved = useRef(false);
  useEffect(() => {
    if (initialFolder && !resolved.current) {
      resolved.current = true;
      resolveFolder(initialFolder);
    }
  }, [initialFolder, resolveFolder]);

  async function checkAndAddFolder(path: string) {
    // Check if this is a container (like ~/Dev) with multiple projects
    setDiscovering(true);
    setError(null);
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await res.json() as {
        container: boolean;
        path?: string;
        suggestions?: Array<{ name: string; folders: string[] }>;
      };

      if (data.container && data.suggestions) {
        // Switch to discovery flow
        setSuggestions(data.suggestions.map(s => ({ ...s, enabled: true })));
        setStep("discovery");
      } else {
        // Single project — go back to name-path step with folder loaded
        setFolders(prev => prev.includes(data.path!) ? prev : [...prev, data.path!]);
        setStep("name-path");
      }
    } catch (err) {
      setFolders(prev => prev.includes(path) ? prev : [...prev, path]);
      setStep("name-path");
    } finally {
      setDiscovering(false);
    }
  }

  function handleBackdrop(e: React.MouseEvent) {
    // Only close on backdrop click if we're on the first step with no progress
    if (e.target === e.currentTarget && step === "name-path" && folders.length === 0 && suggestions.length === 0) {
      onClose();
    }
  }

  function removeFolder(path: string) {
    setFolders(prev => prev.filter(p => p !== path));
  }

  function toggleSuggestion(idx: number) {
    setSuggestions(prev => prev.map((s, i) => i === idx ? { ...s, enabled: !s.enabled } : s));
  }

  function renameSuggestion(idx: number, newName: string) {
    setSuggestions(prev => prev.map((s, i) => i === idx ? { ...s, name: newName } : s));
  }

  function moveFolderTo(from: number | "loose", folder: string, target: number | "loose" | "new") {
    // Remove from source
    if (from === "loose") {
      setLooseFolders(prev => prev.filter(f => f !== folder));
    } else {
      setSuggestions(prev => {
        const next = prev.map((s, i) => i === from ? { ...s, folders: s.folders.filter(f => f !== folder) } : s);
        return next.filter(s => s.folders.length > 0);
      });
    }

    // Add to target
    if (target === "loose") {
      setLooseFolders(prev => [...prev, folder]);
    } else if (target === "new") {
      setSuggestions(prev => [...prev, { name: "new space", folders: [folder], enabled: true }]);
    } else {
      setSuggestions(prev => prev.map((s, i) => i === target ? { ...s, folders: [...s.folders, folder] } : s));
    }
  }

  async function handleImportDiscovery() {
    setScanning(true);
    setError(null);
    try {
      const enabled = suggestions.filter(s => s.enabled && s.folders.length > 0);
      // Include loose folders as "home" (no space name — server handles as home)
      const allSpaces = [
        ...enabled.map(s => ({ name: s.name, folders: s.folders })),
        ...(looseFolders.length > 0 ? [{ name: "__home__", folders: looseFolders }] : []),
      ];
      const res = await fetch("/api/discover/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaces: allSpaces }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { imported: Array<{ name: string; scanned: number }> };
      setImportResult(data.imported);
      setStep("results");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function handleScan() {
    setError(null);

    // Empty space — just create and close, no scan
    if (mode === "new" && folders.length === 0) {
      if (!name.trim()) { setError("Name is required"); return; }
      try {
        await createSpace({ name: name.trim() });
        onComplete();
      } catch (err) {
        setError((err as Error).message);
      }
      return;
    }

    setScanning(true);

    let spaceId: string;
    let createdNew = false;

    try {
      if (mode === "existing") {
        if (!existingSpaceId) { setError("Pick a space"); setScanning(false); return; }
        spaceId = existingSpaceId;
      } else {
        if (!name.trim()) { setError("Name is required"); setScanning(false); return; }
        const space = await createSpace({ name: name.trim() });
        spaceId = space.id;
        createdNew = true;
      }

      for (const folder of folders) {
        await addPath(spaceId, folder);
      }

      const result = await triggerScan(spaceId);
      setScanResult(result);
      setStep("results");
    } catch (err) {
      if (createdNew && mode === "new") {
        const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        await deleteSpace(id);
      }
      setError((err as Error).message);
    } finally {
      setScanning(false);
    }
  }

  const existingSpaces = spaces.filter(s => s.id !== "__all__");

  // ── Discovery preview step ──
  if (step === "discovery") {
    const enabledCount = suggestions.filter(s => s.enabled && s.folders.length > 0).length;
    const totalFolders = suggestions.filter(s => s.enabled).reduce((n, s) => n + s.folders.length, 0) + looseFolders.length;

    return (
      <div className="add-space-overlay" onClick={handleBackdrop}>
        <div className="add-space-modal add-space-modal--wide">
          <div className="add-space-stepper">
            {[1, 2, 3].map(n => (
              <div key={n} className={`add-space-step-bar ${n === 2 ? "active" : n < 2 ? "done" : "future"}`} />
            ))}
          </div>

          <div className="add-space-title">
            {discovering ? "Scanning…" : `Create ${enabledCount} spaces`}
          </div>
          <div className="add-space-subtitle">
            {discovering ? "Looking for projects in your folder" : `${totalFolders} folders grouped into spaces. Edit, move, or untick to skip.`}
          </div>

          <div className="discovery-list">
            {discovering && suggestions.length === 0 && (
              <div style={{ textAlign: "center", padding: "40px 0", color: "var(--text-dim)", fontSize: "13px" }}>
                Scanning for projects…
              </div>
            )}
            {suggestions.map((s, idx) => (
              <div
                key={idx}
                className={`discovery-group ${s.enabled ? "" : "discovery-group--disabled"} ${dropTarget === idx ? "discovery-group--drop" : ""}`}
                onDragOver={e => { e.preventDefault(); setDropTarget(idx); }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={e => {
                  e.preventDefault();
                  setDropTarget(null);
                  if (dragItem && !(dragItem.fromIdx === idx)) {
                    moveFolderTo(dragItem.fromIdx, dragItem.folder, idx);
                  }
                  setDragItem(null);
                }}
              >
                <div className="discovery-group-header">
                  <label className="discovery-checkbox">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      onChange={() => toggleSuggestion(idx)}
                    />
                  </label>
                  <input
                    className="discovery-group-name"
                    value={s.name}
                    onChange={e => renameSuggestion(idx, e.target.value)}
                    disabled={!s.enabled}
                    placeholder="space name"
                  />
                </div>
                <div className="discovery-chips">
                  {s.folders.map(f => {
                    const folderName = f.split("/").pop() ?? f;
                    return (
                      <div
                        key={f}
                        className="discovery-chip"
                        draggable
                        onDragStart={() => setDragItem({ fromIdx: idx, folder: f })}
                        onDragEnd={() => { setDragItem(null); setDropTarget(null); }}
                      >
                        {folderName}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Import without a space — lands on home */}
            <div
              className={`discovery-group discovery-loose ${dropTarget === "loose" ? "discovery-group--drop" : ""}`}
              onDragOver={e => { e.preventDefault(); setDropTarget("loose"); }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={e => {
                e.preventDefault();
                setDropTarget(null);
                if (dragItem) {
                  moveFolderTo(dragItem.fromIdx, dragItem.folder, "loose");
                  setDragItem(null);
                }
              }}
            >
              <div className="discovery-group-header">
                <span className="discovery-loose-label">import without a space</span>
              </div>
              {looseFolders.length > 0 && (
                <div className="discovery-chips">
                  {looseFolders.map(f => {
                    const folderName = f.split("/").pop() ?? f;
                    return (
                      <div
                        key={f}
                        className="discovery-chip"
                        draggable
                        onDragStart={() => setDragItem({ fromIdx: "loose", folder: f })}
                        onDragEnd={() => { setDragItem(null); setDropTarget(null); }}
                      >
                        {folderName}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Create a brand new space */}
            <div
              className={`discovery-new-group ${dropTarget === "new" ? "discovery-new-group--drop" : ""}`}
              onDragOver={e => { e.preventDefault(); setDropTarget("new"); }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={e => {
                e.preventDefault();
                setDropTarget(null);
                if (dragItem) {
                  moveFolderTo(dragItem.fromIdx, dragItem.folder, "new");
                  setDragItem(null);
                }
              }}
              onClick={() => setSuggestions(prev => [...prev, { name: "new space", folders: [], enabled: true }])}
            >
              + new space
            </div>
          </div>

          {error && <div className="add-space-error">{error}</div>}
          <div className="discovery-actions">
            <button className="add-space-btn-secondary" onClick={() => { setStep("name-path"); setSuggestions([]); }}>
              Back
            </button>
            <button
              className="add-space-btn-primary"
              onClick={handleImportDiscovery}
              disabled={scanning || enabledCount === 0}
            >
              {scanning ? "Importing…" : `Import ${enabledCount} space${enabledCount !== 1 ? "s" : ""} (${totalFolders} folders)`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Results step ──
  if (step === "results") {
    // Discovery import results
    if (importResult) {
      const totalScanned = importResult.reduce((n, r) => n + r.scanned, 0);
      return (
        <div className="add-space-overlay" onClick={handleBackdrop}>
          <div className="add-space-modal">
            <div className="add-space-stepper">
              {[1, 2, 3].map(n => (
                <div key={n} className={`add-space-step-bar ${n <= 3 ? "done" : "future"}`} />
              ))}
            </div>
            <div className="add-space-found-count">{importResult.length} spaces created</div>
            <div className="add-space-found-label">{totalScanned} artifacts discovered</div>
            <div className="add-space-found-list">
              {importResult.map(r => (
                <div key={r.name} className="add-space-found-item">
                  <div className="add-space-item-dot add-space-item-dot--app" />
                  <span className="add-space-item-name">{r.name}</span>
                  <span className="add-space-item-kind">{r.scanned} items</span>
                </div>
              ))}
            </div>
            <button className="add-space-btn-primary" onClick={onComplete}>Done</button>
          </div>
        </div>
      );
    }

    // Single space scan results
    const appItems = scanResult?.artifacts.filter(a => a.kind === "app") ?? [];
    const docItems = scanResult?.artifacts.filter(a => a.kind !== "app") ?? [];
    const totalFound = (scanResult?.discovered ?? 0) + (scanResult?.resurfaced ?? 0);

    return (
      <div className="add-space-overlay" onClick={handleBackdrop}>
        <div className="add-space-modal">
          <div className="add-space-stepper">
            {[1, 2, 3].map(n => (
              <div key={n} className={`add-space-step-bar ${n <= 2 ? "done" : "future"}`} />
            ))}
          </div>
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
          <button className="add-space-btn-primary" onClick={onComplete}>Done</button>
        </div>
      </div>
    );
  }

  // ── Name/path step ──
  return (
    <div className="add-space-overlay" onClick={handleBackdrop}>
      <div className="add-space-modal">
        <div className="add-space-stepper">
          {[1, 2, 3].map((n) => (
            <div key={n} className={`add-space-step-bar ${n === 1 ? "active" : "future"}`} />
          ))}
        </div>

        <div className="add-space-title">Add space</div>
        <div className="add-space-fields">

          {existingSpaces.length > 0 && (
            <div className="add-space-mode-toggle">
              <button
                className={`add-space-mode-btn ${mode === "new" ? "active" : ""}`}
                onClick={() => setMode("new")}
              >New space</button>
              <button
                className={`add-space-mode-btn ${mode === "existing" ? "active" : ""}`}
                onClick={() => setMode("existing")}
              >Existing space</button>
            </div>
          )}

          {mode === "new" ? (
            <input
              className="add-space-input"
              placeholder="Name"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !scanning && !discovering && handleScan()}
              autoFocus
            />
          ) : (
            <CustomSelect
              value={existingSpaceId}
              onChange={setExistingSpaceId}
              placeholder="Pick a space…"
              options={existingSpaces.map(s => ({ value: s.id, label: s.displayName }))}
            />
          )}

          <div
            className={`add-space-drop-zone${dragging ? " add-space-drop-zone--over" : ""}${folders.length > 0 ? " add-space-drop-zone--filled" : ""}`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => {
              e.preventDefault();
              setDragging(false);
              for (let i = 0; i < e.dataTransfer.items.length; i++) {
                const entry = e.dataTransfer.items[i].webkitGetAsEntry?.();
                if (entry?.isDirectory) {
                  resolveFolder(entry.name);
                }
              }
            }}
          >
            {discovering ? (
              <div className="add-space-drop-empty">
                <span>Analysing folder…</span>
              </div>
            ) : folders.length > 0 ? (
              <div className="add-space-folder-list">
                {folders.map(f => (
                  <div key={f} className="add-space-folder-item">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0, opacity: 0.7 }}>
                      <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
                    </svg>
                    <span className="add-space-drop-path">{f}</span>
                    <button className="add-space-drop-clear" onClick={() => removeFolder(f)}>×</button>
                  </div>
                ))}
                <div className="add-space-drop-more">Drop another folder to add</div>
              </div>
            ) : (
              <div className="add-space-drop-empty">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style={{ opacity: 0.2 }}>
                  <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
                </svg>
                <span>Drop project folder to import</span>
              </div>
            )}
          </div>
          {pathAmbiguous.length > 1 && (
            <div className="add-space-ambiguous">
              <div className="add-space-ambiguous-label">Multiple matches — pick one:</div>
              {pathAmbiguous.map(p => (
                <button key={p} className="add-space-ambiguous-option" onClick={() => {
                  checkAndAddFolder(p);
                  setPathAmbiguous([]);
                }}>
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
          disabled={scanning || discovering || (mode === "new" ? !name.trim() : !existingSpaceId || folders.length === 0)}
        >
          {scanning ? "Scanning…" : folders.length > 0 ? "Scan" : "Create"}
        </button>
      </div>
    </div>
  );
}

function CustomSelect({ value, onChange, placeholder, options }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: Array<{ value: string; label: string }>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const selected = options.find(o => o.value === value);

  return (
    <div className="custom-select" ref={ref}>
      <button className="custom-select-trigger add-space-input" onClick={() => setOpen(!open)} type="button">
        <span style={{ opacity: selected ? 1 : 0.4 }}>{selected?.label || placeholder}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M2 4l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="custom-select-menu">
          {options.map(o => (
            <button
              key={o.value}
              className={`custom-select-option${o.value === value ? " active" : ""}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
              type="button"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
