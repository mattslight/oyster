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

// v2: switched from a 3-step gated funnel (step1Complete / step2Complete /
// step3Complete) to a 4-item checklist with one required item. Bumping the
// key invalidates the old shape rather than migrating it — most criteria
// re-derive on mount (userSpaceCount, MCP status), so a fresh state is
// quickly populated to truth without bothering the user.
const STORAGE_KEY = "oyster-onboarding-state-v2";

type ItemKey = "spaces" | "publish" | "mcp" | "memories";

interface OnboardingState {
  spacesComplete: boolean;
  publishComplete: boolean;
  mcpComplete: boolean;
  memoriesComplete: boolean;
}

const defaultState: OnboardingState = {
  spacesComplete: false,
  publishComplete: false,
  mcpComplete: false,
  memoriesComplete: false,
};

interface ChecklistItem {
  key: ItemKey;
  title: string;
  required: boolean;
  desc: string;
  actionLabel: string;
}

// Order matters: required first, then optionals in install-friction order
// (publish = no install; MCP = config edit; memories = external AI roundtrip).
const ITEMS: ChecklistItem[] = [
  {
    key: "spaces",
    title: "Set up your spaces",
    required: true,
    desc: "Let Oyster scan your dev folders and group your work into spaces.",
    actionLabel: "Set up Oyster",
  },
  {
    key: "publish",
    title: "Publish your first artefact",
    required: false,
    desc: "Make a thing in chat, click Publish — get a share URL.",
    actionLabel: "Show me how",
  },
  {
    key: "mcp",
    title: "Connect another agent (MCP)",
    required: false,
    desc: "Drive Oyster from Claude Code, Cursor, VS Code or Windsurf.",
    actionLabel: "Show me how",
  },
  {
    key: "memories",
    title: "Import memories",
    required: false,
    desc: "Bring memories from ChatGPT or Claude into Oyster.",
    actionLabel: "Show me how",
  },
];

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

const COMPLETE_KEY: Record<ItemKey, keyof OnboardingState> = {
  spaces: "spacesComplete",
  publish: "publishComplete",
  mcp: "mcpComplete",
  memories: "memoriesComplete",
};

function isComplete(state: OnboardingState, key: ItemKey): boolean {
  return state[COMPLETE_KEY[key]];
}

function allDone(state: OnboardingState): boolean {
  return state.spacesComplete && state.publishComplete && state.mcpComplete && state.memoriesComplete;
}

interface OnboardingDockProps {
  /** Count of user-defined spaces (excludes home / __all__ / __archived__).
   *  Drives the bidirectional auto-tick on the required Spaces item: any
   *  space exists → ticked; deletes back to zero → un-ticked. */
  userSpaceCount?: number;
}

type View = "checklist" | { kind: "step"; key: Exclude<ItemKey, "spaces"> };

