# AI-Generated App Icons

## Problem

Every artifact on the Oyster desktop uses the same generic type-based SVG icon. A Snake Game, Weather App, and Calculator all show identical `<>` brackets. This makes the desktop feel lifeless and makes it hard to distinguish apps at a glance.

## Solution

When an artifact is first registered, the Oyster server generates a unique icon using the Flux Schnell model via fal.ai. The icon is saved as a PNG in the artifact's directory and served to the frontend, which renders it instead of the generic SVG.

## Architecture

### Data Flow

```
1. New artifact registered (registerGeneratedArtifact)
2. Check: icon.png exists? → Yes → set icon field, done
3. No → set iconStatus: "pending", enqueue in IconGenerator
4. IconGenerator processes queue (sequential, one at a time):
   a. Set iconStatus: "generating"
   b. Build prompt from artifact name + type
   c. Call fal.ai Flux Schnell API (512x512)
   d. Download image from returned URL
   e. Write to /artifacts/<id>/icon.png (using raw dir name, not gen:-prefixed id)
   f. Set iconStatus: "ready", set icon field
   g. On failure → set iconStatus: "failed", log error, move to next
5. Frontend polls /api/artifacts (existing 5s interval)
6. Picks up icon field, renders <img> instead of SVG
```

### Trigger Guard

Icon generation only applies to artifacts inside `ARTIFACTS_DIR` (i.e., `/artifacts/<id>/`). Legacy artifacts from `web/public/` and registry apps from `registry.json` are excluded — they have no writable artifact directory for icon storage.

The trigger point is in `index.ts`, after `registerGeneratedArtifact()` is called from the manifest or inferred-path registration flows (NOT the legacy path). The existing `seenArtifacts` Set ensures each artifact is registered only once per server lifetime, which is the primary deduplication mechanism. As an additional safety check, the IconGenerator skips enqueueing if `icon.png` already exists on disk.

This prevents duplicate jobs from edits, rebuilds, or rescans.

### Failure Handling

