# dsh-plugin-yanyan-session-hub

Session Hub (Phase 1). Stores `sessionId -> { tags, folderId, customTitle }` in a side-car ledger `$DSH_HOME/session-metadata.json` (atomic write + in-process serialization lock), with a three-pane settings section: left nav tree, center session list, right detail pane.

## Boundaries

- **Never touch native session files**: folders and tags are logical mappings written only to the side-car JSON; DSH's `sessions/` dir is read-only.
- **Atomic write + lock**: reuses the recycle bin's nonce temp + rename and Promise-chain lock discipline.
- **Recycle bin as system folder**: a `Recycle bin` entry (logical id `@trash`) stays at the bottom of the left nav.

## Composition

- Host (`lib/index.js`): assembles aggregate package `lib/session-metadata-{service,routes}.js`, exposes `api/dsh-yanyan-session-hub/*` loopback routes.
- Client (`lib/client.js`): React plugin registering `settings.section` (id `dsh-yanyan-session-hub`, order 27).

## Phase 1 scope

- Metadata read/write + atomic write + lock;
- Three-pane UI (left nav: folders/tags/recycle bin; center list: search + multiselect + sort by update time; right pane: detail/tags/folder);
- Interactions: create/rename/delete folder, move session into folder, add/remove tags, custom title — all persisted to the side-car JSON.

**Excludes** Phase 2 full-text search (zstd inverted index) and Phase 3 Markdown/ZIP batch export.

## Install

- **Restart DSH host after install** for the new loader entry to register.
- **Not standalone**: Host imports aggregate modules via `../../../lib/`; ship with `dsh-plugin-yanyan-toolkit`.
