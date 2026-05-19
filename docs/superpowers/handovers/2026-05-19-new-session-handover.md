# Handover: New Session affordance

**For the next agent — read this end-to-end before doing anything.**

## What you're picking up

The user wants a "Start a fresh Claude session" affordance that's reachable from anywhere in Oyster. Today, the only way to start a fresh session is via *Launch Claude here* on a project tile — which means you have to be on Home, in the right space, and you have to know which tile maps to the folder you want.

Their stated requirements (verbatim):

> Also need to be able to start a new fresh session, if we are on home it should ask which space / project to start in (it will start in the current active cwd).

So the new affordance needs to:

1. Be reachable from any view (Home, Inspector, anywhere the topbar shows).
2. When the user is *already inside a space*, start the new session in the active space's project (whichever cwd is current).
3. When the user is on Home (no space active), open a picker to choose space → project, then start there.

They want this **brainstormed properly before building** — same flow as the previous feature: brainstorm → spec → plan → subagent-driven implementation → finish-a-branch.

## Branching

Branch off the `terminal-minimise-ux` branch (NOT `main`). That branch carries the entire minimise/running-pill feature this work depends on:

```bash
git fetch origin
git worktree add ~/Dev/oyster.worktrees/new-session -b new-session origin/terminal-minimise-ux
ln -s ~/Dev/oyster-dev/.env ~/Dev/oyster.worktrees/new-session/.env
cd ~/Dev/oyster.worktrees/new-session/server && npm install --no-audit --no-fund
cd ~/Dev/oyster.worktrees/new-session/web && npm install --no-audit --no-fund
```

