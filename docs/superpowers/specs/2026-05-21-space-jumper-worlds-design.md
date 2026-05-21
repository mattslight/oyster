# Space Jumper — Worlds 1 & 2

**Date:** 2026-05-21
**Status:** Design approved; implementation phased over four PRs.
**Affects:** `docs/arcade/space-jumper/index.html` (single-file game).

## Summary

Today Space Jumper is one level (`1-1`, a 60-tile step-ladder) and one tile look (brown blocks with a cyan top edge). Goal: turn it into a proper Mario-1-style arcade-platformer with two worlds — Earth (1-1 → 1-4) and Moon (2-1 → 2-4) — each ending in a static boss. Includes a biome tile-art overhaul so the worlds read as distinct places, not the same blocks against a different sky.

## Goals

- Eight playable stages with one clear gimmick each.
- Two distinct biomes (Earth, Moon) with their own tile palettes, variant tiles, and decorative props.
- A working level-progression engine: goal → next level → "GAME COMPLETE" after `2-4`.
- New threats: spike tile + flyer enemy.
- Moon mechanics: low gravity (all moon levels) + torch / darkness overlay (`2-3` and `2-4` only).
- Static boss scaffold landing on `1-4` and `2-4`. Mechanic deferred.

## Non-goals

- New player verbs (no crouch, no wall-jump, no dash). All new content uses the existing moveset.
- Moving platforms, falling platforms, breakable tiles, switches.
- Projectile / shockwave systems for the bosses — defer until the boss mechanic is picked.
- Sound design beyond reusing `bgm.mp3`, `bgm-moon.mp3`, and existing sfx.
- A level editor or external level files. Levels stay in the `LEVELS` array.
- Changes to other arcade games or the broader Oyster app.

## Engine extensions

### Level progression

Currently `levelComplete` shows an overlay; pressing start restarts the same level. Change: on overlay-confirm, advance `currentLevelIndex`, call `loadLevel`, reset per-level state (player position, coins, jetpacks, enemies), and swap BGM only if `level.bgm` actually changed — same track across two levels must not restart. After the last level → "GAME COMPLETE" overlay (reuse the win overlay, swap title text). Manual restart from `1-1` from there.

**What persists across levels:** score, lives, hi-score state, jetpack pickup status resets (jetpack is per-level).
**What resets per level:** player position (to `level.spawn`), coin-collected set, jetpack-taken set, enemy positions + alive flags, invuln timer, camera, BGM (when the track changes).

### Biome-aware tile renderer

`drawTile` reads `level.biome` (`'earth'` | `'moon'`) and selects a palette. Tile chars:

- `#` — canonical solid (biome-default body)
- `S` — stone variant (Earth-only)
- `C` — crater variant (moon-only)
- `^` — spike hazard

All visual variants resolve to the same solid collision:

```js
const SOLID_TILES = new Set(['#', 'S', 'C']);
const HAZARD_TILES = new Set(['^']);
```

`isSolid` checks `SOLID_TILES.has(...)`. Cosmetic chars never branch in physics logic.

### Spike tile

New `^` char. Renders as three small pixel triangles in the bottom half of the tile. Player overlap → `hurtPlayer()` (same path as enemy contact; respects invuln + lives). Spike hitbox is ~25% smaller than the sprite on every side and bottom-anchored: pixel-perfect spike contact feels unfair in a retro platformer.

### Flyer enemy

New `type: 'flyer'` on `level.enemies`. Hovers at its declared `(col, row)` with a sine-wave bob (~1 tile amplitude, ~2 s period). Doesn't walk. Stompable like a walker; reuses the squash death + scoring. Renders as a smaller alien variant with a single bottom thruster pixel pulsing.

### Boss type

When `level.type === 'boss'`:
- Skip goal-flag collision.
- Render `level.boss` (a placeholder pink alien at ~2× walker scale, idle bob).
- Boss entity `{ x, y, alive }` exists in the engine. A `hp` field is part of the data model but **no damage code lands until PR 3**, when the mechanic is picked. PR 3 defines how HP is reduced and wires `hp <= 0 → levelComplete = true`.
- Walls at cols `0` and `level.width - 1` lock the arena.

That is the entire scaffold. The actual mechanic (stomp-N, dodge-and-stomp, switch-the-room) is decided in Phase 3, before `1-4` ships. Do not build projectile / shockwave / boss-AI architecture until the mechanic is picked.

### Torch / dark overlay

