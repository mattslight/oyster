export const ARTIFACT_KINDS = [
  "app", "deck", "diagram", "map", "notes", "table", "wireframe",
] as const;

export type ArtifactKind = typeof ARTIFACT_KINDS[number];

export function shouldOpenFullscreen(kind: ArtifactKind): boolean {
  return kind === "deck" || kind === "app" || kind === "diagram";
}

export type ArtifactStatus =
  | "generating"
  | "offline"
  | "online"
  | "ready"
  | "starting";

export type IconStatus = "pending" | "generating" | "ready" | "failed";

export interface Artifact {
  id: string;
  label: string;
  artifactKind: ArtifactKind;
  spaceId: string;
  status: ArtifactStatus;
  runtimeKind: string;
  runtimeConfig: Record<string, unknown>;
  url: string;
  icon?: string;
  iconStatus?: IconStatus;
  createdAt: string;
  groupName?: string;
  pendingReveal?: boolean;
  /** First-party app bundled with Oyster (builtins/*). Read-only — cannot be renamed or archived from the UI. */
  builtin?: boolean;
  /** Third-party plugin installed via `oyster install <id>`. Removal means uninstall (delete folder), not archive. */
  plugin?: boolean;
  /** For plugin artifacts: the folder-name id under ~/.oyster/userland/ (e.g. "pomodoro"). Used by Uninstall since `id` is a UUID that doesn't map to a directory. */
  pluginId?: string;
  /** Display label for the linked source folder (e.g. "oyster-os" — the leaf basename of the source path). Set when `artifacts.source_id` is non-null. Absolute paths intentionally stay server-side; full-path drilldown is a separate, locally-gated endpoint. Drives the "↗" provenance glyph and its tooltip. */
  sourceLabel?: string | null;
  /** Where the artefact originated. `manual` — user created it directly. `discovered` — surfaced by a folder scan / linked source. `ai_generated` — produced by an agent. Drives the source filter on Home. */
  sourceOrigin?: "manual" | "discovered" | "ai_generated";
  /** ID of the linked source folder this artefact came from. Null/undefined for native artefacts (manual / ai_generated). Drives per-folder filtering on the project-tile grid. */
  sourceId?: string | null;
  /** Cloud publication state for this artefact. Omitted entirely when no
   *  share token has ever been minted. When present with `unpublishedAt: null`
   *  the artefact is currently public; when `unpublishedAt` is non-null the
   *  publication has been retired (chip hides; URL serves 410). */
  publication?: ArtefactPublication | null;
}

export interface ArtefactPublication {
  shareToken: string;
  shareUrl: string;
  shareMode: "open" | "password" | "signin";
  publishedAt: number;
  updatedAt: number;
  unpublishedAt: number | null;  // null = live; non-null = retired
}

export type ScanStatus = "none" | "scanning" | "complete" | "error";

export interface ScanResult {
  discovered: number;
  skipped: number;
  resurfaced: number;
  errors: string[];
  artifacts: Array<{ id: string; label: string; kind: string; sourceRef: string | null }>;
}

export type SessionState = "active" | "waiting" | "disconnected" | "done";
export type SessionAgent = "claude-code" | "opencode" | "codex";

/** Agent session captured by the watchers (#251). Read-only on the wire — UI mutations come later. */
export interface Session {
  id: string;
  spaceId: string | null;
  /** Source (project / linked folder) within the space, when the session's
   * cwd matched a registered source. Null for sessions in unattached cwds
   * and for native (non-source-backed) work. */
  sourceId: string | null;
  /** Display label of the source — `source.label ?? basename(source.path)`.
   * Resolved server-side via a batched join so the Home active-projects
   * tiles don't need a per-row lookup. Null when sourceId is null or
   * (rare) when the source has been hard-deleted. */
  sourceLabel: string | null;
  /** Original working directory captured by the watcher. Persisted so
   * the UI can rebuild the resume command (`cd <cwd> && claude
   * --resume <id>`) and label orphan sessions whose cwd doesn't match
   * any registered source. Null for older rows pre-cwd migration. */
  cwd: string | null;
  agent: SessionAgent;
  title: string | null;
  state: SessionState;
  startedAt: string;
  endedAt: string | null;
  model: string | null;
  lastEventAt: string;
}

