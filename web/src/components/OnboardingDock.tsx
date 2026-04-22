import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./OnboardingDock.css";

type ClientKey = "claude" | "cursor" | "vscode" | "windsurf";

const CLIENT_TABS: { key: ClientKey; label: string }[] = [
  { key: "claude", label: "Claude Code" },
  { key: "cursor", label: "Cursor" },
  { key: "vscode", label: "VS Code" },
  { key: "windsurf", label: "Windsurf" },
];

const CLIENT_CONFIGS: Record<ClientKey, { hint: string; command: (mcpUrl: string) => string }> = {
  claude: {
    hint: "run in your terminal",
    command: (mcpUrl) => `claude mcp add --scope user --transport http oyster ${mcpUrl}`,
  },
  cursor: {
    hint: ".cursor/mcp.json",
    command: (mcpUrl) =>
      `{
  "mcpServers": {
    "oyster": {
      "url": "${mcpUrl}"
    }
  }
}`,
  },
  vscode: {
    hint: ".vscode/mcp.json",
    command: (mcpUrl) =>
      `{
  "servers": {
    "oyster": {
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}`,
  },
  windsurf: {
    hint: "~/.codeium/windsurf/mcp_config.json",
    command: (mcpUrl) =>
      `{
  "mcpServers": {
    "oyster": {
      "serverUrl": "${mcpUrl}"
    }
  }
}`,
  },
};

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

const ACTION_LOG_LIMIT = 50;
// Step 2 completion heuristic: the agent has called onboard_space AND at
// least one other tool. That pattern means the agent genuinely did something
// (created a space), not just pinged Oyster.
const STEP2_ONBOARD_TOOLS = new Set(["onboard_space"]);

interface ToolCall {
  tool: string;
  at: string;
  isError: boolean;
}

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

interface OnboardingDockProps {
  onOpenImport?: () => void;
}

export function OnboardingDock({ onOpenImport }: OnboardingDockProps = {}) {
  const [state, setState] = useState<OnboardingState>(loadState);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [viewingStep, setViewingStep] = useState<StepIndex>(() => activeStep(loadState()));
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const dockRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => { saveState(state); }, [state]);

  // On mount, check the REST fallback so refreshes pick up an already-
  // connected agent immediately without waiting for a new SSE push.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/mcp/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.connected_clients > 0) {
          setState((s) => (s.step1Complete ? s : { ...s, step1Complete: true }));
        }
      })
      .catch(() => { /* server may not be up yet */ });
    return () => { cancelled = true; };
  }, []);

  // Listen for MCP connect + tool-call SSE events. Shares the channel with
  // App.tsx's existing EventSource; the server broadcasts to every client.
  useEffect(() => {
    const es = new EventSource("/api/ui/events");
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.command === "mcp_client_connected") {
          setState((s) => (s.step1Complete ? s : { ...s, step1Complete: true }));
          // If the user is currently staring at step 1, slide them to step 2.
          setViewingStep((v) => (v === 1 ? 2 : v));
        }
        if (event.command === "mcp_tool_called") {
          const call: ToolCall = {
            tool: event.payload?.tool ?? "unknown",
            at: event.payload?.at ?? new Date().toISOString(),
            isError: Boolean(event.payload?.is_error),
          };
          setToolCalls((prev) => {
            const next = [...prev, call];
            return next.length > ACTION_LOG_LIMIT ? next.slice(-ACTION_LOG_LIMIT) : next;
          });
        }
      } catch { /* malformed event */ }
    };
    return () => es.close();
  }, []);

  // Step 2 heuristic: once the agent has called `onboard_space` at least
  // once AND any other tool, mark step 2 complete. Runs in an effect so
  // we only transition once; subsequent tool calls don't toggle state.
  useEffect(() => {
    if (state.step2Complete) return;
    const hasOnboard = toolCalls.some((c) => STEP2_ONBOARD_TOOLS.has(c.tool) && !c.isError);
    const hasOther = toolCalls.some((c) => !STEP2_ONBOARD_TOOLS.has(c.tool) && !c.isError);
    if (hasOnboard && hasOther) {
      setState((s) => ({ ...s, step2Complete: true }));
      // If the user is staring at step 2 when it auto-completes, slide
      // them to step 3 so the popover reflects the new state.
      setViewingStep((v) => (v === 2 ? 3 : v));
    }
  }, [toolCalls, state.step2Complete]);

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

          {viewingStep === 1 && <Step1Connect onComplete={markStep1} />}
          {viewingStep === 2 && <Step2AgentWork onComplete={markStep2} toolCalls={toolCalls} />}
          {viewingStep === 3 && (
            <Step3Memories
              onComplete={markStep3}
              onSkip={skipStep3}
              onOpenImport={onOpenImport}
            />
          )}

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