When `level.hasTorch` is true, per frame:
- Draw a dark overlay (`rgba(0,0,0,0.85)`) over the viewport.
- Composite a radial light at the player's screen position (~5-tile radius, soft falloff) so the area around the player reads clearly.
- Cache only the radial-light gradient. Rebuild it only when canvas size or radius changes — not per-frame, and never as a "full-screen-cutout canvas translated by player position."
- Coins / enemies / platforms outside the lit radius become silhouettes through the overlay — not invisible.

### Decorative props

Optional `level.props` array: `{ col, row, type }`. Non-collidable, drawn between tiles and entities.

- **Earth:** `mushroom`, `bush`, `signpost`.
- **Moon:** `moonrock`, `antenna`, `dish`.

### Gravity scale

Already declared in the data model. Read per-frame in the integrator:

```js
const gravity = BASE_GRAVITY * (level.gravityScale ?? 1);
```

Never mutate a global. Moon levels declare `gravityScale: 0.55`; Earth levels omit the field (defaults to 1).

## Tile / biome / props system

### Earth biome (1-1 → 1-4)

| Tile | Char | Body | Top-edge (if exposed) | Highlight row |
|------|------|------|----------------------|---------------|
| Soil | `#` | `#3b2f1a` | grass `#22c55e` 4 px band | grass-light `#4ade80` 1 px |
| Stone | `S` | `#4a4a4a` | `#6b6b6b` 4 px band | `#9ca3af` 1 px |
| Spike | `^` | n/a | triangles `#cbd5e1` with `#475569` shadow | n/a |