- `iconStatus: "failed"` is a terminal state — no automatic retry
- Failed artifacts keep their generic SVG icon
- To retry: delete the artifact directory. On the next `/api/artifacts` poll, self-healing removes the stale entry and clears `seenArtifacts` for that id (via `onRemove` callback). Recreating the directory then triggers fresh registration and icon generation. Note: there is a timing dependency — the cleanup only fires when the next poll hits `/api/artifacts`.
- Queue processing continues to the next item on failure (one bad artifact doesn't block others)

## Files to Create/Modify

### New: `server/src/icon-generator.ts`

Dedicated module with:
- `IconGenerator` class
- Sequential queue (array of pending jobs, processes one at a time)
- `enqueue(artifactId, name, type, artifactDir)` — adds job, starts processing if idle. `artifactDir` is the filesystem path to the artifact directory (e.g., `/artifacts/snake-game/`), used for writing `icon.png`.
- `generateIcon(name, type)` — builds prompt, calls fal.ai via `@fal-ai/client`, returns image URL
- **New dependency:** `@fal-ai/client` — official fal.ai SDK, handles queue subscription and polling automatically
- Reads `FAL_KEY` from `process.env` (the fal client reads this automatically)

**Prompt template (per type):**

The prompt is built from the artifact name and type. Each type gets contextual style hints:

```
App icon for "{name}". Modern rounded square app icon in Apple iOS style.
Subtle [color] gradient background. Single centred minimal illustration of
[type-specific description]. Clean, bold shapes. No text, no letters, no
words, no UI, no border. High contrast, simple composition, recognisable
at small sizes.
```

Example for a game called "Zombie Horde":
```
App icon for "Zombie Horde". Modern rounded square app icon in Apple iOS style.
Subtle dark green to teal gradient background. Single centred minimal illustration
of a stylised zombie hand reaching upward from the ground, with a faint glow and
soft shadow. Clean, bold shapes, slightly playful rather than gruesome. No blood,
no gore, no text, no letters, no words, no UI, no border. High contrast, simple
composition, recognisable at small sizes.
```

**API usage (via `@fal-ai/client`):**
```typescript
import { fal } from "@fal-ai/client";

const result = await fal.subscribe("fal-ai/flux/schnell", {
  input: {
    prompt: builtPrompt,
    image_size: { width: 512, height: 512 },
    num_images: 1,
    num_inference_steps: 4,
    enable_safety_checker: true,
  },
});
const imageUrl = result.data.images[0].url;
// Download imageUrl and save as icon.png
```

**Cost:** ~$0.001 per icon (Flux Schnell, 512x512 = ~0.26 megapixels at $0.003/MP).
**Speed:** 1-4 seconds per icon (4 inference steps).

### Modified: `server/src/process-manager.ts`

- Add `icon?: string` field to `Artifact` interface (URL path like `/artifacts/<id>/icon.png`)
- Add `iconStatus?: "pending" | "generating" | "ready" | "failed"` field
- Add `updateGeneratedArtifact(id, fields)` export — updates fields on an existing artifact in the `generatedArtifacts` Map. This is how `IconGenerator` writes back `icon` and `iconStatus` after generation.
- In `registerGeneratedArtifact()`: check for existing `icon.png`, set `icon` and `iconStatus` accordingly

**Important: `icon` path uses the raw artifact directory name, NOT the `gen:`-prefixed internal ID.** Internal IDs are `gen:snake-game` but the filesystem path and URL are `/artifacts/snake-game/icon.png`. The `icon` field stores the URL path (e.g., `/artifacts/snake-game/icon.png`), which maps directly to the filesystem.

### Modified: `server/src/index.ts`

- Import and instantiate `IconGenerator`
- After `registerGeneratedArtifact()` calls **in the manifest and inferred-path flows only** (NOT the legacy `web/public` path), invoke `iconGenerator.enqueue()` if no icon exists on disk
- IconGenerator uses `updateGeneratedArtifact()` (from process-manager.ts) to write back `icon` and `iconStatus`

No changes needed for serving — the existing `/artifacts/*` static file handler already supports `.png` with correct MIME type.

**Note on `status` vs `iconStatus`:** The existing `status` field on artifacts (online/offline/starting/ready) and the frontend's `status: "generating"` type are unrelated to icon generation. `iconStatus` is a separate field tracking the icon pipeline only. Do not conflate the two.

### Modified: `web/src/data/artifacts-api.ts`

- Add `icon?: string` to `Artifact` type
- Add `iconStatus?: "pending" | "generating" | "ready" | "failed"` (optional, for future UI)

### Modified: `web/src/components/ArtifactIcon.tsx`

- If `artifact.icon` exists, render `<img src={artifact.icon} class="icon-img">` inside the thumbnail
- Fall back to existing type-based SVG when no icon
- CSS: `object-fit: cover; border-radius: 16px; width: 100%; height: 100%`
- Subtle fade-in transition when image loads

### Modified: `web/vite.config.ts`

- No changes needed if `/artifacts` is already proxied. Verify.

## Icon Style

"Modern Depth" — subtle gradient background, soft shadow, clean minimal illustration of the concept, no text. Matches modern Apple iOS/macOS Big Sur aesthetic. Each icon is unique based on the artifact's name and type.

## Dependencies

- **`@fal-ai/client`** (new, server) — official fal.ai SDK. Handles queue subscription, polling, and auth automatically. Reads `FAL_KEY` from env.
- No image resize needed — 512x512 is appropriately sized for icons displayed at 72px. ~50-80KB per PNG.
- No new frontend dependencies.

## Environment

- `FAL_KEY` — required in server environment (via `.env` file or shell export). Get one at https://fal.ai/dashboard/keys
- Server logs a warning on startup if key is missing; icon generation silently skipped

## Known Limitations (PoC)

- **Thin prompts:** Only artifact name + type are used. Generic names ("Dashboard", "Notes") will produce generic icons. Future: read app HTML or manifest description for richer context.
- **No regeneration UI:** Failed or ugly icons can't be re-generated from the frontend yet.
- **No icon for registry apps:** Only generated artifacts get AI icons. Registry apps (from `registry.json`) keep their type-based SVG icons.
- **Cold start:** Icons aren't generated until server processes the queue. First appearance uses SVG fallback for ~5-10 seconds (Flux is fast: 1-4s generation + download + next poll).

## Verification

1. Set `FAL_KEY` in environment (get key at https://fal.ai/dashboard/keys)
2. Start server, create an artifact in `/artifacts/test-app/` with a manifest
3. Check server logs for `[icon-generator] generating icon for "Test App"...`
4. Within 10-15s, `icon.png` appears in `/artifacts/test-app/`
5. Frontend shows the AI icon instead of generic SVG
6. Delete the artifact directory → icon and artifact both disappear (self-healing)
7. Restart server → existing icons are detected from disk, no re-generation
8. Remove `FAL_KEY` → server starts normally, icons silently skipped
