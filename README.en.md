# Yanyan Toolkit

[![npm version](https://img.shields.io/npm/v/dsh-plugin-yanyan-toolkit.svg)](https://www.npmjs.com/package/dsh-plugin-yanyan-toolkit) [![npm downloads](https://img.shields.io/npm/dm/dsh-plugin-yanyan-toolkit.svg)](https://www.npmjs.com/package/dsh-plugin-yanyan-toolkit) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/) [![publish](https://github.com/sweet560/dsh-plugin-yanyan-toolkit/actions/workflows/publish.yml/badge.svg)](https://github.com/sweet560/dsh-plugin-yanyan-toolkit/actions/workflows/publish.yml) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

English | [中文](README.md)

> **Current version: v1.5.0** | Requires DSH **0.2.2-rc.5**

> Repository: [GitHub](https://github.com/sweet560/dsh-plugin-yanyan-toolkit)

Yanyan Toolkit is an "install once, get five" umbrella bundle: one install gives you five independently toggleable plugins covering five everyday needs - plugin updates, session organization, subagent cleanup, icon generation, and plugin discovery. One package equips you with a complete set of DSH daily tools.

- **Plugin Update**: check and update plugins row by row on the Plugins page, covering both npm and local git/file sources;
- **Session Hub**: manage sessions, workspaces and tags in a three-pane layout, with a built-in recycle bin and batch operations so accidental deletions can be restored;
- **Subagent Management**: clean up subagents one by one or all at once from the session tab, thoroughly removing leftovers;
- **Icon Generator**: upload an image to auto-crop, preview and download a plugin icon, no design tool needed;
- **Find the Right Plugin**: registers a tool for the agent to pick "the one plugin you should install" from the entire DSH plugin ecosystem.

All five are self-developed, can be toggled independently, and are stable and reliable.

## Included plugins

| Plugin | Row id | Purpose |
| --- | --- | --- |
| Plugin Update | `dsh-plugin-yanyan-update` | Adds a "Check updates" button beside the "Installed plugins" heading on the Plugins page. Clicking it opens a small dropdown listing updatable plugins (current version -> latest version), each with its own "Update" button. Covers npm registry sources and local `link:`/`file:` (git repository) sources. |
| Session Hub | `dsh-plugin-yanyan-session-hub` | A dedicated settings section with a three-pane layout (left nav / center list / right detail); workspace (folder) and tag management, custom titles, status tags; session search/filter, batch archive / unarchive / delete; a built-in **Recycle Bin** tab with move-in / restore / permanent delete (incl. cascade), proactively calling the host `sessions.refresh()` after changes so the sidebar syncs immediately. All metadata is written only to a side-car ledger, never to native DSH session files. The former standalone trash subpackage's capabilities were merged here. |
| Subagent Management | `dsh-plugin-yanyan-subagent` | Adds a renameable "Agent management" tab to the session header; its popover lists all subagents of the current session and supports **permanent per-row delete** (log root-cause removal + in-memory projection fix) and a bottom "Clean all idle" action, plus idle-time auto-cleanup (off by default, configurable in minutes). |
| Icon Generator | `dsh-plugin-yanyan-icon` | Center-crops an uploaded image inside a rounded frame and generates an `icon.svg` fitted for the plugin list artwork slot (30px list row / 36px detail card), with dual-size preview and one-click download. |
| Find the Right Plugin | `dsh-find-right-plugin` | A pure-host tool plugin that registers the `find_dsh_plugins` tool for the agent: it aggregates the whole DSH plugin ecosystem (community curated catalog + live GitHub + live npm), ranks by "relevance x trust x freshness x popularity", recommends the single best match plus a few alternatives, read-only and never installs on its own. Self-developed. |

Each of the five plugins has its own loader row and can be toggled independently on the Plugins page.

## Independent component versions

Every component in the bundle keeps its own independent `package.json` version (the umbrella root and the plugins can be released independently, no forced lockstep): currently `dsh-plugin-yanyan-toolkit` 1.5.0, `dsh-plugin-yanyan-update` 1.2.3, `dsh-plugin-yanyan-subagent` 1.4.12, `dsh-plugin-yanyan-session-hub` 1.0.19 (Session Hub, incl. trash), `dsh-plugin-yanyan-icon` 1.0.3, `dsh-find-right-plugin` 1.0.0 (Find the Right Plugin). The former standalone trash subpackage `dsh-plugin-yanyan-trash` had its capabilities merged into session-hub and the subpackage has been removed; the third-party `@linxin666/dsh-session-archive` has been fully removed.

On the plugin detail page's "Included components" list, a small `v<version>` badge appears next to each component title. The official `InstalledPluginChild` protocol only has `id/name/enabled/locked` and no `version`, so DSH itself never renders per-component versions. The host half adds a `/__dsh-plugin-yanyan-toolkit/components` route that **dynamically reads each component's own `package.json`** (never hardcoded, so versions cannot drift), and the client half reuses the `MutationObserver` + `ctx.effect` injection skeleton from the Plugin Update package: it matches `[data-plugin-rows] li[data-plugin-row]` rows by the real package name in the inline `<code>` and injects the badge. It never mutates React-managed DOM, never touches other plugins' detail pages, and re-attaches automatically after a re-render.

## Design decisions

- **Session Hub reuses the aggregate base and fuses the recycle bin**: the Host half of `dsh-plugin-yanyan-session-hub` directly reuses the aggregate root `lib/session-metadata-{service,routes}.js` and `lib/session-{trash,purge,cascade,snapshot}.js` instead of reinventing them; the former standalone trash subpackage `dsh-plugin-yanyan-trash` (previously a disabled placeholder) had its recycle-bin capabilities fully merged into this plugin's "Recycle Bin" tab, and the subpackage was removed. All metadata is written only to the side-car `session-metadata.json`, never to native DSH session files; restore / archive / batch delete proactively call the host `sessions.refresh()` so the sidebar syncs immediately instead of waiting for host polling; a mixed-selection batch delete groups by archive state with a dedicated confirmation message, clears the selection afterwards, and sessions already in the trash appear only in the Recycle Bin tab.
- **Plugin update reuses the injection skeleton and fills the gap**: the official `@linxin666/dsh-client-ui-plugin-manager` provides the DOM seat `[data-plugin-panel] [data-plugin-group="bundles"]`, the check-updates button, the dropdown and the dual-channel RPC contract. Its checker, however, only covers npm registry sources (`source.kind === 'npm'`) and skips local `link:`/`file:` directories and GitHub sources. This plugin adds git local source version comparison and `git merge --ff-only` updates in its own Host half, and adds a per-row update button to the dropdown.
- **Subagent "delete" means physical deletion + log root-cause removal (irreversible)**: the old version only called `archiveSession`, which could neither delete mnemon virtual delegations (reports `session/not-found`) nor remove the append-only parent `subagentCatalog` reference, so the row stayed in the list. The host `/purge` route now cleans session directories, projcache and catalog references, workspace accounting, archive ledger and archive markers directly for real sessions; virtual ids go through the same local cleanup. The former "reuse the third-party `/api/dsh-session-archive/delete` pipeline" dependency has been removed together with the third-party package; cleanup is now fully self-contained. Since v1.2.0 it also borrows the in-place "retirement" idea from `dsh-plugin-subagent-clean` (MIT) to rewrite the parent log's `subagent/catalog` event into `subagent-delete/retired` (seq/time preserved, ignorable), erasing the row at its append-only source so the host cannot rebuild it. A "Clean residual rows" button (`/scrub`), a single whole-log rewrite for one-click cleanup (`/cleanup`), `ctx.sessions.refresh()` so sidebar residual rows disappear in sync, a `localStorage['yanyan-subagent.deletedIds']` hidden-list fallback and three optional model tools (`yanyan_list_subagents` / `yanyan_delete_subagent` / `yanyan_cleanup_subagents`) complete the integration. Since v1.2.1 the real root-cause layer is covered: the official "N subagents" popover reads only the client in-memory projection `projectionsBySession[*].values.subagentCatalog`, and the host reuses the in-memory fold state for a loaded live parent session, so rewriting the on-disk log / deleting projcache never recomputes it — already-retired residual rows keep showing and clicking one reports `subagent/not-found`. The host now scans the whole library for retired log rows and ships `hiddenIds` via `/config`; the client `patchProjections` subscribes to `sessions.list` and uses the host's own `list.set()` to continuously remove hidden childIds from the in-memory projection (idempotent), so the popover count drops to zero and hides itself.
- **An X at the end of each row in the official subagent list (image 3)**: the official popover rows have no row-level Slot and no `data-session-id`-style DOM anchor, so a stable injection cannot add a per-row delete there. This plugin implements per-row delete inside its own "Agent management" popover (data from `listDescendants`, with explicit ids) and contributes a "Clean all idle" button through `conversation.session.header.actions.subagent.footer`. The in-list X is only an optional, high-risk DOM-injection enhancement and is disabled by default.

## Installation

This package is an npm bundle; its `dsh.bundle.patch` / `cordis.patch.yml` inserts six loader rows at once (self row + five functional plugin rows). Pick one of three ways:

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
- a `v<version>` badge next to each component title in the "Included components" list;
- the new Session Management section in Settings (provided by the reused package);
- the new Session Hub section in Settings: session / workspace / tags / recycle-bin tabs with a three-pane layout and batch actions;
- the new "Agent management" tab in the session header;
- the "Icon Generator" button beside the "Installed plugins" heading, with dual-size preview and one-click `icon.svg` download;
- the `find_dsh_plugins` tool registered for the agent (pure host, no UI button), for finding "the one plugin to install" across the entire DSH plugin ecosystem.

## Layout

```
dsh-plugin-yanyan-toolkit/          umbrella root (no-op halves, only patch and dependencies)
  cordis.patch.yml                 7 insert rows: self + 6 plugins
  lib/index.js, lib/client.js      minimal host / client halves
  locale/{zh,en}.json              Plugins page display metadata
  packages/
    dsh-plugin-yanyan-update/      Plugin Update (custom)
    dsh-plugin-yanyan-session-hub/ Session Hub (custom, incl. recycle bin)
    dsh-plugin-yanyan-subagent/    Subagent Management (custom)
    dsh-plugin-yanyan-icon/        Icon Generator (custom)
    dsh-find-right-plugin/         Find the Right Plugin (self-developed; pure-host tool)
```

All five self-developed subpackages are listed in the root package's `dependencies`; pnpm's hoisted layout lifts them into the profile root `node_modules`, so all six loader row `name`s (self + five functional plugins) resolve.
