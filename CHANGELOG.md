# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-14

### Added

- **Initial release.** A dsh Cordis plugin that maintains both layers a model
  must pass through, in one round:
  - **catalog leg** — copies pi.dev records the installed pi-ai catalog is
    missing into `@earendil-works/pi-ai/dist/providers/data/<route>.json`
    (generalising `dsh-opencode-go-models` to any route; no hand-written
    protocol/family table because pi.dev returns catalog-shaped records), with
    atomic writes and a first-modification backup;
  - **settings leg** — `settingsMode: 'unset'` (default) removes the route's
    `llm-pi-ai.providers.<route>.models` override so the enriched catalog serves
    the route; `'mirror'` rewrites the list from pi.dev (dsh-model-sync shape,
    refusing routes with non-empty `modelOverrides`); `'keep'` leaves settings
    alone.
- Scheduled rounds (`intervalMinutes`, `startupDelaySeconds`) plus a manual
  `/pi-ai-sync` command and a `piAiSync` service, both degrade gracefully when
  the optional host services are absent.
- `settingsMode`, `catalogSync`, `managedRoutes`, `refreshTimeoutMs`,
  `syncNotify`, `keepBuiltinOnly` configuration with safe defaults.
- Uninstall restore: catalog backups are rolled back only when no profile still
  references the package, and never over a file a pi-ai upgrade wholly replaced.
- 29 unit tests (`node:test`) and a host-free smoke boot.

[Unreleased]: https://github.com/fan56/dsh-pi-ai-sync/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fan56/dsh-pi-ai-sync/releases/tag/v0.1.0
