import { useCallback, useEffect, useRef, useState } from "react";
import "./OnboardingDock.css";

const STORAGE_KEY = "oyster-onboarding-state";

type StepIndex = 1 | 2 | 3;

interface OnboardingState {
  step1Complete: boolean;
  step2Complete: boolean;
  step3Complete: boolean;
  dismissed: boolean;
}

const defaultState: OnboardingState = {
  step1Complete: false,
  step2Complete: false,
  step3Complete: false,
  dismissed: false,
};

function loadState(): OnboardingState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState;
    return { ...defaultState, ...JSON.parse(raw) };
  } catch {
    return defaultState;
  }
}

function saveState(state: OnboardingState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore quota errors */ }
}

function activeStep(state: OnboardingState): StepIndex {
  if (!state.step1Complete) return 1;
  if (!state.step2Complete) return 2;
  return 3;
}

function completedCount(state: OnboardingState): number {
  return [state.step1Complete, state.step2Complete, state.step3Complete].filter(Boolean).length;
}

function allDone(state: OnboardingState): boolean {
  return state.step1Complete && state.step2Complete && state.step3Complete;
}

export function OnboardingDock() {
  const [state, setState] = useState<OnboardingState>(loadState);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [viewingStep, setViewingStep] = useState<StepIndex>(() => activeStep(loadState()));
  const dockRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => { saveState(state); }, [state]);

  // Click outside the popover closes it
  useEffect(() => {
    if (!popoverOpen) return;
    function onClick(e: MouseEvent) {
      if (!popoverRef.current || !dockRef.current) return;
      const target = e.target as Node;
      if (popoverRef.current.contains(target)) return;
      if (dockRef.current.contains(target)) return;
      setPopoverOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [popoverOpen]);

  const openPopover = useCallback(() => {
    setViewingStep(activeStep(state));
    setPopoverOpen((v) => !v);
  }, [state]);

  const markStep1 = useCallback(() => {
    setState((s) => ({ ...s, step1Complete: true }));
    setViewingStep(2);
  }, []);

  const markStep2 = useCallback(() => {
    setState((s) => ({ ...s, step2Complete: true }));
    setViewingStep(3);
  }, []);

  const markStep3 = useCallback(() => {
    setState((s) => ({ ...s, step3Complete: true }));
    setPopoverOpen(false);
  }, []);

  const skipStep3 = useCallback(() => {
    setState((s) => ({ ...s, step3Complete: true }));
    setPopoverOpen(false);
  }, []);

  const resetAll = useCallback(() => {
    setState(defaultState);
    setViewingStep(1);
    setPopoverOpen(true);
  }, []);

  const count = completedCount(state);
  const done = allDone(state);

  const dockLabel = done
    ? "✓ Set up"
    : `Set up Oyster · ${count}/3`;

  return (
    <>
      <button
        ref={dockRef}
        className={`onboarding-dock${done ? " onboarding-dock--done" : ""}${popoverOpen ? " onboarding-dock--active" : ""}`}
        onClick={openPopover}
        aria-expanded={popoverOpen}
      >
        {!done && count === 0 && <span className="onboarding-dock-pulse" />}
        {!done && count > 0 && count < 3 && <span className="onboarding-dock-check">✓</span>}
        {done && <span className="onboarding-dock-check">✓</span>}
        <span className="onboarding-dock-label">{dockLabel}</span>
      </button>

      {popoverOpen && (
        <div ref={popoverRef} className="onboarding-popover" role="dialog" aria-label="Oyster setup">
          <div className="onboarding-popover-arrow" />

          <div className="onboarding-progress">
            <div className={`progress-dot${state.step1Complete ? " done" : viewingStep === 1 ? " active" : ""}`} />
            <div className={`progress-dot${state.step2Complete ? " done" : viewingStep === 2 ? " active" : ""}`} />
            <div className={`progress-dot${state.step3Complete ? " done" : viewingStep === 3 ? " active" : ""}`} />
          </div>

          {viewingStep === 1 && <Step1Placeholder onComplete={markStep1} />}
          {viewingStep === 2 && <Step2Placeholder onComplete={markStep2} />}
          {viewingStep === 3 && <Step3Placeholder onComplete={markStep3} onSkip={skipStep3} />}

          {done && (
            <div className="onboarding-done-actions">
              <button className="onboarding-btn-ghost" onClick={resetAll}>Reset setup</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Step content is placeholder for A1 — real implementations land in   */
/* stories A2 (connect), A3 (agent work), A4 (memories). Each uses a   */
/* manual "done" button here so the flow is navigable end-to-end.      */
/* ------------------------------------------------------------------ */

function Step1Placeholder({ onComplete }: { onComplete: () => void }) {
  return (
    <div className="onboarding-step">
      <div className="onboarding-step-header">Step 1 of 3</div>
      <div className="onboarding-step-title">Connect Oyster to your agent</div>
      <div className="onboarding-step-desc">
        Pick the agent you use. Run the command once — your agent will drive the rest of the setup for you.
      </div>
      <div className="onboarding-placeholder">[Step 1 content lands in story A2 — client tabs, copyable command, MCP connect detection]</div>
      <div className="onboarding-step-actions">
        <button className="onboarding-btn-primary" onClick={onComplete}>I've connected it →</button>
      </div>
    </div>
  );
}

function Step2Placeholder({ onComplete }: { onComplete: () => void }) {
  return (
    <div className="onboarding-step">
      <div className="onboarding-step-header">Step 2 of 3</div>
      <div className="onboarding-step-title">Ask your agent to set things up</div>
      <div className="onboarding-step-desc">
        Paste this into your connected agent. It will create spaces for your projects and scan them into Oyster using MCP tools.
      </div>
      <div className="onboarding-placeholder">[Step 2 content lands in story A3 — copyable prompt, live MCP action log]</div>
      <div className="onboarding-step-actions">
        <button className="onboarding-btn-primary" onClick={onComplete}>Done, my agent finished →</button>
      </div>
    </div>
  );
}

function Step3Placeholder({ onComplete, onSkip }: { onComplete: () => void; onSkip: () => void }) {
  return (
    <div className="onboarding-step">
      <div className="onboarding-step-header">Step 3 of 3 · Optional</div>
      <div className="onboarding-step-title">Bring in your memories</div>
      <div className="onboarding-step-desc">
        Copy context from Claude.ai or ChatGPT. Oyster generates a prompt you paste there, then paste the result back here.
      </div>
      <div className="onboarding-trust-note">
        <strong>Everything stays on your machine.</strong> Oyster never sends your paste anywhere.
      </div>
      <div className="onboarding-placeholder">[Step 3 content lands in story A4 — link to import-from-ai builtin flow]</div>
      <div className="onboarding-step-actions">
        <button className="onboarding-btn-primary" onClick={onComplete}>Open import →</button>
        <button className="onboarding-btn-ghost" onClick={onSkip}>Skip</button>
      </div>
    </div>
  );
}
