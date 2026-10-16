# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `fetchAttempts` (default `3`): a failed fetch is retried with exponential
  backoff before the route is given up on. A 4xx other than 429 is pi.dev
  answering, so it is not retried.

### Fixed

- A round no longer reports every fetch failure as a bare `fetch failed`. The
  whole `cause` chain is rendered (`fetch failed ← connect ETIMEDOUT
  172.67.221.13:443`), which is what identifies the layer that broke — a
  message-only rendering throws away the only useful part of a Node network
  error, whose `cause` is usually an `AggregateError` with one entry per
  resolved address.
- The auto-round and uninstall warnings log the same cause chain instead of
  `%o`-dumping the error object.

## [0.3.0] - 2026-10-16

### Added

- `updateExistingModels` (default `false`): the round also **refreshes records
  the catalog already has** with the fields pi.dev states today. Only pi.dev's
  own fields are applied — a `cost` or capacity it stays silent about keeps the
  catalog's value, so nothing is zeroed by omission — and a record pi.dev has
  moved to another protocol is re-grouped under the new `api`. Records are
  still never removed, and a refresh writes the usual backup and needs the
  usual restart (reported as `catalog ↻N（…）`). It is off by default because
  the add-only merge is what stops a partial pi.dev listing from rewriting your
  models.

  Measured on a real profile (`opencode` / `opencode-go`): 65 records refreshed
  with no protocol moves, then 31 including **7 protocol corrections** — e.g.
  `claude-haiku-5-5` had been stored as `openai-completions` while pi.dev says
  `anthropic-messages` — and `step-5-preview-free`'s 8k context corrected to 1M
  with `maxTokens` 4096 → 65536. A second pass reports no further changes.

### Changed

- Docs: the READMEs cover three host facts that each decided a real debugging
  session — the stable pnpm `allowBuilds` key a `github:` install needs, that
  Node's global `fetch` ignores `http_proxy` (run dsh with
  `NODE_USE_ENV_PROXY=1` on a proxied host), and that `zen` / `inference` are
  two names for one opencode backend. `AGENTS.md` records the measurements, the
  `models`-replaces-catalog rule, and why the proxy stays a host setting.

## [0.2.0] - 2026-10-15

### Changed

- **BREAKING (configuration):** `keepBuiltinOnly` is renamed
  `keepCatalogOnly`. The old name read as "keep only builtins"; the option
  actually keeps the ids that exist *only* in the installed catalog, which the
  written `models` list would otherwise drop. The default is unchanged
  (`true`); a profile that set the old key explicitly must rename it.
- Docs: "catalog leg" / "settings leg" are now "catalog layer" /
  "settings layer", the framing the rest of the documentation already used.
  `README.md` now spells out the three `settingsMode` values, the
  hand-tuning recipe via `modelOverrides`, and why some ids are catalog-only.

## [0.1.0] - 2026-10-14

### Added

- **Initial release.** A dsh Cordis plugin that maintains both layers a model
  must pass through, in one round:
  - **catalog layer** — copies pi.dev records the installed pi-ai catalog is
    missing into `@earendil-works/pi-ai/dist/providers/data/<route>.json`
    (generalising `dsh-opencode-go-models` to any route; no hand-written
    protocol/family table because pi.dev returns catalog-shaped records), with
    atomic writes and a first-modification backup;
  - **settings layer** — `settingsMode: 'unset'` (default) removes the route's
    `llm-pi-ai.providers.<route>.models` override so the enriched catalog serves
    the route; `'mirror'` rewrites the list from pi.dev (dsh-model-sync shape,
    refusing routes with non-empty `modelOverrides`); `'keep'` leaves settings
    alone.
- Scheduled rounds (`intervalMinutes`, `startupDelaySeconds`) plus a manual
  `/pi-ai-sync` command and a `piAiSync` service, both degrade gracefully when
  the optional host services are absent.
- `settingsMode`, `catalogSync`, `managedRoutes`, `refreshTimeoutMs`,
  `syncNotify`, `keepBuiltinOnly` configuration with safe defaults. (Renamed to
  `keepCatalogOnly` after this release.)
- Uninstall restore: catalog backups are rolled back only when no profile still
  references the package, and never over a file a pi-ai upgrade wholly replaced.
- 29 unit tests (`node:test`) and a host-free smoke boot.

### Fixed

- `prepare` script added before the first release: a `github:` install runs
  `prepare`, never `prepublishOnly`, so the package arrived without `lib/`
  (which is gitignored) and `main: lib/index.js` did not resolve. Profiles
  installing from GitHub must allow the build script in `pnpm-workspace.yaml`
  (`allowBuilds`); on pnpm ≥ 11.21 the stable key
  `dsh-pi-ai-sync@git+https://github.com/jiaruihuang/dsh-pi-ai-sync.git`
  survives later pushes, the commit-pinned codeload key does not.

[Unreleased]: https://github.com/jiaruihuang/dsh-pi-ai-sync/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jiaruihuang/dsh-pi-ai-sync/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jiaruihuang/dsh-pi-ai-sync/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jiaruihuang/dsh-pi-ai-sync/releases/tag/v0.1.0
