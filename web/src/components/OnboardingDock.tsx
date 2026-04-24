import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { subscribeUiEvents } from "../data/ui-events";
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
}

const defaultState: OnboardingState = {
  step1Complete: false,
  step2Complete: false,
  step3Complete: false,
};

const ACTION_LOG_LIMIT = 50;

interface ToolCall {
  tool: string;
  at: string;
  isError: boolean;
}

// Tool names as they appear in SSE events are snake_case engineering
// labels — useful for debugging, tedious as a status feed. Map to short
// natural-language phrases. Unknown tools fall back to a humanised
// version of the raw name.
const TOOL_PHRASES: Record<string, string> = {
  get_context: "Reading the Oyster playbook",
  list_spaces: "Checking your spaces",
  list_artifacts: "Looking at your artifacts",
  onboard_space: "Creating a space",
  set_space_summary: "Summarising a space",
  scan_space: "Scanning for artifacts",
  create_artifact: "Creating an artifact",
  update_artifact: "Updating an artifact",
  remove_artifact: "Removing an artifact",
  read_artifact: "Reading an artifact",
  open_artifact: "Opening an artifact",
  reveal_artifact: "Opening on the surface",
  gather_repo_context: "Reading a repo",
  regenerate_icon: "Generating an icon",
  remember: "Saving a memory",
  recall: "Recalling a memory",
  forget: "Forgetting a memory",
  list_memories: "Checking your memories",
};

function humanizeTool(tool: string): string {
  if (TOOL_PHRASES[tool]) return TOOL_PHRASES[tool];
  const spaced = tool.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
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
  /** User-defined spaces (from App.tsx). We only look at the count of
   *  non-system spaces as the completion signal for step 2. */
  userSpaceCount?: number;
}

