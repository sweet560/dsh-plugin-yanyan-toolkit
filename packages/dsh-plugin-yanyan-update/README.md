# Yanyan Toolkit - Plugin Update

The first plugin of the "Yanyan Toolkit" aggregate bundle. It places a "Check updates" button beside the "Installed" group heading on the DSH plugins settings page, checks npm-installed and local `link:` / `file:` directory plugins for newer versions, and offers a per-row update action.

## Features

- Registry plugins: read the installed version and compare it with the npm registry `latest` version.
- Local plugins (`link:` / `file:`): for git repositories, fetch and compare local HEAD with `origin/<branch>`; without `.git`, honestly report "local source, cannot auto-update".
- GitHub sources are best-effort; when they cannot be compared they are reported as "update GitHub sources on the plugin detail page" without blocking other checks.
- Updatable rows prefer the official `pluginManager` service `updateBundle` (built-in automatic restore on failure/cancel, never removes first); when that API is absent it falls back to an over-install and only uses a two-phase remove+install when `already-installed`, with a hard guarantee of restoring the original version. Local git sources run `git fetch` + `git merge --ff-only`.
- This package and the aggregate package are never updated; official `@deepseek-ai/*` packages are skipped.

## Constraints

- Pure JavaScript (ESM host half + `__ModuleLoader__` client half); no React, TypeScript, JSX, build tools, or third-party dependencies.
- UI copy is Chinese; no emoji in code or docs.
- All same-origin loopback routes pass the `ctx.connection.requestRejection` admission gate.
- Updates take effect after a page refresh or a DSH restart.

## Tests

```
node --test test/*.test.mjs
```
