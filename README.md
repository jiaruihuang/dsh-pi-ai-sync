# dsh-pi-ai-sync

A [dsh](https://github.com/deepseek-ai/deepseek-harness) Cordis plugin that keeps
provider routes in step with the pi.dev gateway by maintaining **both** layers a
model has to pass through:

- the **pi-ai catalog** (`@earendil-works/pi-ai/dist/providers/data/<route>.json`)
  — the "does dsh know this model and which protocol does it speak?" layer, and
- the **settings model list** (`llm-pi-ai.providers.<route>.models`) — the
  "does the model picker offer it?" layer.

It is the fusion of
[`dsh-model-sync`](https://github.com/fan56/dsh-model-sync) (settings seam) and
[`dsh-opencode-go-models`](https://www.npmjs.com/package/dsh-opencode-go-models)
(pi-ai catalog file), with no hand-maintained protocol/family tables: pi.dev's
listing already carries every record in pi-ai catalog shape.

## Why

dsh resolves a configured model's wire protocol as
`route.api ?? catalog[id].api ?? sharedCatalogApi(route)`. On the dsh 0.1.x line
the settings model schema has **no per-model `api` field**, so:

- routes with a single protocol are fine — the route-level api fills the gap;
- a **mixed-protocol** route (`opencode`: anthropic-messages +
  openai-completions + openai-responses + google-generative-ai) has no shared
  api, so any model missing from the installed catalog is rejected outright:
  hand-adding it errors, and a settings-only sync has to drop it.

`dsh-pi-ai-sync` fixes the root cause instead of working around it: it copies
the missing records into the installed catalog, then lets the (now complete)
catalog serve the route.

## How it works

```
one round, per managed route
  1. GET https://pi.dev/api/models/providers/<route>     (catalog-shaped records)
  2. catalog leg  → copy records the installed catalog is missing into
                    dist/providers/data/<route>.json
                    (atomic write + first-modification backup)
                    ⇒ the model becomes base-matching; restart needed
  3. settings leg → reconcile llm-pi-ai.providers.<route>.models
                    (unset by default; mirror/keep optional)
```

Because the catalog is imported into memory at boot, step 2 only takes effect
after a dsh restart — a round that added models reports `restartNeeded`.

## Install

Not on npm yet — install it from GitHub today:

```bash
# newest `main` (what you want while the plugin is still young)
dsh plugin --profile web add github:jiaruihuang/dsh-pi-ai-sync

# a pinned release
dsh plugin --profile web add github:jiaruihuang/dsh-pi-ai-sync#v0.1.0

# or from a local checkout:
dsh plugin --profile web add /path/to/dsh-pi-ai-sync
```

Restart dsh afterwards (bundle-layer change).

### GitHub installs need the build script allowed

A `github:` install runs the package's `prepare` script (never
`prepublishOnly`), because the TypeScript sources are the only thing in the
repository — `lib/` is gitignored. pnpm blocks install-time scripts by default,
so add the key it prints to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  "dsh-pi-ai-sync@git+https://github.com/jiaruihuang/dsh-pi-ai-sync.git": true
```

Use that form, not a bare `dsh-pi-ai-sync: true` (pnpm cannot match a name to a
git source) and not the commit-pinned `…/tar.gz/<sha>` form pnpm's own error
message suggests — the pinned key goes stale on the next push, the `git+https`
key does not. dshmarket's "allow build scripts and retry" button writes both
forms for you.

Integrity note: the tarball your install resolves to is the tag/commit you
asked for, and the build happens on your machine from those sources. Use
`#vX.Y.Z` when you want a reproducible environment.

## Configuration

Edit the `pi-ai-sync` section of your settings document (on the dsh 0.1.x line
that is `~/.dsh/settings.yaml`):

```yaml
pi-ai-sync:
  managedRoutes:
    - opencode
    - opencode-go
  settingsMode: unset
  intervalMinutes: 240
```

| Key | Default | Description |
|---|---|---|
| `managedRoutes` | `[]` | Routes to sync; empty = `opencode`, `opencode-go` |
| `settingsMode` | `unset` | `unset` removes the route's `models` override; `mirror` rewrites it from pi.dev; `keep` leaves settings alone |
| `catalogSync` | `true` | Maintain the installed pi-ai catalog files (the core leg) |
| `intervalMinutes` | `240` | Auto-refresh interval; `0` = startup only |
| `startupDelaySeconds` | `5` | Delay before the first auto round |
| `refreshTimeoutMs` | `120000` | Abort budget for one round's request |
| `syncNotify` | `true` | Log the report when there was something to report |
| `keepBuiltinOnly` | `true` | In `mirror` mode, keep catalog-only ids in the written list |

## Commands and services

- `/pi-ai-sync` — force one round and print the report (registered through the
  shared command registry when the host provides one).
- `piAiSync.syncNow()` — the same round as a service, for UIs.

## Caveats

- **The catalog leg writes into `node_modules`.** That is inherent: the
  installed pi-ai catalog is the only place dsh 0.1.x can learn a protocol for
  a base-less model. Writes are atomic, a first-modification backup is kept,
  and a real uninstall restores it (a pi-ai upgrade that wholly replaces the
  file is left untouched). A pi-ai upgrade wipes the additions; the next round
  re-applies them.
- **Restart to see new models.** Catalog changes are read at boot only.
- **Do not run this beside `dsh-model-sync` on the same routes.** One rewrites
  `models`, the other unsets it. Pick one.
- **`mirror` + `modelOverrides`.** A route with non-empty `modelOverrides` is
  skipped in `mirror` mode (folding/persisting overrides is `dsh-model-sync`'s
  models-store job). `unset` mode is unaffected and is the recommended default.

## Development

```bash
npm install
npm run build   # tsc → lib/
npm run check   # tsc --noEmit
npm test        # node --test (pretest builds)
node scripts/smoke-boot.mjs
```

See [AGENTS.md](./AGENTS.md) for the architecture, the host facts this
implementation relies on, and the roadmap.

## License

MIT.
