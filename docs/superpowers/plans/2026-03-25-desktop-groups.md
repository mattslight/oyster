# Desktop Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add iOS App Library-style groups to the Desktop so artifacts can be visually organized into named groups with 2x2 preview thumbnails and a click-to-expand popup.

**Architecture:** A nullable `group_name` column on the artifacts table, surfaced through the existing API. The frontend partitions artifacts by group, renders group icons with mini previews, and opens a popup overlay on click. Two new components: `GroupIcon` and `GroupPopup`.

**Tech Stack:** SQLite, TypeScript, React, CSS

**Spec:** `docs/superpowers/specs/2026-03-25-desktop-folders-design.md`

---

### Task 1: Add group_name column to database

**Files:**
- Modify: `server/src/db.ts:20-28`
- Modify: `server/src/artifact-store.ts:5-17,48-51,72-75`

- [ ] **Step 1: Add migration to db.ts**

In `initDb`, after `db.exec(SCHEMA)`, add a safe migration:

```typescript
try {
  db.exec("ALTER TABLE artifacts ADD COLUMN group_name TEXT");
} catch {
  // Column already exists
}
```

- [ ] **Step 2: Add group_name to ArtifactRow**

In `artifact-store.ts`, add `group_name: string | null;` to the `ArtifactRow` interface after `runtime_config`.

- [ ] **Step 3: Add group_name to UPDATABLE_COLUMNS**

Add `"group_name"` to the `UPDATABLE_COLUMNS` Set.

- [ ] **Step 4: Add group_name to INSERT statement**

Update the insert prepared statement to include `group_name` in both the column list and VALUES:

```sql
INSERT INTO artifacts (id, owner_id, space_id, label, artifact_kind, storage_kind, storage_config, runtime_kind, runtime_config, group_name)
VALUES (@id, @owner_id, @space_id, @label, @artifact_kind, @storage_kind, @storage_config, @runtime_kind, @runtime_config, @group_name)
```

- [ ] **Step 5: Commit**

```bash
git add server/src/db.ts server/src/artifact-store.ts
git commit -m "feat: add group_name column to artifacts table"
```

---

### Task 2: Surface groupName through types and service

**Files:**
- Modify: `shared/types.ts:19-31`
- Modify: `server/src/artifact-service.ts:84-94,105-115`

- [ ] **Step 1: Add groupName to shared Artifact type**

In `shared/types.ts`, add `groupName?: string;` to the `Artifact` interface after `createdAt`.

- [ ] **Step 2: Add groupName to both return paths in rowToArtifact**

In `artifact-service.ts`, add `groupName: row.group_name || undefined,` to both return objects:
- The `local_process` return block (after `createdAt: row.created_at,` at line 93)
- The `static_file/redirect` return block (after `createdAt: row.created_at,` at line 114)

- [ ] **Step 3: Verify the server compiles**

```bash
cd /Users/Matthew.Slight/Dev/oyster-os && npx tsc --noEmit --project server/tsconfig.json
```

If no tsconfig exists for server, just restart the dev server and check for errors.

- [ ] **Step 4: Commit**

```bash
git add shared/types.ts server/src/artifact-service.ts
git commit -m "feat: surface groupName through Artifact type and service"
```

---

### Task 3: Export typeConfig from ArtifactIcon

**Files:**
- Modify: `web/src/components/ArtifactIcon.tsx:3-49`

The `GroupIcon` component needs the same gradient/color/icon data to render mini previews. Export the existing `typeConfig` so it can be shared.

- [ ] **Step 1: Export typeConfig**

Change `const typeConfig` to `export const typeConfig` at line 3 of `ArtifactIcon.tsx`.

- [ ] **Step 2: Commit**

```bash
git add web/src/components/ArtifactIcon.tsx
git commit -m "refactor: export typeConfig from ArtifactIcon for reuse"
```

---

### Task 4: Create GroupIcon component

**Files:**
- Create: `web/src/components/GroupIcon.tsx`

Renders an iOS App Library-style group thumbnail: a 72x72 rounded rect with a 2x2 grid of mini artifact type icons inside. Label below is the group name.

- [ ] **Step 1: Create GroupIcon.tsx**

