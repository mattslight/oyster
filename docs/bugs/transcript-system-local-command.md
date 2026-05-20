# Transcript: `system` events with subtype `local_command` leak slash-command machinery into inspector

## Summary

Session Inspector renders raw `<command-name>` / `<command-args>` / `<local-command-stdout>` blocks under a **SYSTEM** badge. These are claude-code slash-command machinery (e.g. `/rename`) that should be hidden from the transcript, the same way #530/#532 hides the `role === "user"` variant.

PR #530/#532 (shipped in 0.9.4) is working as written — this is **not** a regression of that work. It is a new uncovered ingest path: claude-code emits the same machinery as `type: "system", subtype: "local_command"` JSONL events, which the existing classifier never sees.

## Reproduce

1. In a claude-code session, run `/rename "Some new title"`.
2. Open the session in the Oyster Inspector.
3. Two SYSTEM rows appear, e.g.:

   ```
   SYSTEM
   local_command: <command-name>/rename</command-name>
       <command-message>rename</command-message>
       <command-args>TOKINVEST: review SEO PR #40</command-args>

   SYSTEM
   local_command: <local-command-stdout>Session renamed to: TOKINVEST: review SEO PR #40</local-command-stdout>
   ```

## Root cause

Two compounding gaps in the #530 classifier:

1. `is_protocol_artifact` is only set when `rendered.role === "user"` (see `server/src/watchers/claude-code.ts:467-468` and the duplicate at `:800-801`). System-role events are never classified.
2. `renderEvent`'s `system` case at `server/src/watchers/claude-code.ts:1041-1045` emits text as `` `${subtype}: ${content}` `` → produces `local_command: <command-name>…`. Even if the role gate were removed, `isClaudeProtocolArtifact` checks `startsWith("<local-command-")` / `<command-` / `<system-reminder>` and returns false for text that starts with the `local_command: ` subtype prefix.

## Suggested fix (sketch)

- Drop the `role === "user"` gate in `claude-code.ts:467-468` and `:800-801` so system rows get classified too.
- Either: teach `isClaudeProtocolArtifact` to also match the `local_command: <...>` shape, **or** classify directly in the `system` case of `renderEvent` when `subtype === "local_command"`.
- Backfill predicate at `server/src/db.ts:759-772` needs the same `local_command: ` prefix so existing rows on disk get cleaned up on the next boot. Will need a new `app_state` gate flag (mirror the existing `device_label_backfill_done` pattern) so it only runs once.
- Add a regression test in `server/test/session-protocol-artifacts.test.ts` covering a `type: "system", subtype: "local_command"` event end-to-end.

## Scope / risk

- Self-contained server-side change, additive backfill, mirrors the shape of #530.
- No user-visible CHANGELOG entry needed beyond "hides slash-command machinery from SYSTEM rows too" if filed under Fixed.

## Related

- PR #530 / #532 — original hide-slash-command-machinery work (0.9.4)
- `server/src/utils/claude-protocol-artifacts.ts` — classifier helper
