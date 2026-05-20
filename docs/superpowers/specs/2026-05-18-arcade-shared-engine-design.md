# Arcade — shared cabinet + platformer

**Date:** 2026-05-18
**Status:** Design / pre-plan
**Branch:** `feat/arcade-platformer`

## Vision

Two games — Rocket Ship (shipped) and a Mario-style platformer (new) — sharing a small set of static-HTML cabinet utilities. The longer arc is `arcade.oyster.to`: a fun, expressive corner of the site where new games can be dropped in without re-implementing CRT chrome, audio unlock, touch controls, or the leaderboard.

The shared layer is a **set of utilities**, not an engine. There is no lifecycle contract, no `window.Game` interface, no shared frame loop. Each game owns its own `requestAnimationFrame`, its own state, its own splash. The shared folder is just files that two games happen to load.

## Inventory — what's portable from Rocket Ship

The current `docs/rocket-ship.html` is 2067 lines. Roughly two-thirds is "cabinet stuff" (visuals, audio, input, leaderboard); one-third is gameplay.

| Layer | Reusable | Game-specific |
|---|---|---|
| Cabinet chrome | Bezel + tube + CRT overlay + vignette + crash-shake CSS | — |
| Pixel font | Press Start 2P `@font-face`, text-select suppression, touch-callout off | — |
| Audio | `ensureAudioCtx` / `playSfx` / `setSfxMuted` / `<audio>` fallback / `localStorage` mute persistence | BGM track, SFX clip set |
| Touch | Coarse-pointer gate, button-bind helper, `is-pressed` styling | Which buttons exist; what they do |
| Iframe ↔ host | `postMessage` close, ESC handler, body-class flag pattern, lazy `src=` swap | Per-game URL |
| Leaderboard | Worker contract, HMAC token mint, local mirror | Per-game DB scope (worker `game` column) |
| Splash / game-over / attract-mode | — (left duplicated, see below) | Title text, layout, hint labels |
| Game loop | — | Physics, entities, collisions |

Splash and game-over deliberately stay per-game for now. Designing a `Splash.configure({ title, controlHints, leaderboardKey, attractFrames })` API from one example is the premature-abstraction trap — we'd lock in shape before we've seen what the platformer actually needs. Refactor those *after* two real examples exist, if at all.

## Approach

**Static files under `docs/arcade/shared/`, no build step.** Matches the rest of the docs site (plain HTML/CSS/JS, no bundler). Each game lives in its own folder, loads the shared files via `<script src="…">` and `<link rel="stylesheet">`, and otherwise runs entirely on its own — its own rAF loop, its own state, its own splash markup.

Alternatives considered:

- **No extraction, copy-paste only.** Cheapest now; the leaderboard worker still needs game scoping for two games to coexist, and audio + pixel-font + cabinet CSS are stable enough that copying them creates pure drift with no upside. Rejected.
- **Engine with a `window.Game = { init, update, draw }` lifecycle.** Designs the contract from N=1 game. Locks in assumptions before the platformer can challenge them. Rejected — start with utilities, not abstractions.
- **ESM modules with a build step.** Cleaner imports, but adds a build to a site that doesn't have one and breaks the "open the HTML and it works" property. Reject for now; revisit if/when `arcade.oyster.to` becomes its own deploy.

## Layout

```
docs/arcade/
  shared/
    cabinet.css        # bezel, tube, CRT overlay, vignette, shake
    pixel-font.css     # Press Start 2P + tap-callout suppression
    audio.js           # AudioCtx, playSfx, BGM, sound-toggle, mute
    touch.js           # button-bind helper, coarse-pointer gate
    touch.css          # on-screen button cluster styling
    iframe-host.js     # postMessage close + ESC handler (lifted verbatim)
    leaderboard.js     # read/write/POST scoped by game key
    sfx/               # only the actually-shared clips: powerup.mp3, lose.mp3, glitch.mp3
  platformer/
    index.html         # loads shared/, has its own splash + game-over markup
    game.js            # game loop, physics, entities
    music.mp3
    level-1.json
    tiles.png          # or procedural
    sfx/               # jump.mp3, stomp.mp3, coin.mp3
```

Rocket Ship stays at `docs/rocket-ship.html` untouched for now. See "Sequence" below.

## What "shared" actually exposes

Plain globals on `window` (matches current rocket-ship style). Each module is small.

- `Audio` — `Audio.ensureCtx()`, `Audio.playSfx(id, vol?)`, `Audio.playBgm(id, { loop, vol }?)`, `Audio.setMuted(bool)`, `Audio.isMuted()`. Mute persisted to `localStorage` under a key the game passes in.
- `Touch` — `Touch.bind(btnEl, onDown, onUp)`, `Touch.isCoarse()`. Game writes its own buttons in HTML; helper wires them up.
- `IframeHost` — auto-installs ESC + `postMessage({ type: 'arcade-close' })` on init. Optional `IframeHost.close()` to trigger from in-game UI.
- `Leaderboard` — `new Leaderboard({ game, max })` returning `{ read(), qualifies(score), submit(score, initials) }`. Game key passed in constructor.

