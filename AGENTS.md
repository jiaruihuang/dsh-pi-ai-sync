# AGENTS.md — working on dsh-pi-ai-sync

Guidance for humans and coding agents continuing development in this repo. Read
this before changing the plugin. The README is the user-facing document; this
file is the engineering one.

## What this project is

A dsh Cordis plugin that keeps provider routes in step with the pi.dev gateway
by maintaining **two layers**:

1. **pi-ai catalog leg** — writes missing model records into the installed
   `@earendil-works/pi-ai` catalog JSON. This is what
   `dsh-opencode-go-models` does, generalised to any route.
2. **settings leg** — reconciles `llm-pi-ai.providers.<route>.models`. This is
   what `dsh-model-sync` does.

The rationale is in the README "Why" section. In short: on dsh 0.1.x a
base-less model on a mixed-protocol route cannot be addressed through settings
alone, so the fix has to happen in the catalog.

## Host facts this implementation relies on

These were verified on the development host (`dsh 0.1.5-rc.3`, `pi-ai 0.85.1`).
Re-verify them when bumping the supported dsh line.

- **Catalog files**: `<profiles>/node_modules/@earendil-works/pi-ai/dist/providers/data/<route>.json`,
  a JSON object keyed by **api protocol** → model id → record. The records are
  loaded by `dist/providers/<route>.models.js` via
  `import values from "./data/<route>.json" with { type: "json" }` and
  flattened by `flattenModelCatalog` — **at boot only**. Hence the restart
  requirement. See `src/catalog.ts`.
- **Protocol resolution** (`dsh-llm-pi-ai/lib/index.js`, `resolveRouteModels`):
  `const api = request.api ?? base?.api ?? routeApi`, and
  `routeApi = sharedCatalogApi(defaults)` is `undefined` when the installed
  catalog mixes protocols. A missing api makes `resolveEntry` throw, and
  settings writes validate strictly.
- **Settings model schema** (`dsh-llm-pi-ai/lib/index.js`, `modelFields`): `id`,
  `name`, `contextWindow`, `maxTokens`, `input`, `reasoningEfforts`, `compat`.
  There is **no per-model `api`** — that is the whole reason this plugin exists.
- **Settings seam**: `ctx.settings.register(ns, schema)` → scope with `.get()`
  and `.watch()`; writes via `settings.describe()` (find `ns === 'llm-pi-ai'`,
  read `revision` and raw `user`) then
  `settings.mutate('llm-pi-ai', ops, revision)` with `{ op: 'set'|'unset',
  path: [] }`. Retry once on `error.code === 'SETTINGS_CONFLICT'`. See
  `src/settings.ts`.
- **pi.dev listing**: `GET https://pi.dev/api/models/providers/<route>` returns
  an id-keyed object of catalog-shaped records (including `api`, `baseUrl`,
  `contextWindow`, `maxTokens`, `thinkingLevelMap`, `compat`, `cost`). 404/501
  means the route is absent. See `src/pidev.ts`.
- **Only a real restart reloads the catalog.** A round that added models must
  surface `restartNeeded` (see `RoundReport`).
- **`modelOverrides` + `models` are mutually exclusive** in dsh's validation.
  `unset` mode removes `models` and leaves `modelOverrides` — valid, and the
  overrides then apply on top of the catalog.

## File map

```
src/
  types.ts      structural host interfaces (no dsh type deps) + config type
  pidev.ts      pi.dev fetch + normalization
  catalog.ts    pi-ai catalog discovery, merge, atomic write, backup/restore
  translate.ts  pi.dev record → settings model profile (mirror mode only)
  settings.ts   settings seam: unset / mirror writes, conflict retry
  sync.ts       runRound() orchestration, injected deps, report
  restore.ts    uninstall restore + pluginStillReferenced()
  index.ts      cordis apply(): config schema, lifecycle, command, service
test/           node:test suites (import from lib/, run after pretest build)
scripts/        smoke-boot.mjs
```

`runRound(deps, config)` in `src/sync.ts` is the seam for tests: everything
side-effecting (settings, fetch, catalog directory) is injectable.

## Build, check, test

```bash
npm install        # legacy-peer-deps is set in .npmrc
npm run build      # tsc -p tsconfig.json  → lib/
npm run check      # tsc --noEmit
npm test           # pretest builds, then node --test test/*.test.mjs
node scripts/smoke-boot.mjs
```

Notes:

- Tests import the **compiled** `lib/`, never `src/`, so always run through
  `npm test` (which builds first) or build manually.
- `tsconfig` uses `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`:
  import with `.ts` in `src/`, and tsc emits `.js` specifiers.
- `verbatimModuleSyntax` + `erasableSyntaxOnly`: use `import type` for types, no
  enums / parameter properties.

## Local development against a real dsh

```bash
# 1. install this checkout into a profile
dsh plugin --profile web add /absolute/path/to/dsh-pi-ai-sync

# 2. restart dsh (bundle change), then run a round
#    either wait for the startup round, or use /pi-ai-sync in the UI

# 3. inspect results
#    - settings:  ~/.dsh/settings.yaml, section `pi-ai-sync` and llm-pi-ai.providers.<route>.models
#    - catalog:   <profiles>/node_modules/@earendil-works/pi-ai/dist/providers/data/<route>.json
#    - backups:   <same dir>/<route>.json.pi-ai-sync-backup.json
```

