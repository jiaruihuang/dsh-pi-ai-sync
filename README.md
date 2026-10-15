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
  2. catalog layer  → copy records the installed catalog is missing into
                       dist/providers/data/<route>.json
                       (atomic write + first-modification backup)
                       ⇒ the model becomes base-matching; restart needed
  3. settings layer → reconcile llm-pi-ai.providers.<route>.models
                       (unset by default; mirror/keep optional)
```

A **layer** is where the data lives (the pi-ai catalog / the `llm-pi-ai`
settings); a round touches both, in that order, for every managed route.

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

### Behind a proxy

This plugin reaches pi.dev with Node's global `fetch`, which **ignores**
`http_proxy` / `https_proxy` unless Node is told to read them. On a network
that only reaches pi.dev through a proxy, a round fails with a bare
`TypeError: fetch failed` — and only sometimes, because the direct route is
usually still there for other hosts. Start dsh with:

```bash
NODE_USE_ENV_PROXY=1 dsh web          # Node >= 24; see: node --help | grep proxy
```

(`--use-env-proxy` is the same switch as a CLI flag.) `NO_PROXY` is honoured
either way. This is a host setting on purpose: reading the environment from
inside the plugin would mean taking on an HTTP-proxy dependency, and this
package has none.

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
| `catalogSync` | `true` | Maintain the installed pi-ai catalog files (the core layer) |
| `updateExistingModels` | `false` | Also refresh records the catalog **already has** with the fields pi.dev states today |
| `intervalMinutes` | `240` | Auto-refresh interval; `0` = startup only |
| `startupDelaySeconds` | `5` | Delay before the first auto round |
| `refreshTimeoutMs` | `120000` | Abort budget for one round's request |
| `syncNotify` | `true` | Log the report when there was something to report |
| `keepCatalogOnly` | `true` | In `mirror` mode, also write ids that exist only in the catalog |

### Choosing `settingsMode`

`models` **replaces** the served catalog. dsh resolves
`configured.length > 0 ? configured : catalog`, so a non-empty list stops the
catalog's own list from being used at all. That is what makes the three modes
different things:

| Value | What it does to `llm-pi-ai.providers.<route>.models` | Use it when |
|---|---|---|
| `unset` (default) | removes the key; `modelOverrides` is deliberately left alone | you want the enriched catalog to be the single source of truth — the plugin's design |
| `mirror` | writes the full list: pi.dev entries the catalog can back, plus catalog-only ids as bare `{ id }` | you want the list visible and editable in settings (dsh-model-sync's behaviour) |
| `keep` | nothing — the catalog layer only | you manage the list entirely yourself |

Notes worth knowing before you pick:

- `mirror` **rewrites the whole list every round**, so hand-edited fields on it
  do not survive. To hand-tune a model, leave `models` out — see below.
- `mirror` refuses a route with non-empty `modelOverrides`: dsh rejects the two
  together ("models already replaces the served catalog").
- `keep` does **not** mean "the catalog decides". If you leave a non-empty
  `models` list, that list is still what serves the route.
- `keepCatalogOnly` (default `true`) is what holds catalog-only models in the
  mirror list; `false` drops them from the picker.

### Hand-tuning a model without `models`

When a route has **no** `models` key, dsh builds the list from the catalog and
then applies `modelOverrides` per id:

```yaml
llm-pi-ai:
  providers:
    opencode:
      apiKeyEnv: OPENCODE_API_KEY
      baseURL: https://opencode.ai/zen/v1
      modelOverrides:
        step-5-preview-free:
          maxTokens: 65536
```

The route then offers every catalog model, with your values layered on. This is
the shape `settingsMode: unset` leaves in place. dsh enforces three rules:
`modelOverrides` may only name ids the installed catalog describes, it cannot
sit beside a non-empty `models`, and its fields are `name`,
`contextWindow`, `maxTokens`, `input`, `reasoningEfforts`, `compat` — no
`api` and no `id` (the id is the dict key).

### Why some ids are "catalog-only"

Two lists move independently:

- the **catalog on disk** — the factory snapshot plus every id past rounds
  merged in, and merges are add-only;
- **pi.dev's live listing** — which gains and drops models over time.

An id the catalog has and pi.dev currently does not list is *catalog-only*. It
is not a pi.dev error and nothing was deleted: the catalog is the union of
everything ever seen, so the two differ whenever pi.dev stops offering an id.
In practice that is mostly the promo `-free` and experimental `-exp` models,
which rotate out — and the count moves on its own (observed: `opencode` at 85
ids, then 83, twenty minutes later).

Removal is deliberately out of scope for v0.1: a partial pi.dev outage or a
bad network day must never delete models from your picker.

### Refreshing records you already have

The catalog merge is **add-only**: a record that is already there is never
touched, which is what keeps a partial pi.dev listing from rewriting your
models. The cost is that a model whose parameters pi.dev later corrected keeps
the stale values forever.

`updateExistingModels: true` closes that gap. Only the fields pi.dev actually
states are applied — a `cost` or capacity pi.dev stays silent about keeps the
catalog's value, so nothing is zeroed out by omission — and a record pi.dev has
moved to another protocol is re-grouped under the new `api` instead of leaving
dsh speaking the old one. It is still never a removal.

Measured on a real profile (see `AGENTS.md` for the same numbers):

| Route | Records refreshed | Protocol moves |
|---|---|---|
| `opencode` | 65 (baseUrl, `type`, `inputLimits`, compat, cost…) | 0 |
| `opencode-go` | 31 (`step-5-preview-free`: 8k → 1M context, 4096 → 65536 maxTokens) | **7** — e.g. `claude-haiku-5-5` openai-completions → anthropic-messages |

That second column is the point: 7 models had been flattened to
`openai-completions` by an earlier plugin, so dsh was addressing them with the
wrong wire protocol.

`baseUrl` is the one field to look at twice. pi.dev moved `opencode` to its new
`inference/*` host where the catalog (and that earlier plugin) had
`zen/*`. Both families are live and identical — measured 2026-10-15,
`/zen/v1/models` and `/inference/v1/models` both answer 200 with the same 86
ids — so following pi.dev here is safe today. To pin an endpoint instead, set
`baseURL` on the route in `llm-pi-ai`: a route-level `baseURL` overrides a
record's `baseUrl` while everything else still tracks pi.dev.

A refreshed catalog needs the same restart as an added one, the report shows
`catalog ↻N（…）`, and the first refresh writes the usual backup.

## Commands and services

- `/pi-ai-sync` — force one round and print the report (registered through the
  shared command registry when the host provides one).
- `piAiSync.syncNow()` — the same round as a service, for UIs.

## Caveats

- **The catalog layer writes into `node_modules`.** That is inherent: the
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
