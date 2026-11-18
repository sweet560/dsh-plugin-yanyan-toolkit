# Subagent Management (dsh-plugin-yanyan-subagent)

The third plugin in the "Yanyan Toolkit" aggregate bundle. It lists and manages all subagents of the current session.

## Features

- Adds a tab to the conversation header actions (default label "Agent Manager", renameable from the overlay; the name is persisted in browser local storage).
- Clicking the tab opens an overlay. The overlay is mounted through `ReactDOM.createPortal` into `document.body` so the header's overflow clipping cannot cut it off; when `react-dom` is unavailable it falls back to appending a plain DOM overlay to `document.body`.
- Lists every subagent of the current session with name, status (running / idle), mode and an estimated idle duration.
- A trailing delete button (U+2715 MULTIPLICATION X, a plain Unicode math symbol, not an emoji) deletes one subagent after a confirmation. Running subagents are stopped before deletion. The root session (lead) is never deleted.
- The bottom "Clean All Idle" button immediately batch-deletes every entry shown as idle (anything not running), regardless of the idle threshold (the threshold only applies to timed auto-clean); its criteria match the list and the host /cleanup route, and it reports the count (or a "nothing to clean" hint).
- The "Settings" section enables "Auto-clean idle subagents" (on by default, idle threshold defaults to 30 minutes and check interval defaults to 10 minutes), with "Idle over (minutes)" and "Check interval (minutes)". When enabled, each check only deletes idle subagents that reached the threshold; a failed list read is fail-closed (nothing is deleted).

## Delete semantics (physical deletion, irreversible)

Deleting **really removes the session data** and erases the catalog row at its source; it no longer archives. Layers:

1. Real sessions reuse the existing `@linxin666/dsh-session-archive` physical-delete pipeline (`POST /api/dsh-session-archive/delete`), which cleans the sqlite rdb, session directory, projection cache and archive ledger.
2. The host `/purge` route then cleans up again: the session directory (both `session-`-prefixed and bare spellings, with realpath checks), projcache files and parent `subagentCatalog` cache references, `workspace.json` `global.archivedSessionIds` and `tables.workspaces[*].sessionIds` accounting, and `archive-ledger.json`; it also removes the archive marker via `workspaceRegistry.unarchiveSession`.
3. mnemon virtual delegations (ids like `mnemon-run-v1-<uuid>`, not real `session-<uuid>` sessions) go straight to layer 2 — calling `archiveSession` on such an id reports `session/not-found`.
4. **Catalog root-cause fix (v1.2.0)**: `subagentCatalog` is an **append-only projection** of `subagent/catalog` events in the parent session log (`session.v4.jsonl.zstd`); the official `@deepseek-ai/dsh-chunked-list` has no delete API, so clearing caches or archiving can never remove the source reference and the host rebuilds the row on the next `refreshProjections`. Borrowing the in-place "retirement" idea from `huajiao1998/dsh-plugin-subagent-clean@0.3.0` (MIT, originally `heiheiha798/dsh-plugin-subagent-delete@0.2.3`), `/purge` rewrites the matching `subagent/catalog` event **in place** into `{"type":"subagent-delete/retired","seq":<same>,"time":<same>,"ignorable":true,"data":{"childId","retiredAt"}}`. The `seq`/`time` are preserved (log seq continuity and compaction references stay valid), only `type === "subagent/catalog"` produces directory rows, so the projection never recreates the row. Log decoding/encoding uses `node:zlib` zstd (Node >= 22.15 / 24), with two `stat` checks around an atomic rename for concurrency safety; a failed rewrite is queued to `yanyan-subagent-pending.json` and replayed on next host start.
5. **Fallback hidden list**: the client still keeps a persistent hidden list in `localStorage['yanyan-subagent.deletedIds']` (core ids with the `session-` prefix stripped). It filters during rendering, batch cleaning, auto-cleaning and the official list row-tail action, so even a concurrent-write / decode failure cannot make a deleted row reappear.
6. **In-memory projection root fix (v1.2.1)**: the official "N subagents" popover (`SubagentHeaderLineage`) reads only the client in-memory store `ctx.sessions.list.getSnapshot().projectionsBySession[*].values.subagentCatalog`; the host reuses the in-memory fold state for a loaded live parent session, so rewriting the on-disk zstd log / deleting projcache never triggers a recompute — already-retired residual rows keep showing and clicking one reports `subagent is unavailable (subagent/not-found)`. To fix this, the host adds `collectRetiredIds` to scan the whole library for `subagent-delete/retired` log rows and ships `hiddenIds` via `/config` (compatibility bridge: an extended `legacy-hidden-ids.json` makes the old host process deliver them immediately); the client's `patchProjections` subscribes to `sessions.list` and, using the host's own `list.set()`, continuously removes hidden childIds from every `projectionsBySession[*].values.subagentCatalog` (idempotent, no self-loop), so the official popover's `directCount` drops to zero and hides itself. This is the real root-cause layer behind "never able to delete".

