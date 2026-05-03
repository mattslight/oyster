// Vault inventory list (cloud-sync teaser body). Extracted from
// Home/index.tsx.
import { useEffect, useState } from "react";
import { formatBytes, pluralize } from "./utils";

interface VaultInventoryEntry {
  name: string;
  label: string;
  description: string;
  count: number;
  unit: string;
  size: number;
  exists: boolean;
  meta?: string;
}

interface VaultInventory {
  root: string;
  totalSize: number;
  entries: VaultInventoryEntry[];
}

export function VaultContents() {
  const [inv, setInv] = useState<VaultInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/vault/inventory")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data) => { if (!cancelled) setInv(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <section className="home-vault-contents">
        <div className="home-vault-contents-head">
          <span className="home-vault-contents-label">Your Oyster</span>
          <span className="home-vault-section-rule" />
        </div>
        <p className="home-vault-empty">Couldn't load: {error}</p>
      </section>
    );
  }
  if (!inv) {
    return (
      <section className="home-vault-contents">
        <div className="home-vault-contents-head">
          <span className="home-vault-contents-label">Your Oyster</span>
          <span className="home-vault-section-rule" />
        </div>
        <p className="home-vault-empty">Reading your vault…</p>
      </section>
    );
  }
  return (
    <section className="home-vault-contents">
      <div className="home-vault-contents-head">
        <span className="home-vault-contents-label">In your vault</span>
        <span className="home-vault-contents-path">{inv.root}</span>
        <span className="home-vault-section-rule" />
      </div>
      <ul className="home-vault-contents-list">
        {inv.entries.map((e) => (
          <li key={e.name} className={`home-vault-row${!e.exists ? " home-vault-row--missing" : ""}`}>
            <span className="home-vault-row-name">{e.label}</span>
            <span className="home-vault-row-desc">
              {e.description}
              {e.meta && <span className="home-vault-row-meta"> · {e.meta}</span>}
            </span>
            <span className="home-vault-row-count">
              {e.exists ? `${e.count.toLocaleString()} ${pluralize(e.count, e.unit)}` : "—"}
            </span>
            <span className="home-vault-row-size">
              {/* Spaces dir on disk is always empty — real spaces have repo_path
                  elsewhere — so its 0 B is meaningless. Show the vault total
                  in that slot instead; it lands on the topmost row, reading
                  as the headline number for the whole inventory. */}
              {e.name === "spaces" ? formatBytes(inv.totalSize) : (e.exists ? formatBytes(e.size) : "")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