The plugin must **not** be run beside `dsh-model-sync` on the same routes (they
fight over `models`). Disable the other plugin/layer first.

## Conventions

- **Atomic writes + backup.** Never write a catalog file in place; use
  `writeCatalogAtomic` and `ensureBackup` (`src/catalog.ts`). A reader must only
  ever see the old or the new complete file.
- **Add-only catalog merges.** `mergeNewEntries` never modifies or removes
  existing records. Removal/pruning is deliberately out of scope for v0.1.
- **Fail-safe restore.** `restoreCatalogFile` refuses to roll back a file that
  was externally replaced (a pi-ai upgrade). Keep that guard.
- **No dsh type dependencies at runtime.** Host services are consumed through
  the structural interfaces in `src/types.ts`; only `@deepseek-ai/schemastery`
  (`z`) is imported at runtime (for the config schema) and `@deepseek-ai/cordis`
  as a type.
- **Versioning / changelog.** SemVer; update `CHANGELOG.md` (Keep a Changelog
  format) with every user-visible change. Keep `README.md` and
  `README.zh-CN.md` in sync.
- **Tests.** Prefer pure-function tests plus temp-directory tests; inject
  `dataDir` / `fetchEntries` / a fake settings service rather than hitting the
  network or `~/.dsh`.
- **Releasing.** A tag *is* the release; `main` is the development channel.
  Day-to-day a profile installs `github:jiaruihuang/dsh-pi-ai-sync`, so every
  push is live for the author with no version bookkeeping. Publish a version by
  bumping `version`, moving the changelog's `[Unreleased]` entries into a dated
  section, updating the two link definitions at the bottom of `CHANGELOG.md`,
  then `git tag -a vX.Y.Z -m … && git push origin vX.Y.Z`. Consumers pin with
  `github:jiaruihuang/dsh-pi-ai-sync#vX.Y.Z`.

  `lib/` is deliberately **not** committed and there is no `prepare`-less
  fallback: a `github:` install runs `prepare` (see `package.json`), which pnpm
  only allows after the profile lists the stable key
  `dsh-pi-ai-sync@git+https://github.com/jiaruihuang/dsh-pi-ai-sync.git` under
  `allowBuilds`. Do not swap that for the commit-pinned codeload key pnpm's own
  error text suggests — it goes stale on the next push. If installs must work
  with zero profile config, that is the point to move to a Release tarball or
  npm (see the roadmap), not to start committing `lib/`.

## Roadmap / known gaps

### Verified on a real host, not yet fixed (2026-10-14)

Both found while debugging a real dsh profile; both are user-visible on a
proxied network, which is how the development host reaches pi.dev.

- **`src/pidev.ts` ignores the proxy environment.** Node's global `fetch`
  (undici) does **not** honour `http_proxy` / `https_proxy` by default, so the
  round talks to pi.dev directly even when the host has no direct route to it.
  Symptom observed: route `opencode` failed with a bare
  `TypeError: fetch failed` while `opencode-go` succeeded in the same round, and
  three immediate retries from the same shell all returned HTTP 200 / 50 KB —
  i.e. intermittent, network-shaped, not a pi.dev outage. Two candidate fixes:
  set `NODE_USE_ENV_PROXY=1` in the host environment (Node ≥ 24 honours it), or
  give `fetchPiDevEntries` an undici `EnvHttpProxyAgent` / `ProxyAgent` that
  respects `NO_PROXY`. Prefer the code fix: it must not depend on the host's
  env being right.
- **A round loses its failure cause and does not retry.** `errorText()` returns
  `error.message` only, so every fetch failure is reported as `fetch failed` and
  `error.cause` (the socket/TLS reason that identifies *which* layer broke) is
  discarded. There is also no retry inside a round: one transient failure skips
  that route's settings leg entirely. The skip itself is correct and must stay
  (never unset `models` for a route whose listing could not be verified), but it
  should be reported with its cause, and the fetch deserves a bounded
  retry/backoff before the route is given up on.

### Longer term

- **Provider-native `GET /models` union** (dsh-model-sync's
  `providerNativeFetch`): fetch a provider's own listing for routes pi.dev lags
  and union the ids in (additions-only, capacities only when stated). Needs a
  per-route endpoint/auth table; `src/pidev.ts` is the place.
- **`mirror` + `modelOverrides` folding**: currently skipped. Implementing it
  requires an overrides store (dsh-model-sync keeps one under
  `~/.dsh/models-store.json`) so folded values survive future rounds.
- **ETag / 304 revalidation** for pi.dev fetches (dsh-model-sync has it).
- **Per-route configuration** (e.g. different `settingsMode` per route).
- **Catalog pruning** of ids the provider retired (opt-in, off by default).
- **Real-host boot smoke**: `scripts/smoke-boot.mjs` currently validates the
  compiled plugin in-process. A CI smoke that boots a scratch dsh profile with
  the plugin mounted (mocking the pi-ai data dir) would catch cordis inject-gate
  regressions the way dsh-model-sync's smoke does.
- **Cross-version support**: the settings namespace (`pi-ai-sync`) and the
  `settings.register` lifecycle are dsh 0.1.x. A 0.2.x port would move to the
  `Config`-schema / profile-entry-id model.