**This operation is irreversible**: a confirmation is required; running subagents are stopped first. The root session (lead) is never deleted.

### Residual rows, one-click cleanup and sidebar sync

- A **"Clean residual rows"** button in the overlay calls the host `/scrub` route, which retires catalog rows whose sub-session directory is already gone (leftovers from older archive / rebuild behaviour, figures 2 and 3). After every delete, batch clean, auto-clean and scrub, the client calls `ctx.sessions.refresh()` in addition to `refreshProjections(rootId)` so the **sidebar residual row disappears in sync**.
- The host `/cleanup` route (and the model tool) batch-deletes with a **single** whole-library log rewrite (`retireCatalogRowsEverywhere`) instead of one rewrite per row.
- Host `/catalog` lists the still-live `subagent/catalog` events straight from the log (the reliable source of truth, unlike the rebuildable projcache cache).

### Model tools (optional `tools` injection)

Three plain-object tools are registered when the profile provides the `tools` service, so an Agent can do the cleanup in one sentence (the `mnemon_forget` idea from the request targets Mnemon memory insights, not subagent sessions, so its "let the Agent trigger cleanup" intent is served here instead):

- `yanyan_list_subagents` — list live catalog rows (filter by label).
- `yanyan_delete_subagent` — permanently delete one subagent (required `subagent_id`).
- `yanyan_cleanup_subagents` — batch delete (label filter / idle-only / dry-run / limit), matching "list all idle `Mnemon idle checkpoint review` subagents and delete them all".

## Data sources and fallbacks

- Primary source is the browser session projection: `ctx.sessions.list.getSnapshot().projectionsBySession[rootId].values.subagentCatalog`.
- The root session id is derived from `retainedBy.mainView > 0`, falling back to the first session in `projectionsBySession` that carries `subagentCatalog`.
- If the local projection is unavailable, the client falls back to the host route `/__dsh-plugin-yanyan-subagent/list` (which depends on `subagents.listDescendants` and returns `service-unavailable` when that service is missing).
- The official projection has no idle-origin field (`lastActiveAt` / `idleSince` have zero hits for subagent UI). Idle duration is estimated in memory from the first time an `inactive` row is observed, and resets on page reload.

## Limitation of the row-tail delete button in the official subagent list (figure 3, optional enhancement)

The plugin makes a best-effort attempt with a `MutationObserver`: when the official `[data-subagent-panel]` overlay appears, it appends a small delete button to every `[role="treeitem"]` row. There is a confirmed hard limitation:

- Official list rows have **no row-level Slot and no stable identifier such as `data-id`**; the row `aria-label` is only `[primaryLabel, secondary, metrics].join(' ')`, which cannot be reliably mapped back to a `sessionId`.
- Clicking that button therefore only does fuzzy matching of row text against the local `subagentCatalog` (name containment plus order alignment). **Deletion runs only for a unique match**; otherwise the user is told to use the Agent Manager tab, where a definite `sessionId` is available.
- This DOM injection is a fragile enhancement: it can break whenever the official DOM changes, and matching can misfire. Prefer the row-tail delete button inside this plugin's own "Agent Manager" tab.

## Configuration

`cordis.patch.yml` carries the defaults (the profile override replaces the whole config for the same id without a deep merge, so the host `normalizeConfig()` provides a fallback for every missing key):

| Key | Default | Meaning |
| --- | --- | --- |
| `tabLabel` | Agent Manager | Header tab label, renameable from the overlay |
| `autoCleanEnabled` | true | Auto-clean switch, on by default |
| `idleMinutes` | 30 | Idle threshold in minutes (1..10080) |
| `checkIntervalMin` | 10 | Auto-clean check interval in minutes (1..1440) |

## Tests

```
node --test test/*.test.mjs
```

Pure unit tests cover `normalizeConfig`, `parseCatalog`, `idleFilter`, deletion id validation, in-place log retirement, `collectRetiredIds` / `collectHiddenIds` and `patchProjections` in-memory projection filtering; no DSH service is contacted (68/68 tree-wide tests pass).