```tsx
import type { Artifact } from "../data/artifacts-api";
import { typeConfig } from "./ArtifactIcon";

interface Props {
  name: string;
  artifacts: Artifact[];
  index: number;
  onClick: () => void;
}

export function GroupIcon({ name, artifacts, index, onClick }: Props) {
  // Take first 4 artifacts for the 2x2 preview
  const previews = artifacts.slice(0, 4);

  return (
    <button
      className="artifact-icon"
      style={{ animationDelay: `${index * 0.05 + 0.05}s` }}
      onClick={onClick}
    >
      <div className="group-thumb">
        <div className="group-grid">
          {[0, 1, 2, 3].map((i) => {
            const artifact = previews[i];
            if (!artifact) {
              return <div key={i} className="group-cell group-cell-empty" />;
            }
            const config = typeConfig[artifact.artifactKind] || typeConfig.app;
            return (
              <div
                key={artifact.id}
                className="group-cell"
                style={{ background: config.gradient }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={config.color}
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={config.icon} />
                </svg>
              </div>
            );
          })}
        </div>
        {artifacts.length > 4 && (
          <span className="group-count">+{artifacts.length - 4}</span>
        )}
      </div>
      <span className="icon-label">{name}</span>
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/GroupIcon.tsx
git commit -m "feat: add GroupIcon component with 2x2 preview grid"
```

---

### Task 5: Create GroupPopup component

**Files:**
- Create: `web/src/components/GroupPopup.tsx`

A centered overlay with backdrop blur, showing the group's artifacts as a grid of `ArtifactIcon` components. Closes on click-outside or Escape.

- [ ] **Step 1: Create GroupPopup.tsx**

```tsx
import { useEffect, useRef } from "react";
import type { Artifact } from "../data/artifacts-api";
import { ArtifactIcon } from "./ArtifactIcon";

interface Props {
  name: string;
  artifacts: Artifact[];
  onArtifactClick: (artifact: Artifact) => void;
  onArtifactStop?: (artifact: Artifact) => void;
  onClose: () => void;
}

export function GroupPopup({ name, artifacts, onArtifactClick, onArtifactStop, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function handleBackdropClick(e: React.MouseEvent) {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  }

  return (
    <div className="group-popup-overlay" onClick={handleBackdropClick}>
      <div className="group-popup" ref={panelRef}>
        <div className="group-popup-header">{name}</div>
        <div className="group-popup-grid">
          {artifacts.map((artifact, i) => (
            <ArtifactIcon
              key={artifact.id}
              artifact={artifact}
              index={i}
              onClick={() => onArtifactClick(artifact)}
              onStop={onArtifactStop ? () => onArtifactStop(artifact) : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/GroupPopup.tsx
git commit -m "feat: add GroupPopup overlay component"
```

---

### Task 6: Add CSS for GroupIcon and GroupPopup

**Files:**
- Modify: `web/src/App.css` (append after the `.artifact-icon:hover .stop-btn` block, around line 266)

- [ ] **Step 1: Add group styles to App.css**

Append the following CSS after the stop-btn styles:

```css
/* ── Group icon (iOS App Library-style) ── */
.group-thumb {
  width: 72px;
  height: 72px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  flex-shrink: 0;
  padding: 5px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.group-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 3px;
  width: 100%;
  height: 100%;
}

.group-cell {
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.group-cell svg {
  width: 16px;
  height: 16px;
  opacity: 0.9;
}

.group-cell-empty {
  background: rgba(255, 255, 255, 0.03);
}

.group-count {
  position: absolute;
  bottom: -2px;
  right: -2px;
  font-size: 0.55rem;
  font-weight: 700;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  padding: 1px 4px;
  border-radius: 6px;
  line-height: 1;
}

/* ── Group popup ── */
.group-popup-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.15s ease;
}

.group-popup {
  background: rgba(30, 30, 50, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 20px;
  padding: 24px;
  min-width: 280px;
  max-width: 500px;
  max-height: 70vh;
  overflow-y: auto;
  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
  animation: scaleIn 0.2s ease;
}

.group-popup-header {
  font-size: 1rem;
  font-weight: 600;
  text-align: center;
  margin-bottom: 16px;
  color: var(--text);
}

.group-popup-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  justify-items: center;
}

@keyframes scaleIn {
  from { transform: scale(0.9); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/App.css
git commit -m "feat: add CSS for group icon and popup"
```

---

### Task 7: Wire groups into Desktop and App

**Files:**
- Modify: `web/src/components/Desktop.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Update Desktop.tsx to render groups**

Replace the current Desktop component:

```tsx
import { useMemo } from "react";
import type { Artifact } from "../data/artifacts-api";
import { ArtifactIcon } from "./ArtifactIcon";
import { GroupIcon } from "./GroupIcon";
import Grainient from "./reactbits/Grainient";

interface Props {
  artifacts: Artifact[];
  onArtifactClick: (artifact: Artifact) => void;
  onArtifactStop?: (artifact: Artifact) => void;
  onGroupClick: (groupName: string) => void;
}