The grass-green top edge (replacing today's cyan) is the single biggest visual win — instantly reads as a Mario hill instead of a ledge in space. Stone variants get scattered in pit walls and elevated cliffs to break monoblock runs.

**Earth props (sprite footprints):**

- `mushroom` — 8×9 px: red cap with 3 white spots, white stem.
- `bush` — 12×6 px: three green pixel clumps stacked.
- `signpost` — 6×8 px: brown post + yellow plaque.

### Moon biome (2-1 → 2-4)

| Tile | Char | Body | Top-edge | Highlight row |
|------|------|------|----------|---------------|
| Moon rock | `#` | `#3a3a4a` | cyan `#2dd4ff` 2 px | `#67e8f9` 1 px |
| Crater | `C` | `#3a3a4a` with hollow disc rim `#5b5b6b` | same | same |
| Spike (frozen) | `^` | n/a | triangles `#67e8f9` with `#1e3a8a` shadow | n/a |

Inner shadow is deeper (`rgba(0,0,0,0.4)`) so silhouettes still pop through the torch overlay on `2-3` and `2-4`.

**Moon props:**

- `moonrock` — 6×4 px: small grey lump with one cyan glint pixel.
- `antenna` — 3×6 px: bent upright with a blinking pink tip.
- `dish` — 8×6 px: satellite dish silhouette with cyan rim pixel.

### Backdrop per world

- **World 1:** keep the existing dusk gradient, mountains, pines, city, UFO, stars, shooting star.
- **World 2:** override the gradient (`#02020c` → `#05031c` → `#0a0625`), hide pines + mountains + city, keep moon + stars + UFO. Torch overlay (when on) dims further.

## Level identities + layouts

One gimmick per level. Spikes appear from `1-2`. Flyers appear from `1-3`. Torch on for `2-3` and `2-4` only.

| Level | Identity | Width | Notes |
|-------|----------|-------|-------|
| 1-1 | basic jumps | ~150 | walker only; jetpack is a bonus path |
| 1-2 | spikes & pits | ~180 | spikes introduced; longer gaps |
| 1-3 | flyers | ~200 | flyers introduced; final cliff is tall |
| 1-4 | boss | ~50 | locked arena, walls at edges, no flag |
| 2-1 | moon gravity | ~150 | gravity 0.55; bright moon (no torch) |
| 2-2 | moon long-jumps | ~180 | gravity 0.55; platform islands |
| 2-3 | darkness / torch | ~200 | gravity 0.55; torch on; flyer-heavy |
| 2-4 | moon boss | ~50 | gravity 0.55; torch on; locked arena |

### `1-1` Hill Top — Earth, ~150 w × 14 h

- **A (0–30) "First steps":** flat ground rows 12–13. Walker at col 18. Three floor-coins. Mushroom + bush props.
- **B (30–55) "First jump":** 3-tile pit (cols 32–34) — clearable from a standing jump. Low platform row 10 cols 38–42 with a coin above.
- **C (55–80) "Step-up":** two ascending platforms (row 11 cols 58–62, row 10 cols 66–70). Walker on the upper one. Stone-variant `S` tiles on the cliff face. Three-coin pile.
- **D (80–105) "Jetpack bonus":** jetpack pickup floating row 5 col 92 — visible from below, optional shortcut. Two short 2-tile pits at floor level (clearable without jetpack). Reward row of 3 floating coins at row 6 — only collectible via the high route.
- **E (105–135) "Final climb":** step-ladder rows 11 → 7, four platforms, coin above each, walker on top.
- **F (135–150) "Goal":** row-5 platform, flag at col 145, bush prop.

Every pit clearable without the jetpack. No spikes, no flyers, no duck-through.

### `1-2` Sunset Valley — Earth, ~180 w

- Identity: spikes & pits introduced.
- Sky tones warm slightly (no engine change needed; existing gradient covers it).
- ~3 walkers, ~2 spike pits, ~1 long pit (still clearable from running jump).
- "Hop-island" middle: five short platforms with 1-tile gaps between.
- Jetpack appears late (~col 135) — most of the level is platforming-only.
- Signpost prop mid-level.

### `1-3` Hilltop Trail — Earth, ~200 w

- Identity: flyer enemy introduced.
- 3 flyers hovering over elevated gaps. 1 walker. 2 spike pits.
- Stone-variant cliffs throughout.
- Goal sits on a tall cliff at row 4 — jetpack helpful but not required.

### `1-4` Boss Arena — Earth, ~50 w × 14 h

- No goal flag. Boss centred on a 4-wide pedestal at col 25 row 9.
- Two side platforms at row 9 cols 8–12 and 38–42 for approaching the boss.
- Walls at cols 0 and 49.
- Boss mechanic **TBD** — Phase 3 decides.

### `2-1` Moon Landing — Moon, ~150 w

- Identity: moon gravity introduced. Torch off.
- 2 walkers, 1 spike pit, 1 jetpack pickup.
- Crater-variant tiles in cliffs.
- Antenna props scattered (~1 per 30 cols).

### `2-2` Crater Basin — Moon, ~180 w

- Identity: long-jumps. Big pits with platform islands.
- 3 walkers, 2 flyers, 2 spike pits, 1 jetpack pickup.
- Dish prop on a high cliff (cosmetic landmark).

### `2-3` Dark Side — Moon, ~200 w

- Identity: torch / darkness. `hasTorch: true`.
- 4 flyers (the moon's signature threat at this stage), 1 walker, 2 spike pits.
- Final cliff is tall; the jetpack route is strongly encouraged but a non-jetpack path through tighter platforming must exist. Mandatory power-up dependency is a footgun if the player misses the pickup in low-vis conditions.

### `2-4` Moon Boss Arena — Moon, ~50 w

- Palette- and gravity-swap of `1-4`. `hasTorch: true`.
- Same arena shape; same TBD boss mechanic with harder tuning (more HP, faster recovery).
- Defeat → "GAME COMPLETE" overlay.

## Phasing / shipping plan

Vertical-slice-driven: PR 1 ships a polished `1-1` on the new tile system before any other content lands. If the tile feel is wrong we tune before doubling down on it.

| PR | Scope | What ships |
|----|-------|-----------|
| **1** | Level progression + biome plumbing + Earth tile renderer (`#`, `S`) + Earth props + redesigned `1-1` | Tile-art win + new 1-1 visible. With only one level so far, reaching the goal fires the new "GAME COMPLETE" overlay — same code path that fires after `2-4` once the rest lands. |
| **2** | Spike tile (`^`) + flyer enemy + `1-2` + `1-3` | Earth content complete except boss. |
| **3** | Boss scaffold + boss mechanic (pick + implement) + `1-4` | World 1 done. |
| **4** | Moon gravity + moon tile renderer (`C` + moon palette) + moon props + torch overlay + `2-1`–`2-4` | Game complete. |

Each PR is a separate branch off `main`, worktree at `~/Dev/oyster.worktrees/<branch>` per repo convention. No CHANGELOG entries (arcade work is out of scope for the consumer changelog per project convention).

## Open questions

1. **Boss mechanic** — TBD before PR 3. Options on the table: stomp-N-times (simplest, reuses squash), dodge-and-stomp (needs a projectile / shockwave system), switch-the-room (pure platforming puzzle, no combat code).
2. **Score tuning** — does coin / stomp / level-clear point value scale across worlds? Default: keep current values, tune only if hi-score curve feels flat after PR 4.
3. **Torch radius on 2-3 vs 2-4** — same radius, or tighter on 2-4 for boss tension? Default: same; revisit if 2-4 reads as too easy.

## Out of scope

- New player verbs.
- Moving / falling / breakable platforms.
- Boss combat systems beyond the static-HP scaffold.
- Level editor / external level files.
- Audio additions beyond existing tracks.
- Other arcade games.
