interface Props {
  onImportFromAI: () => void;
  onDismiss: () => void;
}

export function OnboardingBanner({ onImportFromAI, onDismiss }: Props) {
  return (
    <div className="onboarding-banner">
      <div className="onboarding-banner-content">
        <h2>Set up your workspace</h2>
        <p>Bring in your projects and context from other tools.</p>
        <div className="onboarding-banner-actions">
          <button className="onboarding-btn-primary" onClick={onImportFromAI}>
            Import from AI
          </button>
          <button className="onboarding-btn-secondary" disabled title="Coming soon">
            Scan my machine
          </button>
        </div>
        <button className="onboarding-dismiss" onClick={onDismiss}>
          skip for now
        </button>
      </div>
    </div>
  );
}
