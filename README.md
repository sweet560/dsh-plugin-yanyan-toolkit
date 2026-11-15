# Yanyan Toolkit

An umbrella plugin bundle that installs three independently toggleable plugins at once. It follows the "reuse what already exists, do not reinvent the wheel" rule: session management is the existing community package, and the two custom plugins reuse verified official/community injection points wherever possible.

## Included plugins

| Plugin | Row id | Purpose |
| --- | --- | --- |
| Plugin Update | `dsh-plugin-yanyan-update` | Adds a "Check updates" button beside the "Installed plugins" heading on the Plugins page. Clicking it opens a small dropdown listing updatable plugins (current version -> latest version), each with its own "Update" button. Covers npm registry sources and local `link:`/`file:` (git repository) sources. |
| Session Management | `session-archive` | Auto-archive sessions, auto-delete archived sessions (both off by default, configurable to 7/15/30/custom days), single and batch delete. **Directly reuses** `@linxin666/dsh-session-archive@0.4.18`, whose settings page and backend already cover the full requirement. |
| Subagent Management | `dsh-plugin-yanyan-subagent` | Adds a renameable "Agent management" tab to the session header; its popover lists all subagents of the current session, supports per-row delete and a bottom "Clean all idle" action, plus idle-time auto-cleanup (off by default, configurable in minutes). |

Each plugin has its own loader row and can be toggled independently on the Plugins page.

## Design decisions

- **Session management reused without changes**: `@linxin666/dsh-session-archive` already implements auto-archive by `updatedAt`, auto-delete by the archive ledger's `archivedAt`, single/batch physical delete, any day count from 1 to 3650, Host-side scheduling and a settings UI. Its day input accepts any integer from 1 to 3650, which already includes 7/15/30/custom.
- **Plugin update reuses the injection skeleton and fills the gap**: the official `@linxin666/dsh-client-ui-plugin-manager` provides the DOM seat `[data-plugin-panel] [data-plugin-group="bundles"]`, the check-updates button, the dropdown and the dual-channel RPC contract. Its checker, however, only covers npm registry sources (`source.kind === 'npm'`) and skips local `link:`/`file:` directories and GitHub sources. This plugin adds git local source version comparison and `git merge --ff-only` updates in its own Host half, and adds a per-row update button to the dropdown.
- **Subagent "delete" means physical deletion + log root-cause removal (irreversible)**: the old version only called `archiveSession`, which could neither delete mnemon virtual delegations (reports `session/not-found`) nor remove the append-only parent `subagentCatalog` reference, so the row stayed in the list. The host `/purge` route now reuses the existing `/api/dsh-session-archive/delete` pipeline for real sessions and falls back to cleaning session directories, projcache and catalog references, workspace accounting, archive ledger and archive markers; virtual ids go straight to the fallback. Since v1.2.0 it also borrows the in-place "retirement" idea from `dsh-plugin-subagent-clean` (MIT) to rewrite the parent log's `subagent/catalog` event into `subagent-delete/retired` (seq/time preserved, ignorable), erasing the row at its append-only source so the host cannot rebuild it. A "Clean residual rows" button (`/scrub`), a single whole-log rewrite for one-click cleanup (`/cleanup`), `ctx.sessions.refresh()` so sidebar residual rows disappear in sync, a `localStorage['yanyan-subagent.deletedIds']` hidden-list fallback and three optional model tools (`yanyan_list_subagents` / `yanyan_delete_subagent` / `yanyan_cleanup_subagents`) complete the integration.
- **An X at the end of each row in the official subagent list (image 3)**: the official popover rows have no row-level Slot and no `data-session-id`-style DOM anchor, so a stable injection cannot add a per-row delete there. This plugin implements per-row delete inside its own "Agent management" popover (data from `listDescendants`, with explicit ids) and contributes a "Clean all idle" button through `conversation.session.header.actions.subagent.footer`. The in-list X is only an optional, high-risk DOM-injection enhancement and is disabled by default.

## Installation

This package is an npm bundle; its `dsh.bundle.patch` / `cordis.patch.yml` inserts four loader rows at once. Pick one of three ways:

From npm (recommended, requires Node `^22.19.0 || >=24.0.0`):

```
dsh plugin add dsh-plugin-yanyan-toolkit
```

From a local directory (for development):

```
dsh plugin add file:<this package directory>
```

Or choose the local directory / enter the npm package name from the Plugins page's "Add plugin" action.

## Distribution and automation

- npm: `.github/workflows/publish.yml` publishes with OIDC trusted publishing (`npm publish --provenance --access public`) on push to `main`, `v*` tags, a published Release, or manual dispatch. It runs `npm test` first and polls to skip already-published versions. A one-time trusted publisher configuration for this repo/workflow on npmjs.com is required.
- Gitee: `.github/workflows/sync-gitee.yml` mirrors `main` and all tags to Gitee on push to `main` or manual dispatch. It requires the repository Secret `GITEE_SSH_PRIVATE_KEY` (a passphrase-less private key registered on the Gitee account).
- GitHub Releases: each version ships a `dsh-plugin-yanyan-toolkit-<version>.tgz` offline tarball, installable via `npm install <tgz>` and then as a local package.

## Activation

Changes involve bundle rows and `cordis.patch.yml`, so **the user must restart the DSH service for them to take effect** (this session did not restart the running DSH service on its own). After restarting, refresh the page to see:
- the "Check updates" button beside the "Installed plugins" heading;
- the new Session Management section in Settings (provided by the reused package);
- the new "Agent management" tab in the session header.

## Layout

```
dsh-plugin-yanyan-toolkit/          umbrella root (no-op halves, only patch and dependencies)
  cordis.patch.yml                 4 insert rows: self + 3 plugins
  lib/index.js, lib/client.js      minimal host / client halves
  locale/{zh,en}.json              Plugins page display metadata
  packages/
    dsh-plugin-yanyan-update/      Plugin Update (custom)
    dsh-plugin-yanyan-subagent/    Subagent Management (custom)
  (Session Management has no subdirectory; it depends on the npm package directly)
```

The three real plugins are listed in the root package's `dependencies`; pnpm's hoisted layout lifts them and the npm package into the profile root `node_modules`, so all four loader row `name`s resolve.
