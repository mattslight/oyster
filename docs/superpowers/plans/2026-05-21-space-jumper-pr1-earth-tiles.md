# Space Jumper PR 1 — Earth Tiles + Level Progression + Redesigned 1-1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a polished, ~150-tile-wide `1-1` on the new biome tile system, with level-progression machinery ready for future levels — vertical-slice for the worlds-1-and-2 spec.

**Architecture:** All changes touch `docs/arcade/space-jumper/index.html` only. Introduce `level.biome`, refactor `drawTile` to be biome-aware with palette objects, add stone variant `S`, add a `level.props` array + non-collidable prop renderer, wire level-progression so `levelComplete` advances `currentLevelIndex` (and fires "GAME COMPLETE" on the last level), and replace the existing 1-1 with the redesigned zones.

**Tech Stack:** Vanilla JS / Canvas 2D / pixel-art arcade game. No build step, no test framework — verification is manual in browser.

**Spec:** [`docs/superpowers/specs/2026-05-21-space-jumper-worlds-design.md`](../specs/2026-05-21-space-jumper-worlds-design.md)

**Branch:** `arcade/space-jumper-pr1-earth-tiles` (worktree at `~/Dev/oyster.worktrees/arcade-space-jumper-pr1-earth-tiles`).

**How to run locally during verification:**
```bash
cd ~/Dev/oyster-dev   # or your worktree path
npm run dev           # serves the site, including /arcade/space-jumper/
```
Then open `http://localhost:7337/arcade/space-jumper/` in a browser. Hard-reload with ⌘⇧R after each change.

---

## File structure

Everything is in `docs/arcade/space-jumper/index.html`. The relevant existing sections (with current line numbers from the spec exploration):

- `LEVELS` array — around lines 714–760
- `loadLevel`, `tileAt`, `isSolid` — around lines 763–786
- `drawTile` — around lines 1266–1285
- `draw()` main loop — around lines 1734+
- Goal collision check (sets `levelComplete = true`) — around lines 1239–1252

Line numbers will shift as edits land. Use a fresh `grep -n` to confirm before each edit.

---

### Task 1: Add `biome: 'earth'` field to the current 1-1 (data only)

**Goal:** lock the biome name into the data model. No behavior change.

**Files:**
- Modify: `docs/arcade/space-jumper/index.html` — the `LEVELS` array entry for 1-1.

- [ ] **Step 1: Add the field**

Find the existing 1-1 entry (`id: '1-1', world: 1, stage: 1, type: 'platformer',` etc.) and add `biome: 'earth',` directly after the `type:` field.

Replace:
```js
    id: '1-1', world: 1, stage: 1, type: 'platformer',
    width: 60, height: 14,
```
With:
```js
    id: '1-1', world: 1, stage: 1, type: 'platformer',
    biome: 'earth',
    width: 60, height: 14,
```

- [ ] **Step 2: Verify**

Hard-reload the page. Confirm 1-1 loads as before — character spawns, walkers patrol, jetpack pickup visible, goal flag at the end. No visual change at all.

- [ ] **Step 3: Commit**

```bash
git add docs/arcade/space-jumper/index.html
git commit -m "feat(arcade): add biome field to space-jumper level data model"
```

---

### Task 2: Introduce `SOLID_TILES` + `HAZARD_TILES` sets; refactor `isSolid`

**Goal:** make tile collision data-driven so visual variants never branch in physics. No behavior change yet (only `#` is in use).

**Files:**
- Modify: `docs/arcade/space-jumper/index.html` — `tileAt` / `isSolid` block (around lines 778–786).

- [ ] **Step 1: Add the tile-class sets**

Insert these two `const`s directly above the `function tileAt(col, row) {` line:

```js
// Tile classes — visual variants resolve to the same physical class.
// Renderer reads the char itself; physics only reads class membership.
const SOLID_TILES  = new Set(['#', 'S', 'C']);
const HAZARD_TILES = new Set(['^']);
```

- [ ] **Step 2: Refactor `isSolid` to consult the set**

Replace:
```js
function isSolid(col, row) { return tileAt(col, row) === '#'; }
```
With:
```js
function isSolid(col, row) { return SOLID_TILES.has(tileAt(col, row)); }
```

- [ ] **Step 3: Verify**

Hard-reload. Play through 1-1: ground feels solid, platforms feel solid, goal reachable, walker AI works. The `S` and `C` characters aren't used yet so behavior is unchanged.

- [ ] **Step 4: Commit**

