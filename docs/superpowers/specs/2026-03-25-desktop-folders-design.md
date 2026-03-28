# Desktop Groups (iOS App Library-style)

Add grouping to the Desktop so artifacts within a space can be organized into visual groups (e.g., "Research", "Invoices", "Sites" in tokinvest). Groups are a view concern — artifacts don't move, they're tagged with a group name. Display, storage location, and grouping are independent.

## Data Model

Add a nullable `group_name` TEXT column to the `artifacts` table. Null means the artifact appears directly on the desktop grid (ungrouped). The value is a plain string like `"Research"`.

**Migration:** In `db.ts`, after `db.exec(SCHEMA)`, add `ALTER TABLE artifacts ADD COLUMN group_name TEXT` wrapped in a try/catch (SQLite throws if the column already exists on subsequent runs).

## Shared Types

Add `groupName?: string` to the `Artifact` interface in `shared/types.ts`.

## Backend

- `artifact-store.ts`: add `group_name` to `ArtifactRow`. It flows into `InsertRow` automatically via the `Omit` type. Add `"group_name"` to `UPDATABLE_COLUMNS`.
- `artifact-service.ts`: include `groupName: row.group_name || undefined` in both return paths of `rowToArtifact` (local_process and static_file/redirect).
- `/api/artifacts` already serializes the full `Artifact` object, so `groupName` flows through automatically.
- No new endpoints needed. Group values are set via the existing `store.update()` method or seeded directly in the database.

## Frontend

### Desktop.tsx

Group artifacts before rendering:

1. Partition artifacts into `{ [groupName]: Artifact[] }` and an ungrouped array (groupName is null/undefined).
2. Render group icons first (sorted alphabetically), then ungrouped artifact icons, in the same `icon-grid`.

### GroupIcon (new component)

iOS App Library-style thumbnail:

- Same dimensions as `ArtifactIcon` (88x88 or matching current icon-thumb size).
- Rounded rect with translucent background (`rgba(255,255,255,0.08)`) and subtle border.
- Interior is a 2x2 grid showing mini versions of the first 4 artifacts' type icons (using the existing `typeConfig` gradients/colors from `ArtifactIcon`). Empty slots are dim placeholders.
- Label below is the group name.
- Optional item count shown below label for groups with >2 items.
- Clicking opens the group popup.

### GroupPopup (new component)

An overlay triggered by clicking a `GroupIcon`:

- Centered on screen, dark translucent background with `backdrop-filter: blur`.
- Header with group name.
- Grid of `ArtifactIcon` components for the group's artifacts (same as desktop icons, reusing the existing component). Artifacts within the popup retain the default `created_at` ordering.
- Closes on click-outside or Escape keypress.
- Clicking an artifact inside the popup triggers the same `onArtifactClick` handler as the desktop.

### App.tsx

- Add state: `openGroup: string | null`.
- Pass `onGroupClick` to `Desktop` that sets `openGroup`.
- Render `GroupPopup` when `openGroup` is set, passing the filtered artifacts. State lives in App.tsx so the popup overlays the full shell (including ChatBar and windows layer).

## Scope Exclusions

- No drag-to-group interaction (future).
- No finder-style drill-down navigation (future).
- No nested groups / subgroups.
- No group creation UI — groups exist implicitly when an artifact has a group_name value.
- No group reordering or customization (icon, color).
- No auto-grouping by artifact kind (future — could suggest groups based on type).