export function OnboardingDock({ userSpaceCount = 0 }: OnboardingDockProps = {}) {
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

  // Listen for MCP connect + tool-call SSE events via the shared subscription
  // (App.tsx also subscribes) so we only hold one EventSource per tab.
  useEffect(() => subscribeUiEvents((event) => {
    if (event.command === "mcp_client_connected") {
      setState((s) => (s.step1Complete ? s : { ...s, step1Complete: true }));
      // If the user is currently staring at step 1, slide them to step 2.
      setViewingStep((v) => (v === 1 ? 2 : v));
    }
    if (event.command === "mcp_tool_called") {
      const payload = event.payload as { tool?: string; at?: string; is_error?: boolean } | undefined;
      const call: ToolCall = {
        tool: payload?.tool ?? "unknown",
        at: payload?.at ?? new Date().toISOString(),
        isError: Boolean(payload?.is_error),
      };
      setToolCalls((prev) => {
        const next = [...prev, call];
        return next.length > ACTION_LOG_LIMIT ? next.slice(-ACTION_LOG_LIMIT) : next;
      });
    }
  }), []);

  // Step 2 completion rule: at least one user-created space exists.
  // That's the real signal the agent did useful work — works identically
  // for external MCP clients (Claude Code, Cursor, ...) and for Oyster's
  // own chat bar. We deliberately do NOT back-fill step 1 here: internal
  // chatbar users haven't connected an MCP client and should still see
  // that step offered. Step 1 gets marked complete only via an actual
  // MCP connection event (see /api/mcp/status + mcp_client_connected).
  useEffect(() => {
    if (userSpaceCount <= 0) return;
    setState((s) => {
      if (s.step2Complete) return s;
      const next = { ...s, step2Complete: true };
      // If the user was viewing step 2 when it auto-completed, move them
      // to whatever's actually still active (step 1 if MCP not done yet,
      // otherwise step 3).
      setViewingStep((v) => v === 2 ? activeStep(next) : v);
      return next;
    });
  }, [userSpaceCount]);

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
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPopoverOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
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
    // Mirror the [userSpaceCount] effect's rule: if a user space already
    // exists, step 2 counts as done. Step 1 (MCP connect) does NOT get
    // auto-marked — it needs an actual MCP connection event regardless of
    // what other setup has happened. Without this carry-forward, the
    // reset would strand the user on step 2 forever (the effect never
    // re-fires because `userSpaceCount` doesn't change).
    const hasSpaces = userSpaceCount > 0;
    setState({
      ...defaultState,
      step2Complete: hasSpaces,
    });
    setToolCalls([]);
    setViewingStep(1);
    setPopoverOpen(true);
  }, [userSpaceCount]);

  const count = completedCount(state);
  const done = allDone(state);

  return (
    <>
      <button
        ref={dockRef}
        className={`onboarding-dock${done ? " onboarding-dock--done" : ""}${popoverOpen ? " onboarding-dock--active" : ""}`}
        onClick={openPopover}
        aria-expanded={popoverOpen}
        aria-label={done ? "Oyster setup complete" : `Oyster setup — ${count} of 3`}
      >
        {!done && count === 0 && <span className="onboarding-dock-pulse" />}
        {!done && count > 0 && <span className="onboarding-dock-check">✓</span>}
        {done && <span className="onboarding-dock-check">✓</span>}
        {!done && (
          <span className="onboarding-dock-label">{`Set up Oyster · ${count}/3`}</span>
        )}
      </button>

      {popoverOpen && (
        <div ref={popoverRef} className="onboarding-popover" role="dialog" aria-label="Oyster setup">
          <div className="onboarding-popover-arrow" />

          {done ? (
            <DoneSummary onReset={resetAll} />
          ) : (
            <>
              <div className="onboarding-progress">
                <div className={`progress-dot${state.step1Complete ? " done" : viewingStep === 1 ? " active" : ""}`} />
                <div className={`progress-dot${state.step2Complete ? " done" : viewingStep === 2 ? " active" : ""}`} />
                <div className={`progress-dot${state.step3Complete ? " done" : viewingStep === 3 ? " active" : ""}`} />
              </div>

              {viewingStep === 1 && <Step1Connect onComplete={markStep1} />}
              {viewingStep === 2 && <Step2AgentWork onComplete={markStep2} toolCalls={toolCalls} />}
              {viewingStep === 3 && (
                <Step3Memories onComplete={markStep3} onSkip={skipStep3} />
              )}
            </>
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
  const copiedTimerRef = useRef<number | null>(null);
  const mcpUrl = useMemo(() => `${window.location.origin}/mcp/`, []);
  const config = CLIENT_CONFIGS[client];
  const command = useMemo(() => config.command(mcpUrl), [config, mcpUrl]);

  // Clear any pending "reset copied" timer if the user advances (unmount)
  // or re-copies before the 1.8s window elapses.
  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, 1800);
    } catch {
      // Clipboard access can be denied (permissions, insecure context in
      // some browsers). Leave `copied` false so the button still shows "copy"
      // — the command is still visible in the code box for manual copy.
    }
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

      <div className="onboarding-code-hint">{config.hint}</div>
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
  const copiedTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(AGENT_PROMPT);
      setCopied(true);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, 1800);
    } catch {
      // Clipboard blocked — prompt is still visible in the code box.
    }
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
              <span className={call.isError ? "onboarding-action-error" : "onboarding-action-tick"}>
                {call.isError ? "✗" : "✓"}
              </span>
              <span>{humanizeTool(call.tool)}</span>
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
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  // a = prompt ready to copy; b = copied, waiting for user to paste-in-AI
  // then paste the response into Oyster's chat.
  const [sub, setSub] = useState<"a" | "b">("a");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Fetch the cloud-AI export prompt. `loadAttempt` drives the retry button —
  // bumping it re-runs the effect. `cache: "no-store"` sidesteps stale-response
  // hangs seen in dev under HMR. Timeout ensures we never sit at "Loading…"
  // forever if something upstream stalls.
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let cancelled = false;

    fetch("/api/import/prompt?provider=chatgpt", { signal: ctrl.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => {
        if (cancelled) return;
        setPrompt(t);
        setLoadError(false);
      })
      .catch(() => { if (!cancelled) setLoadError(true); })
      .finally(() => clearTimeout(timer));

    return () => { cancelled = true; ctrl.abort(); clearTimeout(timer); };
  }, [loadAttempt]);

  const handleCopy = useCallback(async () => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setSub("b");
    } catch {
      // Clipboard blocked (permissions / insecure context). Keep the user
      // on sub-step "a" so the prompt is still visible to copy manually —
      // advancing would land them on a misleading \"Copied\" screen.
    }
  }, [prompt]);

  const retry = useCallback(() => {
    setPrompt(null);
    setLoadError(false);
    setLoadAttempt((n) => n + 1);
  }, []);

  if (sub === "b") {
    return (
      <div className="onboarding-step">
        <div className="onboarding-step-title">Copied</div>
        <div className="onboarding-step-desc">
          Paste into your Chat AI. Paste the response into Oyster's chat ↓
        </div>
        <div className="onboarding-step-actions">
          <button className="onboarding-btn-primary" style={{ flex: 1 }} onClick={onComplete}>
            Done
          </button>
          <button className="onboarding-btn-ghost" onClick={() => setSub("a")}>Back</button>
        </div>
        <div className="onboarding-disclaimer">Everything stays on your machine.</div>
      </div>
    );
  }

  return (
    <div className="onboarding-step">
      <div className="onboarding-step-title">
        Bring in your memories <span className="onboarding-step-optional">· optional</span>
      </div>
      <div className="onboarding-step-desc">Copy this prompt and give it to your Chat AI.</div>

      <div className="onboarding-code-box">
        <pre>
          <code>
            {loadError
              ? "Couldn't load the prompt."
              : prompt ?? "Loading…"}
          </code>
        </pre>
      </div>

      <div className="onboarding-step-actions">
        {loadError ? (
          <button
            className="onboarding-btn-primary"
            style={{ flex: 1 }}
            onClick={retry}
          >
            Retry
          </button>
        ) : (
          <button
            className="onboarding-btn-primary"
            style={{ flex: 1 }}
            onClick={handleCopy}
            disabled={!prompt}
          >
            Copy
          </button>
        )}
        <button className="onboarding-btn-ghost" onClick={onSkip}>Skip</button>
      </div>

      <div className="onboarding-disclaimer">Everything stays on your machine.</div>
    </div>
  );
}

// Rendered when the popover opens after all three steps are complete.
// Keeps the pill's truthful "done" state honest — summary, not a dangling CTA.
function DoneSummary({ onReset }: { onReset: () => void }) {
  return (
    <div className="onboarding-step">
      <div className="onboarding-step-title">You're all set</div>
      <div className="onboarding-step-desc">
        Oyster's ready. Import-from-AI lives on the desktop if you want to revisit.
      </div>
      <div className="onboarding-step-actions">
        <button className="onboarding-btn-ghost" onClick={onReset}>
          Reset setup
        </button>
      </div>
    </div>
  );
}