```bash
git add docs/arcade/space-jumper/index.html
git commit -m "refactor(arcade): data-drive tile collision via SOLID_TILES set"
```

---

### Task 3: Make `drawTile` biome-aware

**Goal:** drive tile colours from the level's `biome` field. No visual change yet for 1-1 (Earth palette ≈ current colours with grass-green replacing today's cyan top edge).

**Files:**
- Modify: `docs/arcade/space-jumper/index.html` — `drawTile` function (around lines 1266–1285).

- [ ] **Step 1: Introduce the biome palette table**

Insert directly above `function drawTile(col, row) {`:

```js
// Per-biome tile palettes. Keys map char → { body, topEdge, highlight, innerShadow }.
// `topEdge` only paints when no tile is above (open sky). `highlight` is a 1-px
// row directly below the top edge for that pixel-y readability.
const TILE_PALETTE = {
  earth: {
    '#': { body: '#3b2f1a', topEdge: '#22c55e', highlight: '#4ade80', innerShadow: 'rgba(0,0,0,0.25)' },
    'S': { body: '#4a4a4a', topEdge: '#6b6b6b', highlight: '#9ca3af', innerShadow: 'rgba(0,0,0,0.25)' },
  },
};
```

(Moon palette will be added in PR 4. Keeping the table small now.)

- [ ] **Step 2: Rewrite `drawTile` to use the palette**

Replace the entire existing `drawTile` function body with:

```js
function drawTile(col, row) {
  const x = Math.round(col * TILE_PX - cam.x);
  const y = Math.round(row * TILE_PX);
  if (x + TILE_PX < 0 || x > W) return;

  const ch      = tileAt(col, row);
  const palette = TILE_PALETTE[level.biome] || TILE_PALETTE.earth;
  const style   = palette[ch] || palette['#'];

  // Body
  ctx.fillStyle = style.body;
  ctx.fillRect(x, y, TILE_PX, TILE_PX);

  // Top edge + highlight pixel row — only when the tile above is open sky.
  if (!isSolid(col, row - 1)) {
    ctx.fillStyle = style.topEdge;
    ctx.fillRect(x, y, TILE_PX, Math.max(4, Math.floor(TILE_PX * 0.18)));
    ctx.fillStyle = style.highlight;
    ctx.fillRect(x, y, TILE_PX, 1);
  }

  // Inner shadow — bottom-right edges for chunky pixel readability.
  ctx.fillStyle = style.innerShadow;
  ctx.fillRect(x + TILE_PX - 2, y, 2, TILE_PX);
  ctx.fillRect(x, y + TILE_PX - 2, TILE_PX, 2);
}
```

- [ ] **Step 3: Verify**