export type SessionEventRole =
  | "user"
  | "assistant"
  | "tool"
  | "tool_result"
  | "system";

export type SessionArtifactRole = "create" | "modify" | "read";

/** A single transcript turn or tool call captured by the watcher. */
export interface SessionEvent {
  id: number;
  sessionId: string;
  role: SessionEventRole;
  text: string;
  ts: string;
  /** Raw JSONL line as written by the agent. Populated when `text` alone is insufficient (tool calls, tool results). */
  raw: string | null;
}

/** A session × artefact join row (M:N — sessions may touch many artefacts). */
export interface SessionArtifact {
  id: number;
  sessionId: string;
  artifactId: string;
  role: SessionArtifactRole;
  whenAt: string;
}

/** API response shape: a SessionArtifact joined with its Artifact row. */
export interface SessionArtifactJoined extends SessionArtifact {
  artifact: Artifact;
}

/** API response shape: a SessionArtifact joined with its Session row (used by /api/artifacts/:id/sessions). */
export interface SessionJoinedForArtifact extends SessionArtifact {
  session: Session;
}

export interface Space {
  id: string;
  displayName: string;
  color: string | null;
  parentId: string | null;
  scanStatus: ScanStatus;
  scanError: string | null;
  lastScannedAt: string | null;
  lastScanSummary: Omit<ScanResult, "artifacts"> | null;
  summaryTitle: string | null;
  summaryContent: string | null;
  createdAt: string;
  updatedAt: string;
}

/** SSE message broadcast on /api/ui/events. The web app subscribes via
 *  subscribeUiEvents and routes by `command`. The `version` field is
 *  reserved for future envelope evolution — today's client (ui-events.ts)
 *  uses a narrower `{command, payload}` shape and doesn't gate on version,
 *  so any non-additive change still requires a coordinated client update. */
export interface UiCommand {
  version: 1;
  command: string;
  payload: unknown;
  correlationId?: string;
}

/** A folder candidate in a setup proposal. Path is absolute (server-side);
 *  label is the leaf basename for display. */
export interface SetupProposalFolder {
  path: string;
  label: string;
}

/** A proposed space grouping in a setup proposal. The agent picks the name
 *  and groups related folders; the user can edit names, toggle the space
 *  on/off, and drag chips between spaces or to/from Everything else. */
export interface SetupProposalSpace {
  /** Stable client-side id used for selection / dnd. Not the slugified
   *  space id — that's derived from the (possibly-edited) name on apply. */
  key: string;
  name: string;
  reason?: string;
  folders: SetupProposalFolder[];
}

/** Full proposal payload. Emitted by the agent via the `propose_setup` MCP
 *  tool, broadcast over SSE as `setup_proposal_ready`, rendered by the
 *  standalone SetupProposalPanel. */
export interface SetupProposal {
  /** Server-issued correlation id for telemetry / log lookup. The apply
   *  route does NOT enforce it: the panel sends the user's edited plan,
   *  not a ratification of the original proposal, so a stale id is fine.
   *  Real safety lives in `addSource` validating each path on disk. */
  proposalId: string;
  spaces: SetupProposalSpace[];
  everythingElse: SetupProposalFolder[];
}

/** Per-space outcome from POST /api/setup/apply. Mirrors the shape returned
 *  by the underlying onboard_space service so the UI can show partial
 *  failures honestly. */
export interface SetupApplyResult {
  spaceId: string;
  name: string;
  created: boolean;
  paths: Array<{ path: string; status: "attached" | "owned-by-other-space" | "failed"; error?: string }>;
}