function Step1Connect({ onComplete }: { onComplete: () => void }) {
  const [client, setClient] = useState<ClientKey>("claude");
  const [copied, setCopied] = useState(false);
  const mcpUrl = useMemo(() => `${window.location.origin}/mcp/`, []);
  const config = CLIENT_CONFIGS[client];
  const command = useMemo(() => config.command(mcpUrl), [config, mcpUrl]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [command]);

  // Reset the copied state when the user switches tabs so the button is
  // truthful about whether the *currently visible* command is in the clipboard.
  const switchClient = useCallback((next: ClientKey) => {
    setClient(next);
    setCopied(false);
  }, []);

  return (
    <div className="onboarding-step">
      <div className="onboarding-step-title">Connect Oyster to your agent</div>
      <div className="onboarding-step-desc">Run it once — your agent takes it from there.</div>

      <div className="onboarding-client-tabs">
        {CLIENT_TABS.map((t) => (
          <button
            key={t.key}
            className={`onboarding-client-tab${client === t.key ? " active" : ""}`}
            onClick={() => switchClient(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="onboarding-code-box">
        <pre><code>{command}</code></pre>
        <button
          className={`onboarding-code-copy${copied ? " copied" : ""}`}
          onClick={handleCopy}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>

      <div className="onboarding-waiting">
        <span className="onboarding-waiting-dot" />
        Waiting for your agent…
      </div>

      <div className="onboarding-step-actions">
        <button className="onboarding-btn-ghost" onClick={onComplete}>
          I've connected it
        </button>
      </div>
    </div>
  );
}

// One short prompt. The agent reads get_context from the oyster MCP to
// learn the rest (how to discover the dev folder, what tools to call,
// etc.). Keeping this minimal pushes the intelligence where it belongs:
// into the server's self-description, not into the user's head.
const AGENT_PROMPT = "Set up Oyster for me. Call the oyster MCP's get_context tool first — it explains the rest.";

function Step2AgentWork({ onComplete, toolCalls }: { onComplete: () => void; toolCalls: ToolCall[] }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(AGENT_PROMPT).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, []);

  const hasActivity = toolCalls.length > 0;

  return (
    <div className="onboarding-step">
      <div className="onboarding-step-title">Ask your agent to set things up</div>
      <div className="onboarding-step-desc">Paste this in your agent. Watch the desktop fill.</div>

      <div className="onboarding-code-box">
        <pre><code>{AGENT_PROMPT}</code></pre>
        <button
          className={`onboarding-code-copy${copied ? " copied" : ""}`}
          onClick={handleCopy}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>

      {hasActivity ? (
        <div className="onboarding-action-log">
          {toolCalls.slice(-10).map((call, i) => (
            <div key={`${call.at}-${i}`} className="onboarding-action-line">
              <span className={call.isError ? "onboarding-action-pending" : "onboarding-action-tick"}>
                {call.isError ? "✗" : "✓"}
              </span>
              <span>{call.tool}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="onboarding-action-log onboarding-action-log--empty">
          <span className="onboarding-waiting-dot" />
          Watching for your agent's activity…
        </div>
      )}

      <div className="onboarding-step-actions">
        <button className="onboarding-btn-ghost" onClick={onComplete}>
          I'm done with this step
        </button>
      </div>
    </div>
  );
}

function Step3Memories({
  onComplete,
  onSkip,
  onOpenImport,
}: {
  onComplete: () => void;
  onSkip: () => void;
  onOpenImport?: () => void;
}) {
  const handleOpen = useCallback(() => {
    onOpenImport?.();
    onComplete();
  }, [onOpenImport, onComplete]);

  return (
    <div className="onboarding-step">
      <div className="onboarding-step-title">Bring in your memories <span className="onboarding-step-optional">· optional</span></div>
      <div className="onboarding-step-desc">Pull context from Claude.ai or ChatGPT.</div>
      <div className="onboarding-trust-note">
        <strong>Everything stays on your machine.</strong> Oyster never sends your paste anywhere.
      </div>
      <div className="onboarding-step-actions">
        <button
          className="onboarding-btn-primary"
          onClick={handleOpen}
          disabled={!onOpenImport}
          title={!onOpenImport ? "Import flow not available" : undefined}
        >
          Open import →
        </button>
        <button className="onboarding-btn-ghost" onClick={onSkip}>Skip</button>
      </div>
    </div>
  );
}