Hard-reload. Floor and platforms now have a green top edge instead of cyan. Bodies still brown. Inner shadow unchanged. Walk on the floor — green stripe along the top reads as grass. (If the green looks too bright in dusk, that's expected — tune in Task 10 if needed.)

- [ ] **Step 4: Commit**

```bash
git add docs/arcade/space-jumper/index.html
git commit -m "feat(arcade): biome-aware tile renderer for space-jumper"
```

---

### Task 4: Render `S` stone-variant tiles

**Goal:** When a level uses `S` in its tile strings, it draws as grey stone. Since 1-1 still uses only `#`, this task lands the rendering branch without any visible change yet.

**Files:**
- Modify: `docs/arcade/space-jumper/index.html` — none beyond what Task 3 already did. The palette table from Task 3 already includes the `S` entry, and `drawTile` already looks up by char.

- [ ] **Step 1: Sanity-check by temporarily injecting an `S` tile**

In the 1-1 entry, **temporarily** replace one tile to test:

Find row index 12 of 1-1 (`'############################################################',` — the bottom-most floor row) and change the first `#` to `S`. (Don't keep this — it's a smoke test.)

- [ ] **Step 2: Verify visually**

Hard-reload, run the game. The leftmost floor tile should now be grey with a lighter-grey top edge. The rest stay brown with green tops. Walk on it — should feel solid (collision is class-based, not char-based).

- [ ] **Step 3: Revert the smoke-test edit**

Change the `S` back to `#`. Confirm reload returns to all-brown floor.

- [ ] **Step 4: Commit**

No code change to commit from this task — it was a verification of Task 3. Skip the commit.

---

### Task 5: Add `level.props` array + `drawProps()` placeholder

**Goal:** Engine has a non-collidable decoration layer. No props in any level yet, so no visual change.

**Files:**
- Modify: `docs/arcade/space-jumper/index.html` — the `LEVELS` 1-1 entry, and the `draw()` main loop.

- [ ] **Step 1: Add an empty `props: []` field to the 1-1 entry**

Find the closing block of 1-1 (just before `bgm: 'bgm.mp3?v=2',`) and add:

```js
    props: [],
```

So that section becomes:
```js
    jetpacks: [
      { col: 21, row: 11 },
    ],
    props: [],
    bgm: 'bgm.mp3?v=2',
```

- [ ] **Step 2: Add the `drawProps()` function**

Insert above `function drawTile(col, row) {`:

```js
// Decorative props — non-collidable. Drawn between tiles and entities so they
// sit "in front of" the world but behind enemies/player. Sprite dispatch by type.
function drawProps() {
  if (!level.props || level.props.length === 0) return;
  for (let i = 0; i < level.props.length; i++) {
    const p = level.props[i];
    drawProp(p, p.col * TILE_PX, p.row * TILE_PX);
  }
}

function drawProp(p, worldX, worldY) {
  const x = Math.round(worldX - cam.x);
  const y = Math.round(worldY);
  if (x + TILE_PX < 0 || x > W) return;
  // Sprite implementations land in Task 6.
}
```

- [ ] **Step 3: Wire `drawProps()` into the main loop**

In `draw()`, immediately after the tile-drawing nested loop (the block ending `if (isSolid(col, row)) drawTile(col, row);`), insert:

```js
  // Decorative props — between tiles and entities.
  drawProps();
```

- [ ] **Step 4: Verify**

Hard-reload. Nothing visible changes — `level.props` is empty.

- [ ] **Step 5: Commit**

```bash
git add docs/arcade/space-jumper/index.html
git commit -m "feat(arcade): scaffold props layer for space-jumper levels"
```

---

### Task 6: Implement Earth prop sprites — mushroom, bush, signpost

**Goal:** `drawProp` dispatches by `type` and renders the three Earth props. Verified by temporarily adding one of each to 1-1.

**Files:**
- Modify: `docs/arcade/space-jumper/index.html` — `drawProp` function from Task 5.

- [ ] **Step 1: Replace `drawProp` with the dispatch + sprite implementations**

Replace the empty `drawProp` body with:

```js
function drawProp(p, worldX, worldY) {
  const x = Math.round(worldX - cam.x);
  const y = Math.round(worldY);
  if (x + TILE_PX < 0 || x > W) return;
  // Pixel size scales with the tile so props stay proportional on resize.
  const PXL = Math.max(2, Math.round(TILE_PX / 14));
  switch (p.type) {
    case 'mushroom': return drawMushroom(x, y, PXL);
    case 'bush':     return drawBush(x, y, PXL);
    case 'signpost': return drawSignpost(x, y, PXL);
  }
}

// Earth props — anchored so the BOTTOM of the sprite sits at (x, y + TILE_PX),
// matching the convention that prop.row places the prop on top of that row.

function drawMushroom(x, y, PXL) {
  // 8-wide × 9-tall pixel grid (in PXL units).
  const baseY = y + TILE_PX;
  // Stem (white) — 2 wide × 3 tall, centered.
  ctx.fillStyle = '#f5f5f5';
  ctx.fillRect(x + 3 * PXL, baseY - 3 * PXL, 2 * PXL, 3 * PXL);
  // Cap (red) — 8 wide × 5 tall, sits on the stem.
  ctx.fillStyle = '#ef4444';
  ctx.fillRect(x,             baseY - 8 * PXL, 8 * PXL, 5 * PXL);
  // Cap top-edge (lighter red) — 1px highlight row.
  ctx.fillStyle = '#fca5a5';
  ctx.fillRect(x,             baseY - 8 * PXL, 8 * PXL, PXL);
  // Three white spots on the cap.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x + 1 * PXL, baseY - 7 * PXL, PXL, PXL);
  ctx.fillRect(x + 4 * PXL, baseY - 7 * PXL, PXL, PXL);
  ctx.fillRect(x + 6 * PXL, baseY - 6 * PXL, PXL, PXL);
}

function drawBush(x, y, PXL) {
  // 12-wide × 6-tall. Three pixel clumps stacked.
  const baseY = y + TILE_PX;
  ctx.fillStyle = '#15803d';            // shaded body
  ctx.fillRect(x,             baseY - 3 * PXL, 12 * PXL, 3 * PXL);
  ctx.fillStyle = '#22c55e';            // lit top
  ctx.fillRect(x + 1 * PXL,   baseY - 5 * PXL, 4 * PXL, 2 * PXL);
  ctx.fillRect(x + 5 * PXL,   baseY - 6 * PXL, 4 * PXL, 3 * PXL);
  ctx.fillRect(x + 9 * PXL,   baseY - 5 * PXL, 3 * PXL, 2 * PXL);
  ctx.fillStyle = '#4ade80';            // 1-px highlight on the tallest clump
  ctx.fillRect(x + 5 * PXL,   baseY - 6 * PXL, 4 * PXL, PXL);
}

function drawSignpost(x, y, PXL) {
  // 6-wide × 8-tall — brown post + yellow plaque pointing right.
  const baseY = y + TILE_PX;
  // Post.
  ctx.fillStyle = '#5a3a1a';
  ctx.fillRect(x + 2 * PXL,   baseY - 8 * PXL, 2 * PXL, 8 * PXL);
  // Plaque.
  ctx.fillStyle = '#ffd84a';
  ctx.fillRect(x + 1 * PXL,   baseY - 7 * PXL, 5 * PXL, 3 * PXL);
  // Plaque shadow row.
  ctx.fillStyle = '#c79b00';
  ctx.fillRect(x + 1 * PXL,   baseY - 5 * PXL, 5 * PXL, PXL);
}
```

- [ ] **Step 2: Smoke-test by injecting one of each into 1-1**

Temporarily set 1-1's `props:` field to:

```js
    props: [
      { col:  5, row: 11, type: 'bush' },
      { col: 10, row: 11, type: 'mushroom' },
      { col: 15, row: 11, type: 'signpost' },
    ],
```

- [ ] **Step 3: Verify visually**

Hard-reload. Walk along the start of 1-1. Bush, mushroom, signpost should appear on the floor in that order. Each should sit visually ON the floor (its bottom edge touches the green grass top). Player should walk THROUGH them (non-collidable).

- [ ] **Step 4: Revert the smoke-test props**

Set `props: []` back to empty. Confirm props disappear on reload. (Final props for 1-1 land with the level redesign in Task 9.)

- [ ] **Step 5: Commit**

```bash
git add docs/arcade/space-jumper/index.html
git commit -m "feat(arcade): earth prop sprites — mushroom, bush, signpost"
```

---

### Task 7: Level progression — advance on goal, "GAME COMPLETE" on last level

**Goal:** Reaching the goal flag advances `currentLevelIndex` and resets per-level state. On the last level, fire a "GAME COMPLETE" overlay (reuse the win overlay, swap title). Score + lives persist; per-level state (player position, coins, jetpacks, enemies, invuln, camera) resets.

**Files:**
- Modify: `docs/arcade/space-jumper/index.html` — goal collision block (around lines 1239–1252), `showEndOverlay` (around lines 567–588), restart/start handlers, and a new helper `advanceLevel()`.

- [ ] **Step 1: Add the `advanceLevel()` helper**

Insert near `loadLevel(idx)` (in the LEVELS block). The helper handles index increment, per-level reset, and BGM swap (only when track changed).

```js
// Advance to the next level. Resets per-level state but preserves score, lives,
// and hi-score state. Returns true if a new level was loaded, false if we just
// completed the final level (caller should show "GAME COMPLETE").
function advanceLevel() {
  if (currentLevelIndex >= LEVELS.length - 1) return false;

  const prevBgm = level.bgm;
  loadLevel(currentLevelIndex + 1);

  // Per-level state resets.
  player.x = level.spawn.col * TILE_PX + (TILE_PX - PLAYER_W) / 2;
  player.y = level.spawn.row * TILE_PX - PLAYER_H;
  player.vx = 0; player.vy = 0;
  player.grounded = false;
  player.lastGroundedAt = -Infinity;
  player.jumpPressedAt = -Infinity;
  player.jumpHeld = false;
  player.invulnAt = -Infinity;
  player.hasJetpack = false;
  player.fuel = 0;
  player.thrusting = false;
  coinsCollected.clear();
  jetpacksTaken.clear();
  cam.x = 0;
  initEnemies();
  levelComplete = false;
  levelCompleteAt = 0;

  // BGM swap only when the track actually changed — back-to-back same-track
  // levels must NOT restart audio.
  if (level.bgm !== prevBgm) {
    const bgmEl = document.getElementById('bgm');
    if (bgmEl && bgmEl.dataset.src !== level.bgm) {
      bgmEl.dataset.src = level.bgm;
      bgmEl.src = level.bgm;
      bgmEl.play().catch(() => {});
    }
  }
  return true;
}
```

- [ ] **Step 2: Add a `gameComplete` flag and `showEndOverlay` variant**

Near the run-level state block (around lines 855–870 — search for `let levelComplete = false;`), add:

```js
let gameComplete = false;
let gameCompleteAt = 0;
```

In `showEndOverlay`, change the title selection so a third state ("GAME COMPLETE") is supported. Replace:

```js
  titleEl.textContent = win ? 'LEVEL COMPLETE' : 'GAME OVER';
  titleEl.classList.toggle('is-win', !!win);
  titleEl.classList.toggle('is-loss', !win);
```

With:

```js
  titleEl.textContent = gameComplete ? 'GAME COMPLETE' : (win ? 'LEVEL COMPLETE' : 'GAME OVER');
  titleEl.classList.toggle('is-win', !!win);
  titleEl.classList.toggle('is-loss', !win);
```

- [ ] **Step 3: Hook level-progression into the goal-flag collision**

Find the goal collision block (currently sets `levelComplete = true;` and shows the overlay). Replace it with:

```js
  // Goal flag — collision box covers the pole + flag (2 tiles tall, anchored
  // at the goal column on row 5 = top of the last platform).
  {
    const g = level.goal;
    const gx = g.col * TILE_PX;
    const gy = (g.row - 2) * TILE_PX;
    const gw = TILE_PX * 0.8;
    const gh = TILE_PX * 2;
    if (aabbOverlap(player.x, player.y, PLAYER_W, PLAYER_H, gx, gy, gw, gh)) {
      const isLast = currentLevelIndex >= LEVELS.length - 1;
      if (isLast) {
        gameComplete   = true;
        gameCompleteAt = now;
        levelComplete  = true;          // shares the grace + restart flow
        levelCompleteAt = now;
        pauseBgm();
        playWin();
        showEndOverlay({ win: true });
      } else {
        score += 100;                    // small clear bonus, preserves momentum
        playWin();
        advanceLevel();
        // No overlay between levels — straight into the next stage.
      }
    }
  }
```

- [ ] **Step 4: Reset `gameComplete` in the restart flow**

Find `startGame()` (around line 891 — search for `function startGame()`). In its reset block (where `levelComplete = false; levelCompleteAt = 0;` already lives), add right after them:

```js
  gameComplete = false; gameCompleteAt = 0;
  currentLevelIndex = 0;
  loadLevel(0);
```

(The explicit `loadLevel(0)` ensures restart-from-game-complete reloads level 1 cleanly.)

- [ ] **Step 5: Verify single-level case still works**

Hard-reload. Play through 1-1 to the goal flag. Because PR 1 only has one level (`LEVELS.length === 1`), the goal should fire the "GAME COMPLETE" overlay (not "LEVEL COMPLETE"). Press start → restart from the beginning.

- [ ] **Step 6: Verify multi-level progression (temporary smoke test)**

To verify mid-game advancement works, temporarily duplicate the 1-1 entry in `LEVELS`. Add a second copy with `id: '1-1b'`. Reload. Reach the goal — the screen should immediately transition to the duplicate level (player respawns at spawn, coins/enemies reset, no overlay between them). Reach the second goal — "GAME COMPLETE" appears.

- [ ] **Step 7: Revert the smoke-test duplicate**

Remove the duplicated `LEVELS` entry so `LEVELS` again contains only `1-1`.

- [ ] **Step 8: Commit**

```bash
git add docs/arcade/space-jumper/index.html
git commit -m "feat(arcade): level progression + GAME COMPLETE overlay"
```

---

### Task 8: BGM-only-restart-when-changed safeguard in `loadLevel`

**Goal:** `loadLevel` already guards against same-src reloads via `bgmEl.dataset.src` (see existing comment at line 769). `advanceLevel` from Task 7 also guards. Add explicit comments confirming the invariant. (No functional change — this task locks the convention in writing.)

**Files:**
- Modify: `docs/arcade/space-jumper/index.html` — `loadLevel` BGM block (around lines 768–775).

- [ ] **Step 1: Update the existing comment**

Replace the existing BGM swap block in `loadLevel`:

```js
  // Swap the BGM track to whatever the level declares. Guarded so a first
  // load before the <audio> element is parsed (script-init order) just no-ops
  // — the inline src in HTML serves the same file for 1-1 in that window.
  const bgmEl = document.getElementById('bgm');
  if (bgmEl && level.bgm && bgmEl.dataset.src !== level.bgm) {
    bgmEl.dataset.src = level.bgm;
    bgmEl.src = level.bgm;
  }
```

With (only the comment changes; logic stays):

```js
  // Swap the BGM track ONLY when it differs from what's currently loaded.
  // Same-track levels (e.g. 1-1 → 1-2) must NOT restart audio. The dataset.src
  // guard makes this idempotent across loadLevel() and advanceLevel() calls.
  // (Also no-ops on first load before the <audio> element is parsed.)
  const bgmEl = document.getElementById('bgm');
  if (bgmEl && level.bgm && bgmEl.dataset.src !== level.bgm) {
    bgmEl.dataset.src = level.bgm;
    bgmEl.src = level.bgm;
  }
```

- [ ] **Step 2: Verify**

No functional change. Hard-reload. Game starts as before. (This is a comment-only edit.)

- [ ] **Step 3: Commit**

```bash
git add docs/arcade/space-jumper/index.html
git commit -m "docs(arcade): clarify same-track BGM swap invariant"
```

---

### Task 9: Replace 1-1 with the redesigned ~150-wide layout

**Goal:** Land the redesigned 1-1 per the spec — flat intro, first jump, step-up, jetpack bonus path, final climb, goal. Earth biome, mushroom + bush props, stone-variant tiles on the Zone-C cliff.

**Files:**
- Modify: `docs/arcade/space-jumper/index.html` — the entire 1-1 entry in the `LEVELS` array.

**Coordinate map (cols left-to-right, rows top-down 0–13):**

| Zone | Cols | Content |
|------|------|---------|
| A | 0–30 | Flat ground, walker at col 18, 3 floor coins, mushroom + bush props |
| B | 30–55 | 3-tile floor pit at cols 32–34, low platform row 10 cols 38–42, coin row 9 col 40 |
| C | 55–80 | Row 11 platform cols 58–62, row 10 stone platform cols 66–70, walker on top, 3 coins row 9 cols 60/64/68 |
| D | 80–105 | Stepping-stone row 11 cols 82–85, row 9 platform cols 90–94, jetpack pickup row 8 col 92, two floor pits cols 86–87 + cols 97–98, bonus coins row 4 cols 89/92/95 |
| E | 105–135 | Step-ladder: row 11 cols 108–111, row 9 cols 114–117, row 7 cols 121–124, row 5 cols 128–131; coin above each (rows 10/8/6/4 at cols 109/115/122/129); walker on row 5 platform |
| F | 135–150 | Goal platform row 5 cols 138–148, goal flag col 145 row 5, bush prop col 142 row 5 |

- [ ] **Step 1: Replace the 1-1 `LEVELS` entry**

Replace the existing 1-1 entry (the whole block from `id: '1-1', world: 1...` through its closing `},`) with:

```js
  // 1-1 — "Hill Top". 150-wide Earth intro stage. Identity: basic jumps only.
  // No spikes (introduced 1-2), no flyers (introduced 1-3). Jetpack is a bonus
  // shortcut that grants access to 3 row-4 coins; every pit is also clearable
  // from a running jump.
  {
    id: '1-1', world: 1, stage: 1, type: 'platformer',
    biome: 'earth',
    width: 150, height: 14,
    spawn: { col: 2, row: 12 },
    // Tile-row layouts (each row is exactly 150 chars):
    //  row 0–4   : sky (all dots)
    //  row 5     : Zone E top platform cols 128–131; Zone F goal platform cols 138–148
    //  row 6     : empty
    //  row 7     : Zone E platform cols 121–124
    //  row 8     : empty (jetpack pickup at col 92 is an entity, not a tile)
    //  row 9     : Zone D high platform cols 90–94; Zone E platform cols 114–117
    //  row 10    : Zone B low platform cols 38–42 (####); Zone C stone platform cols 66–70 (SSSSS)
    //  row 11    : Zone C platform cols 58–62; Zone D stepping-stone cols 82–85; Zone E platform cols 108–111
    //  row 12–13 : floor — solid except Zone B pit cols 32–34 and Zone D pits cols 86–87 + cols 97–98
    tiles: [
      '......................................................................................................................................................',
      '......................................................................................................................................................',
      '......................................................................................................................................................',
      '......................................................................................................................................................',
      '......................................................................................................................................................',
      '................................................................................................................................####......###########.',
      '......................................................................................................................................................',
      '.........................................................................................................................####.........................',
      '......................................................................................................................................................',
      '..........................................................................................#####...................####................................',
      '......................................#####.......................SSSSS...............................................................................',
      '..........................................................#####...................####......................####......................................',
      '################################...###################################################..#########..###################################################',
      '################################...###################################################..#########..###################################################',
    ],
    coins: [
      // Zone A — floor walk
      { col:  8, row: 11 },
      { col: 14, row: 11 },
      { col: 20, row: 11 },
      // Zone B — above low platform
      { col: 40, row:  9 },
      // Zone C — step-up coin trail
      { col: 60, row:  9 },
      { col: 64, row:  9 },
      { col: 68, row:  9 },
      // Zone D — bonus row (only reachable with jetpack thrust)
      { col: 89, row:  4 },
      { col: 92, row:  4 },
      { col: 95, row:  4 },
      // Zone E — above each climb platform
      { col: 109, row: 10 },
      { col: 115, row:  8 },
      { col: 122, row:  6 },
      { col: 129, row:  4 },
    ],
    goal: { col: 145, row: 5 },
    enemies: [
      { col: 18, row: 12, type: 'walker' },   // Zone A floor
      { col: 68, row: 10, type: 'walker' },   // Zone C upper stone platform
      { col: 130, row: 5, type: 'walker' },   // Zone E top platform
    ],
    jetpacks: [
      { col: 92, row: 8 },                    // Zone D — visible from below
    ],
    props: [
      { col:  5, row: 12, type: 'bush'     }, // Zone A
      { col: 22, row: 12, type: 'mushroom' }, // Zone A
      { col: 142, row: 5, type: 'bush'     }, // Zone F (sits on goal platform)
    ],
    bgm: 'bgm.mp3?v=2',
    gravityScale: 1,
    hasTorch: false,
    boss: null,
  },
```

> ⚠️ **Important:** the tile strings above are exact-length 150-char lines. The block above contains 14 rows. If your editor wraps lines, paste from a source that preserves line lengths; alternatively, the executor should run a quick sanity check (Step 2).

- [ ] **Step 2: Sanity-check tile-string widths**

Run this Bash check from the repo root to confirm every row is exactly 150 chars:

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('docs/arcade/space-jumper/index.html', 'utf8');
const m = html.match(/id: '1-1'[\s\S]*?tiles: \[([\s\S]*?)\],/);
if (!m) { console.error('1-1 tiles block not found'); process.exit(1); }
const lines = m[1].match(/'[^']*'/g);
console.log('rows:', lines.length);
lines.forEach((l, i) => {
  const inner = l.slice(1, -1);
  console.log(i, inner.length, inner.length === 150 ? 'OK' : 'MISMATCH');
});
"
```

Expected output: 14 rows, each `150 OK`. If any row reports `MISMATCH`, the paste lost or gained characters — re-paste that row from the plan.

- [ ] **Step 3: Verify chain-jumpability in the browser**

Hard-reload. Play through 1-1. Confirm each beat:

| Check | Expected |
|-------|----------|
| Spawn (col 2, row 12) | Player appears on the floor at the left edge |
| Zone A floor coins | 3 coins visible at cols 8/14/20, all collectible by walking |
| Zone A walker (col 18) | Walker patrols on the floor; you can stomp or run past |
| Zone A bush + mushroom | Visible as background props at cols 5 and 22; walk through them |
| Zone B 3-tile pit (cols 32–34) | Falling in loses a life. Clearable from a running jump. |
| Zone B low platform | Reachable by jumping from the floor on the right side of the pit |
| Zone C row-11 platform | Chain-jump from row-10 platform reaches it |
| Zone C row-10 STONE platform | Grey-tile platform with grey top edge; walker patrols it |
| Zone D high platform (row 9, cols 90–94) | Reachable by jumping from the row-11 stepping stone (cols 82–85) |
| Zone D jetpack (col 92, row 8) | Pick it up by landing on the high platform |
| Zone D row-4 bonus coins | After grabbing jetpack, thrust up to collect 3 coins at row 4 |
| Zone D floor pits (cols 86–87, 97–98) | Each clearable from a running jump (no jetpack needed) |
| Zone E step-ladder | Each platform reachable from the one below |
| Zone E top walker (row 5) | Walker patrols at the top |
| Zone F goal flag | Walking into the flag at col 145 fires "GAME COMPLETE" (only level so far) |

- [ ] **Step 4: Tune if any chain-jump is unreachable**

If any platform is unreachable from a standard jump (peak ≈ 2.7 tiles per the existing physics comment), adjust the row of the offending platform by 1 in the tile strings — typically by moving the next platform 1 row down so the gap closes. Re-verify after each tweak.

Common gotcha: row 5 platforms are at the very edge of jump capability. If the row-5 final-climb platform (cols 128–131) feels impossible from the row-7 platform (cols 121–124), lower the final platform to row 6 (and shift its coin from row 4 to row 5). Same for the goal platform — drop to row 6 if needed.

- [ ] **Step 5: Commit**

```bash
git add docs/arcade/space-jumper/index.html
git commit -m "feat(arcade): redesigned 1-1 — 150-wide Hill Top stage"
```

---

### Task 10: End-to-end smoke + final commit

**Goal:** One full top-to-bottom playthrough verifying nothing in PR 1 broke existing functionality, plus a clean PR push.

**Files:**
- None modified — verification + push only.

- [ ] **Step 1: Full playthrough on desktop browser**

Hard-reload. Play 1-1 start to finish without dying. Confirm:

- Splash screen renders, sound toggle works
- Pressing Space starts the game; player spawns at col 2 row 12
- Walking, jumping, jetpack burn, stomp, coin pickup, score increment all work
- Floor-edge fall = lose a life
- After "GAME COMPLETE", pressing Space restarts from `1-1` cleanly

- [ ] **Step 2: Mobile touch-controls playthrough**

Open Chrome DevTools, toggle device-mode (iPhone or similar). Hard-reload. Confirm touch buttons appear and work — ◀ ▶ JUMP all respond. Play through 1-1 once on touch.

- [ ] **Step 3: Visual regression check**

Compare the new 1-1 against the original screenshot in the spec brainstorm. Confirm:

- Floor and platforms have a **green** top edge (not cyan) — grass-on-soil reads
- Stone platform in Zone C is visibly grey, distinct from the brown soil
- Props (mushroom, bush) sit on the floor at the start; bush sits next to the goal flag
- Background (mountains, pines, UFO, stars) unchanged — no regressions

- [ ] **Step 4: Push and open PR**

```bash
git push -u origin arcade/space-jumper-pr1-earth-tiles
gh pr create --title "arcade/space-jumper: PR 1 — earth tiles + level progression + redesigned 1-1" --body "$(cat <<'EOF'
## Summary
- Adds biome-aware tile renderer (Earth palette: grass-green top edge, soil + stone variants)
- Adds non-collidable props layer with Earth sprites (mushroom, bush, signpost)
- Adds level-progression engine (goal → next level; last → GAME COMPLETE) with score+lives persisting across levels
- Replaces 1-1 with a ~150-wide "Hill Top" stage: flat intro, first jump, step-up, jetpack bonus path, final climb, goal

Phase 1 of the worlds-1-and-2 spec at `docs/superpowers/specs/2026-05-21-space-jumper-worlds-design.md`.

## Test plan
- [ ] Desktop playthrough of 1-1 start to finish, golden path
- [ ] Mobile (Chrome DevTools touch) playthrough of 1-1
- [ ] Verify GAME COMPLETE fires on the only level so far; restart-from-overlay loads 1-1 cleanly
- [ ] No CHANGELOG entry — arcade work is out of scope for the consumer changelog per repo convention

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Final commit (none needed)**

Task 10 is verification + push only. If any tuning was committed in Task 9 Step 4, that's already pushed.

---

## What's deferred to later PRs

| PR 2 | spike tile `^`, flyer enemy, `1-2`, `1-3` |
| PR 3 | boss scaffold (boss-type routing + arena walls + HP wiring once mechanic picked), `1-4` |
| PR 4 | moon biome palette + `C` crater variant + moon props + `gravityScale` integrator wiring + torch / dark overlay + `2-1`–`2-4` |

The fields `hasTorch`, `boss`, `gravityScale` remain declared in the data model from PR 1 but the engine doesn't consult them yet (`hasTorch` is `false`, `gravityScale` is `1`, `boss` is `null` for 1-1).

## Tuning notes

- Existing physics: peak jump ≈ 2.7 tiles (`JUMP_VEL = -14`, `GRAVITY = 0.6`). Any chain-jump in the redesigned 1-1 must land on a platform ≤ 2.7 tiles above the previous standing surface.
- The Zone D bonus-coin row (row 4) requires the jetpack — that's intentional. Without the jetpack, the row-4 coins are out of reach.
- If any platform feels unfair on tester playthroughs, prefer adjusting the tile strings over changing physics constants. Physics constants apply to every level; tile strings are local.
