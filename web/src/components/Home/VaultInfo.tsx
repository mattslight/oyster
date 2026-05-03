// Vault hero + inventory page (Oyster Pro teaser). Extracted from
// Home/index.tsx.
import { Brain, Globe, RefreshCw, Shield } from "lucide-react";
import { VaultContents } from "./VaultContents";

export function VaultInfo() {
  return (
    <div className="home-vault-page">
      <section className="home-vault-hero">
        <div className="home-vault-hero-glow" aria-hidden="true" />
        <div className="home-vault-hero-content">
          <div className="home-vault-hero-eyebrow">
            <Shield size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" />
            <span>Oyster Pro</span>
            <span className="home-vault-hero-pill">Coming soon</span>
          </div>
          <h2 className="home-vault-hero-title">Your Oyster, everywhere.</h2>
          <p className="home-vault-hero-sub">
            Your spaces, artifacts, and your AI's memory — continue anywhere,
            in any agent. Backed up, encrypted, picked up wherever you left off.
          </p>
          <div className="home-vault-hero-chips">
            <span className="home-vault-chip">
              <RefreshCw size={12} strokeWidth={2} aria-hidden="true" />
              Sync
            </span>
            <span className="home-vault-chip">
              <Brain size={12} strokeWidth={2} aria-hidden="true" />
              Memory
            </span>
            <span className="home-vault-chip">
              <Globe size={12} strokeWidth={2} aria-hidden="true" />
              Publish
            </span>
          </div>
          <div className="home-vault-hero-cta">
            <a
              className="home-vault-hero-button"
              href="https://oyster.to/pricing#waitlist"
              target="_blank"
              rel="noopener noreferrer"
            >
              Join the waitlist
            </a>
            <a
              className="home-vault-hero-button home-vault-hero-button--secondary"
              href="https://oyster.to/pricing"
              target="_blank"
              rel="noopener noreferrer"
            >
              Read more
            </a>
          </div>
        </div>
        <div className="home-vault-hero-art" aria-hidden="true">
          <div className="home-vault-hero-art-ring" />
          <div className="home-vault-hero-art-ring home-vault-hero-art-ring--mid" />
          <div className="home-vault-hero-art-ring home-vault-hero-art-ring--inner" />
          <Shield size={56} strokeWidth={1.5} className="home-vault-hero-art-shield" />
        </div>
      </section>

      <VaultContents />

    </div>
  );
}
