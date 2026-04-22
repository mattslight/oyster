import { useState, useCallback, useEffect, useRef } from "react";
import type { Space, ScanResult } from "../../../shared/types";
import { createSpace, addPath, triggerScan, deleteSpace } from "../data/spaces-api";

interface Props {
  spaces: Space[];
  initialFolder?: string;
  onClose: () => void;
  onComplete: (newSpaceId?: string) => void;
}

export function AddSpaceWizard({ spaces, initialFolder, onClose, onComplete }: Props) {
  const [step, setStep] = useState<"name-path" | "results">("name-path");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [name, setName] = useState("");
  const [existingSpaceId, setExistingSpaceId] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [pathAmbiguous, setPathAmbiguous] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [dragging, setDragging] = useState(false);

  const addFolderIfNew = useCallback((path: string) => {
    setFolders((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }, []);

  const resolveFolder = useCallback(async (folderName: string) => {
    if (mode === "new" && !name.trim()) setName(folderName);
    setPathAmbiguous([]);
    try {
      const res = await fetch(`/api/resolve-folder?name=${encodeURIComponent(folderName)}`);
      const data = await res.json() as { matches: string[] };
      if (data.matches.length === 1) {
        addFolderIfNew(data.matches[0]);
      } else if (data.matches.length > 1) {
        setPathAmbiguous(data.matches);
      } else {
        addFolderIfNew(`~/${folderName}`);
      }
    } catch {
      addFolderIfNew(`~/${folderName}`);
    }
  }, [name, mode, addFolderIfNew]);

  // Auto-resolve folder dropped on the Oyster surface (via initialFolder prop)
  const resolved = useRef(false);
  useEffect(() => {
    if (initialFolder && !resolved.current) {
      resolved.current = true;
      resolveFolder(initialFolder);
    }
  }, [initialFolder, resolveFolder]);

  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget && step === "name-path" && folders.length === 0) {
      onClose();
    }
  }

  function removeFolder(path: string) {
    setFolders((prev) => prev.filter((p) => p !== path));
  }

  async function handleScan() {
    setError(null);

    // Empty space — just create and close, no scan
    if (mode === "new" && folders.length === 0) {
      if (!name.trim()) { setError("Name is required"); return; }
      try {
        const space = await createSpace({ name: name.trim() });
        onComplete(space.id);
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

  const existingSpaces = spaces.filter((s) => s.id !== "__all__");

  // ── Results step ──
  if (step === "results") {
    const appItems = scanResult?.artifacts.filter((a) => a.kind === "app") ?? [];
    const docItems = scanResult?.artifacts.filter((a) => a.kind !== "app") ?? [];
    const totalFound = (scanResult?.discovered ?? 0) + (scanResult?.resurfaced ?? 0);

    return (
      <div className="add-space-overlay" onClick={handleBackdrop}>
        <div className="add-space-modal">
          <div className="add-space-stepper">
            {[1, 2, 3].map((n) => (
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
                  {appItems.map((a) => (
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
                  {docItems.map((a) => (
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
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !scanning && handleScan()}
              autoFocus
            />
          ) : (
            <CustomSelect
              value={existingSpaceId}
              onChange={setExistingSpaceId}
              placeholder="Pick a space…"
              options={existingSpaces.map((s) => ({ value: s.id, label: s.displayName }))}
            />
          )}

          <div
            className={`add-space-drop-zone${dragging ? " add-space-drop-zone--over" : ""}${folders.length > 0 ? " add-space-drop-zone--filled" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
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
            {folders.length > 0 ? (
              <div className="add-space-folder-list">
                {folders.map((f) => (
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
              {pathAmbiguous.map((p) => (
                <button key={p} className="add-space-ambiguous-option" onClick={() => {
                  addFolderIfNew(p);
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
          disabled={scanning || (mode === "new" ? !name.trim() : !existingSpaceId || folders.length === 0)}
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

  const selected = options.find((o) => o.value === value);

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
          {options.map((o) => (
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