No globals named `Game`. No frame loop in shared. The game wires its own splash, its own game-over panel, its own rAF.

## Platformer game design

**Genre:** Side-scrolling 2D platformer, camera follows player. One level on launch; tilemap-driven so adding levels is data, not code.

**Player:**

- Walks left/right with acceleration + friction.
- Jumps with variable height (hold = higher).
- Coyote time (~80 ms after leaving a ledge) and jump-buffer (~120 ms before landing) for tight feel.
- Stomps enemies from above; takes damage from the side.
- Three lives, shown top-left in pixel font.

**World:**

- 16×16 px logical tiles, rendered upscaled. JSON level format:
  ```json
  {
    "width": 200, "height": 16,
    "tiles": "...string of glyphs, one per tile...",
    "spawn": { "x": 2, "y": 12 },
    "goal":  { "x": 198, "y": 12 },
    "enemies": [{ "x": 30, "y": 12, "type": "walker" }]
  }
  ```
- One starter level; goal flag at end triggers score submission.
- Coins collectable (score), enemies stompable (score + tiny bounce).
- Death: fall off bottom OR touch enemy from side → −1 life. 0 lives → game over.

**Controls:**

- Desktop: ←/→ or A/D move, ↑/W/Space jump, ESC exits.
- Touch: ◀ ▶ on left, ▲ (JUMP) on right. Wired via `shared/touch.js`.

**Audio:**

- Looped chiptune BGM (separate file).
- SFX: jump (blip), stomp (squish), coin (reuses shared `powerup`), hurt (reuses shared `lose`), goal (reuses `powerup`).

**Scoring:** Coins = 10, stomp = 50, time bonus on goal. Submits to leaderboard with `game: 'platformer'`.

## Sequence

Rocket Ship is shipped, polished, and not blocking anything. Don't migrate it. Build the platformer next to it.

1. **Create `docs/arcade/platformer/index.html`.** Copy the cabinet CSS, pixel-font block, audio module, touch glue, and iframe close handler verbatim from `rocket-ship.html`. Edit in place. Get the platformer playable end-to-end with duplicated cabinet code — splash, game-over, the lot.
2. **Worker game scoping.** `infra/leaderboard-worker` gains a `game` column (`ALTER TABLE scores ADD COLUMN game TEXT DEFAULT 'rocket-ship'`). All reads/writes filter on it. API accepts `?game=` query param; missing → `rocket-ship` for back-compat. Platformer uses `game=platformer` from day one. Done as soon as the platformer needs leaderboard, or earlier — it's independent and small.
3. **Extract once the duplication is stable.** When the platformer is playable and the cabinet code in both files is genuinely identical, pull the stable parts (audio, pixel-font, cabinet CSS, touch helper, iframe close) into `docs/arcade/shared/`. Update *only the platformer* to use them. Rocket Ship keeps its inlined copies — no reason to risk touching working code.
4. **Hook up to the site.** Add a platformer entry point in `docs/index.html` — either a second easter egg, a launcher tile, or wait for `arcade.oyster.to` and skip this step.
5. **Rocket Ship migration: not in this scope.** Never, or much later, or only if a third game arrives and the cost of three copies finally exceeds the cost of refactoring. Deliberately deferred.

Steps 1, 2, 3 can all land in separate PRs.

## Risks / open

- **Worker migration.** Adding `game` to existing rows is one ALTER + a backfill (`UPDATE scores SET game='rocket-ship' WHERE game IS NULL`). Trivial but it's a prod DB change. Brief read-only window if needed; D1 supports the ALTER online.
- **iframe sizing.** The hero-mock breakout in `index.html` is sized for rocket-ship dimensions. Platformer probably wants a wider aspect ratio. The fullscreen-on-mobile case is simpler — the iframe just covers the viewport. Desktop case may need a per-game aspect-ratio in the host CSS.
- **Audio thread on iOS.** Web Audio unlock happens on the first user gesture *inside the iframe*. When we copy the audio code, preserve that gesture coupling. Don't "improve" it.
- **Drift before extraction.** While step 1 duplicates code, any bug fix to cabinet code in rocket-ship needs to be re-applied to the platformer copy until step 3 happens. Keep the window short — don't let the duplication phase stretch.

## What this design does NOT cover

- A user-facing arcade picker / `arcade.oyster.to` deploy. Separate spec when ready.
- Migrating Rocket Ship onto `shared/`. Deferred indefinitely.
- A `Splash` / `GameOver` / engine abstraction. Out of scope; revisit only after two games exist and the duplication actually hurts.
- Multi-player or networked play.
- A level editor.
- Save states.
- Achievements / metagame.

Two games, shared utilities for the obvious common bits, no engine. Ship it.