export function OnboardingDock({ userSpaceCount = 0 }: OnboardingDockProps = {}) {
  const [state, setState] = useState<OnboardingState>(loadState);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [view, setView] = useState<View>("checklist");
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
          setState((s) => (s.mcpComplete ? s : { ...s, mcpComplete: true }));
        }
      })
      .catch(() => { /* server may not be up yet */ });
    return () => { cancelled = true; };
  }, []);

  // Listen for MCP connect events via the shared SSE subscription (App.tsx
  // also subscribes) so we only hold one EventSource per tab.
  useEffect(() => subscribeUiEvents((event) => {
    if (event.command === "mcp_client_connected") {
      setState((s) => (s.mcpComplete ? s : { ...s, mcpComplete: true }));
    }
  }), []);

  // Spaces auto-tick: bidirectional. Any user-created space → ticked;
  // deleting back to zero → un-ticked. Honest reflection of *current* setup
  // state, not a high-water-mark from a past session.
  useEffect(() => {
    const shouldBe = userSpaceCount > 0;
    setState((s) => (s.spacesComplete === shouldBe ? s : { ...s, spacesComplete: shouldBe }));
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

  const togglePopover = useCallback(() => {
    setView("checklist");
    setPopoverOpen((v) => !v);
  }, []);

  const markDone = useCallback((key: ItemKey) => {
    setState((s) => ({ ...s, [COMPLETE_KEY[key]]: true }));
  }, []);

  const handleSetUpSpaces = useCallback(() => {
    // Send the canonical setup prompt to the chat. ChatBar listens for this
    // event and routes through the same handleSend path as its hero
    // "Set up Oyster" button.
    window.dispatchEvent(
      new CustomEvent("oyster:send-prompt", { detail: { text: "Set up Oyster" } }),
    );
    setPopoverOpen(false);
  }, []);

  const resetAll = useCallback(() => {
    // Initialise spacesComplete directly from the current userSpaceCount.
    // The [userSpaceCount] auto-derive effect won't re-fire if the count
    // hasn't changed, so we'd otherwise leave a user with existing spaces
    // stuck on an un-ticked required item.
    setState({ ...defaultState, spacesComplete: userSpaceCount > 0 });
    setView("checklist");
    setPopoverOpen(true);
  }, [userSpaceCount]);

  const done = allDone(state);
  const requiredDone = state.spacesComplete;

  return (
    <>
      <button
        type="button"
        ref={dockRef}
        className={`onboarding-dock${done ? " onboarding-dock--ready" : ""}${popoverOpen ? " onboarding-dock--active" : ""}`}
        onClick={togglePopover}
        aria-expanded={popoverOpen}
        aria-label={
          done
            ? "Oyster setup complete"
            : requiredDone
              ? "Continue Oyster setup"
              : "Set up Oyster"
        }
      >
        {!requiredDone && <span className="onboarding-dock-progress" />}
        {requiredDone && <span className="onboarding-dock-check">✓</span>}
        {/* Three pill states. Pre-required: amber dot + "Set up Oyster",
            attention-grabbing. Post-required-with-optionals-pending: green
            check + "Continue setup", invites further exploration without
            implying anything's broken. All-done: green-tinted pill, glyph
            only — silent confirmation. */}
        {!done && (
          <span className="onboarding-dock-label">
            {requiredDone ? "Continue setup" : "Set up Oyster"}
          </span>
        )}
      </button>

      {popoverOpen && (
        <div ref={popoverRef} className="onboarding-popover" role="dialog" aria-label="Oyster setup">
          <div className="onboarding-popover-arrow" />

          {view === "checklist" ? (
            <Checklist
              state={state}
              requiredDone={requiredDone}
              done={done}
              onSetUpSpaces={handleSetUpSpaces}
              onShowStep={(key) => setView({ kind: "step", key })}
              onReset={resetAll}
            />
          ) : view.kind === "step" && view.key === "publish" ? (
            <PublishGuide
              onBack={() => setView("checklist")}
              onMarkDone={() => { markDone("publish"); setView("checklist"); }}
              done={state.publishComplete}
            />
          ) : view.kind === "step" && view.key === "mcp" ? (
            <McpConnect
              onBack={() => setView("checklist")}
              onMarkDone={() => { markDone("mcp"); setView("checklist"); }}
              done={state.mcpComplete}
            />
          ) : view.kind === "step" && view.key === "memories" ? (
            <MemoriesImport
              onBack={() => setView("checklist")}
              onMarkDone={() => { markDone("memories"); setView("checklist"); }}
            />
          ) : null}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Checklist view                                                      */
/* ------------------------------------------------------------------ */

interface ChecklistProps {
  state: OnboardingState;
  requiredDone: boolean;
  done: boolean;
  onSetUpSpaces: () => void;
  onShowStep: (key: Exclude<ItemKey, "spaces">) => void;
  onReset: () => void;
}

function Checklist({ state, requiredDone, done, onSetUpSpaces, onShowStep, onReset }: ChecklistProps) {
  return (
    <div className="onboarding-checklist">
      {ITEMS.map((item) => {
        const itemDone = isComplete(state, item.key);
        // Required: show CTA until done. Optional: show CTA only once the
        // required step is done. Pre-required-done, optionals render as
        // quiet preview rows so nothing competes with the one required step.
        const showAction = item.required ? !itemDone : (requiredDone && !itemDone);
        const tag: "required" | "optional" | "done" = itemDone
          ? "done"
          : item.required
            ? "required"
            : "optional";
        return (
          <div key={item.key} className={`onboarding-item${itemDone ? " onboarding-item--done" : ""}`}>
            <span className={`onboarding-item-icon onboarding-item-icon--${tag}`}>
              {itemDone && "✓"}
            </span>
            <div className="onboarding-item-body">
              <div className="onboarding-item-title">
                {item.title}
                <span className={`onboarding-item-tag onboarding-item-tag--${tag}`}>
                  {tag}
                </span>
              </div>
              {!itemDone && <div className="onboarding-item-desc">{item.desc}</div>}
              {showAction && (
                <button
                  type="button"
                  className="onboarding-item-action"
                  onClick={() => {
                    if (item.key === "spaces") onSetUpSpaces();
                    else onShowStep(item.key);
                  }}
                >
                  {item.actionLabel}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {done && (
        <div className="onboarding-summary">
          You're all set.{" "}
          <button type="button" className="onboarding-link" onClick={onReset}>Reset</button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-views — opened from "Show me how" on the optional items.       */
/* Each renders standalone content + a Back link to the checklist.    */
/* ------------------------------------------------------------------ */

function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="onboarding-back" onClick={onBack}>
      ← Back to checklist
    </button>
  );
}

function PublishGuide({ onBack, onMarkDone, done }: { onBack: () => void; onMarkDone: () => void; done: boolean }) {
  return (
    <div className="onboarding-step">
      <BackBar onBack={onBack} />
      <div className="onboarding-step-title">Publish your first artefact</div>
      <div className="onboarding-step-desc">
        Make a thing in chat — a deck, a doc, a mockup. It lands as a tile
        on the surface. Open it, click Publish, pick an access mode (open,
        password or sign-in), and you'll get a share URL on oyster.to.
      </div>
      <div className="onboarding-disclaimer">
        Free includes 5 published artefacts; Oyster Pro lifts the cap.
      </div>
      <div className="onboarding-step-actions">
        {done ? (
          <button type="button" className="onboarding-btn-ghost" onClick={onBack}>Done</button>
        ) : (
          <button type="button" className="onboarding-btn-ghost" onClick={onMarkDone}>I've done this</button>
        )}
      </div>
    </div>
  );
}

function McpConnect({ onBack, onMarkDone, done }: { onBack: () => void; onMarkDone: () => void; done: boolean }) {
  const [client, setClient] = useState<ClientKey>("claude");
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);
  const mcpUrl = useMemo(() => `${window.location.origin}/mcp/`, []);
  const config = CLIENT_CONFIGS[client];
  const command = useMemo(() => config.command(mcpUrl), [config, mcpUrl]);

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
      // Clipboard blocked; the command is still visible in the code box.
    }
  }, [command]);

  const switchClient = useCallback((next: ClientKey) => {
    setClient(next);
    setCopied(false);
  }, []);

  return (
    <div className="onboarding-step">
      <BackBar onBack={onBack} />
      <div className="onboarding-step-title">Connect another agent</div>
      <div className="onboarding-step-desc">Run this once — your agent takes it from there.</div>

      <div className="onboarding-client-tabs">
        {CLIENT_TABS.map((t) => (
          <button
            type="button"
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
          type="button"
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
        {done ? (
          <button type="button" className="onboarding-btn-ghost" onClick={onBack}>Done</button>
        ) : (
          <button type="button" className="onboarding-btn-ghost" onClick={onMarkDone}>I've connected it</button>
        )}
      </div>
    </div>
  );
}

function MemoriesImport({
  onBack,
  onMarkDone,
}: {
  onBack: () => void;
  onMarkDone: () => void;
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
      // Clipboard blocked — keep the user on sub-step "a" so the prompt is
      // still visible to copy manually.
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
        <BackBar onBack={onBack} />
        <div className="onboarding-step-title">Copied</div>
        <div className="onboarding-step-desc">
          Paste into your Chat AI. Paste the response into Oyster's chat ↓
        </div>
        <div className="onboarding-step-actions">
          <button type="button" className="onboarding-btn-primary" style={{ flex: 1 }} onClick={onMarkDone}>
            Done
          </button>
          <button type="button" className="onboarding-btn-ghost" onClick={() => setSub("a")}>Back</button>
        </div>
        <div className="onboarding-disclaimer">Everything stays on your machine.</div>
      </div>
    );
  }

  return (
    <div className="onboarding-step">
      <BackBar onBack={onBack} />
      <div className="onboarding-step-title">Import memories</div>
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
            type="button"
            className="onboarding-btn-primary"
            style={{ flex: 1 }}
            onClick={retry}
          >
            Retry
          </button>
        ) : (
          <button
            type="button"
            className="onboarding-btn-primary"
            style={{ flex: 1 }}
            onClick={handleCopy}
            disabled={!prompt}
          >
            Copy
          </button>
        )}
        <button type="button" className="onboarding-btn-ghost" onClick={onMarkDone}>Skip</button>
      </div>

      <div className="onboarding-disclaimer">Everything stays on your machine.</div>
    </div>
  );
}