PR target = the merged `terminal-minimise-ux` branch (or `main` if it's been merged by then — check first with `gh pr view 531`).

The user's preferences (from prior memory):
- Non-trivial work in `~/Dev/oyster.worktrees/<branch>` worktrees, never the main checkout.
- When pointing the user at a file, run `open <path>` via Bash — printing the path alone needs cmd+click which is annoying.

## What already exists (relevant context)

### Launch Claude infrastructure (PR #527)

The plumbing for spawning Claude in an in-app terminal already exists. You'll reuse it; don't reinvent.

- **Project tile**: `web/src/components/Home/ProjectTile.tsx` has a *Launch Claude here* button. It calls `onLaunchClaude` which dispatches `OPEN_CLAUDE_TERMINAL` after first spawning a PTY on the server.
- **Server endpoint**: `POST /api/terminals` (in `server/src/routes/terminals.ts`) spawns a new `claude` process via `ClaudePtyManager.spawn`. Takes `{ cwd, command, args, kind }`.
- **Dispatch action**: `OPEN_CLAUDE_TERMINAL` in `web/src/stores/windows.ts` — opens a `TerminalWindow` pointed at the new terminalId.
- **Resume flow**: `web/src/components/SessionInspector/SessionActions.tsx` has `Resume here` which calls `onLaunchClaude` from `App.tsx`. Look at how that callback is wired — it's the reference for what you need to call.

### State you can lean on

- `activeSpace` is in `App.tsx` — the currently-visible space (`"home"` or a real space id).
- `spaces`, `projects` (per-space, fetched lazily) — see `web/src/data/projects-api.ts`.
- `windows` store + dispatch.
- `useSessions()` for the live sessions list.
- `useTerminalPresence` if you need to check live PTY state.

### The Running pill (you're working alongside it)

The `terminal-minimise-ux` branch added a topbar `● N running ▾` pill that lists every live terminal. The New Session affordance should feel like its sibling — discoverable from anywhere in the topbar. Whether it lives as a button next to the running pill, inside the popover, on the avatar menu, or as its own pill is one of the design questions.

## Questions worth exploring (don't decide unilaterally — brainstorm)

1. **Where does the affordance live?**
   - A `+ New session` button in the topbar (next to the running pill)
   - A *New session* option inside the running pill's popover
   - A cmd+K command (`/new` or similar)
   - An overlay/dock button
   - Multiple of the above

2. **When the user is in a space, do they get a picker, or does it just start?**
   - The user said "current active cwd" — but if there are multiple projects in the space, which one is "the active cwd"?
   - The current `activeSpace` doesn't have a notion of "active project" beyond what the user is looking at.
   - Options: (a) start in the first/most-recent project's cwd silently, (b) always ask which project even inside a space, (c) inherit from the most recently used project for that space.

3. **What's the picker UI?**
   - Modal? Popover? Tile-style grid?
   - List spaces, then expand to show projects? Or flat list of all projects across spaces?
   - Recently-used at the top?
   - Should it support typing to filter (cmd+K-style search)?

4. **Agent choice**
   - Today it's always `claude` (via `claude` binary). Are we forward-compatible with `opencode` / future agents? Probably not v1 — leave a hook but don't UI it.
   - First spec-level call: lock to Claude, note future agents as out-of-scope.

5. **What happens after spawn?**
   - The new terminal panel opens, populated and ready for input
   - The session row appears in the Sessions list as soon as the first JSONL event lands
   - Linked correctly via the existing auto-link path
   - Should it pre-fill anything? Probably not.

6. **What happens if you try to start a new session in a folder that has another live session?**
   - That's fine — two `claude` processes in the same cwd are allowed, they'll have separate session ids.
   - But do we surface that ("There's already 1 running terminal here — start another?")? Probably overkill for v1.

7. **What about no-projects-yet?**
   - If user is on Home with zero spaces, the picker has nothing to show.
   - Either: (a) the affordance is hidden until they set up a space, (b) it offers to create a space first ("Add a project to get started"), (c) it falls back to a free-form path picker.

## Suggested workflow

1. `Skill: superpowers:brainstorming` — work the user through the questions above. Use the visual companion for picker UI mockups.
2. Write the spec to `docs/superpowers/specs/2026-05-19-new-session-design.md`.
3. `Skill: superpowers:writing-plans` — break into bite-sized tasks.
4. `Skill: superpowers:subagent-driven-development` — execute the plan.
5. `Skill: superpowers:finishing-a-development-branch` — PR or merge.

## Repo conventions to follow

- Branch + commit on `~/Dev/oyster.worktrees/new-session`, never the main checkout.
- Server: vitest. Web: tsc only (no test runner).
- Commit message style: `feat(scope): short imperative`. See `git log --oneline -20` for examples.
- Pre-commit hooks aren't bypassed; if a hook fails, fix the root cause, don't `--no-verify`.
- CHANGELOG entry in the same PR for user-visible changes; style per `CLAUDE.md`.
- Add `co-authored-by: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` to commits.

## Pointers to read first

- `docs/superpowers/specs/2026-05-19-terminal-minimise-ux-design.md` — the parent feature's spec (sets the design vocabulary).
- `web/src/App.tsx` around lines 600-650 — the TerminalWindow render site, where `OPEN_CLAUDE_TERMINAL` is dispatched.
- `web/src/stores/windows.ts` — `OPEN_CLAUDE_TERMINAL` action shape.
- `server/src/routes/terminals.ts` — `POST /api/terminals` handler.
- `web/src/components/Home/ProjectTile.tsx` — existing *Launch Claude here* call site.
- `web/src/components/Topbar/RunningTerminalsPill.tsx` — the visual sibling.

## What NOT to touch

- The terminal-minimise UX itself. Bug fixes are fine, but redesign requests should be raised separately.
- The session state model (`active / waiting / done`). Renames were discussed and explicitly deferred.
- The `Inspect` chip, the fork warning, the `running` pill positioning — settled.

## How to start

After cloning into the worktree and confirming `git log --oneline -5` shows the terminal-minimise-ux commits at HEAD:

```
Skill: superpowers:brainstorming

I'm picking up the New Session affordance work per the handover at
docs/superpowers/handovers/2026-05-19-new-session-handover.md.
Working in the worktree on branch `new-session` based on
`terminal-minimise-ux`. Let's brainstorm.
```

That's it. Good luck.