export function Desktop({ artifacts, onArtifactClick, onArtifactStop, onGroupClick }: Props) {
  const { groups, ungrouped } = useMemo(() => {
    const groups: Record<string, Artifact[]> = {};
    const ungrouped: Artifact[] = [];
    for (const a of artifacts) {
      if (a.groupName) {
        (groups[a.groupName] ??= []).push(a);
      } else {
        ungrouped.push(a);
      }
    }
    return { groups, ungrouped };
  }, [artifacts]);

  const sortedGroupNames = Object.keys(groups).sort();
  let idx = 0;

  return (
    <div className="desktop">
      <div className="desktop-bg">
        <Grainient
          color1="#07060f"
          color2="#7c6bff"
          color3="#5227FF"
          timeSpeed={0.15}
          colorBalance={0}
          warpStrength={2}
          warpFrequency={6.5}
          warpSpeed={2}
          warpAmplitude={20}
          blendAngle={0}
          blendSoftness={0.05}
          rotationAmount={500}
          noiseScale={2}
          grainAmount={0.15}
          grainScale={2}
          grainAnimated={false}
          contrast={1.2}
          gamma={0.8}
          saturation={0.7}
          centerX={0}
          centerY={0}
          zoom={1}
        />
      </div>
      <div className="icon-grid">
        {sortedGroupNames.map((name) => {
          const i = idx++;
          return (
            <GroupIcon
              key={`group:${name}`}
              name={name}
              artifacts={groups[name]}
              index={i}
              onClick={() => onGroupClick(name)}
            />
          );
        })}
        {ungrouped.map((artifact) => {
          const i = idx++;
          return (
            <ArtifactIcon
              key={artifact.id}
              artifact={artifact}
              index={i}
              onClick={() => onArtifactClick(artifact)}
              onStop={onArtifactStop ? () => onArtifactStop(artifact) : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update App.tsx to manage group popup state**

Add the import at the top:
```tsx
import { GroupPopup } from "./components/GroupPopup";
```

Add state after the existing state declarations (around line 34):
```tsx
const [openGroup, setOpenGroup] = useState<string | null>(null);
```

Update the `<Desktop>` component to pass `onGroupClick`:
```tsx
<Desktop
  artifacts={artifacts.filter((a) => a.spaceId === activeSpace)}
  onArtifactClick={handleArtifactClick}
  onArtifactStop={handleArtifactStop}
  onGroupClick={setOpenGroup}
/>
```

Add the `<GroupPopup>` render right before `<ChatBar>` (around line 229):
```tsx
{openGroup && (
  <GroupPopup
    name={openGroup}
    artifacts={artifacts.filter(
      (a) => a.spaceId === activeSpace && a.groupName === openGroup
    )}
    onArtifactClick={(artifact) => {
      setOpenGroup(null);
      handleArtifactClick(artifact);
    }}
    onArtifactStop={handleArtifactStop}
    onClose={() => setOpenGroup(null)}
  />
)}
```

- [ ] **Step 3: Verify the app compiles and renders**

```bash
cd /Users/Matthew.Slight/Dev/oyster-os && npm run dev
```

Open the browser and check that the tokinvest space still renders correctly (all artifacts ungrouped for now since no group_name values are set).

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Desktop.tsx web/src/App.tsx
git commit -m "feat: wire group icons and popup into Desktop and App"
```

---

### Task 8: Seed group_name values for tokinvest

**Files:**
- None (database only)

Assign existing tokinvest artifacts to their groups.

- [ ] **Step 1: Run SQL updates**

```bash
cd /Users/Matthew.Slight/Dev/oyster-os

# Sites
sqlite3 userland/oyster.db "UPDATE artifacts SET group_name = 'Sites' WHERE id IN ('tokinvest-concept', 'tokinvest-drc');"

# Research
sqlite3 userland/oyster.db "UPDATE artifacts SET group_name = 'Research' WHERE id IN ('homepage-audit', 'info-architecture', 'product-surface-map', 'audit-discussion-points', 'competitor-analysis');"

# Invoices
sqlite3 userland/oyster.db "UPDATE artifacts SET group_name = 'Invoices' WHERE id = 'consulting-invoice-ms-2026-001';"
```

- [ ] **Step 2: Verify in browser**

Refresh the tokinvest space. Should see three group icons (Invoices, Research, Sites) instead of eight individual icons. Click each group to verify the popup opens and shows the correct artifacts.

- [ ] **Step 3: No commit needed** (database-only change, not tracked in git)
