# dsh-pi-ai-sync

[简体中文](./README.zh-CN.md) | English

一个 [dsh](https://github.com/deepseek-ai/deepseek-harness) 的 Cordis 插件：通过与
pi.dev 网关同步，同时维护一个模型必须经过的**两层**：

- **pi-ai catalog**（`@earendil-works/pi-ai/dist/providers/data/<route>.json`）——
  「dsh 认不认识这个模型、它说哪种协议」这一层；
- **settings 模型清单**（`llm-pi-ai.providers.<route>.models`）——
  「模型选择器列不列得出来」这一层。

它是 [`dsh-model-sync`](https://github.com/fan56/dsh-model-sync)（settings seam）与
[`dsh-opencode-go-models`](https://www.npmjs.com/package/dsh-opencode-go-models)
（pi-ai catalog 文件）的融合，且不需要维护协议/家族映射表——pi.dev 的清单里每条记录
本来就是 pi-ai catalog 的形状。

## 为什么需要它

dsh 解析一个模型走哪种协议的规则是
`route.api ?? catalog[id].api ?? sharedCatalogApi(route)`。在 dsh 0.1.x 线上，
settings 的模型 schema **没有 per-model 的 `api` 字段**，于是：

- 单一协议的路由没问题——路由级 api 能兜底；
- **混合协议**的路由（`opencode`：anthropic-messages + openai-completions +
  openai-responses + google-generative-ai）没有共用 api，任何不在已安装 catalog
  里的模型都会被直接拒绝：手动加报错，纯 settings 同步只能把它丢掉。

`dsh-pi-ai-sync` 不绕过，而是修根因：把缺失的记录补进已安装的 catalog，再让（现在
完整的）catalog 去服务这条路由。

## 工作原理

```
每轮，对每个受管路由
  1. GET https://pi.dev/api/models/providers/<route>     （catalog 形状的记录）
  2. catalog 层  → 把已安装 catalog 缺失的记录补进
                  dist/providers/data/<route>.json
                  （原子写 + 首次修改前备份）
                  ⇒ 模型变成 base-matching；需重启
  3. settings 层 → 整理 llm-pi-ai.providers.<route>.models
                  （默认 unset；可选 mirror/keep）
```

**层（layer）指数据住在哪**：pi-ai catalog / `llm-pi-ai` settings。一轮同步会按顺序对每个受管路由处理这两层。

catalog 只在 dsh 启动时读进内存，所以第 2 步要**重启**才生效——本轮若补了模型，报告
会带 `restartNeeded`。

## 安装

尚未发布到 npm，目前从 GitHub 安装：

```bash
# 跟随最新的 main（插件早期阶段推荐）
dsh plugin --profile web add github:jiaruihuang/dsh-pi-ai-sync

# 固定到某个发布版本
dsh plugin --profile web add github:jiaruihuang/dsh-pi-ai-sync#v0.1.0

# 或从本地目录：
dsh plugin --profile web add /path/to/dsh-pi-ai-sync
```

装完需重启 dsh（bundle 层变更）。

### GitHub 安装需要放行构建脚本

`github:` 安装会执行包的 `prepare` 脚本（而非 `prepublishOnly`）—— 因为仓库里
只有 TypeScript 源码，`lib/` 是被 gitignore 的编译产物。pnpm 默认拦截安装期脚本，
所以要把 pnpm 打印出来的那把 key 加进 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  "dsh-pi-ai-sync@git+https://github.com/jiaruihuang/dsh-pi-ai-sync.git": true
```

请用这个形式，不要用裸包名 `dsh-pi-ai-sync: true`（pnpm 无法把包名匹配到 git 来源），
也不要用 pnpm 报错信息里建议的 commit 固定形式 `…/tar.gz/<sha>` —— 固定形式在你下次
push 后就失效，而 `git+https` 形式不会。dshmarket 的「允许构建脚本并重试」按钮会把
两种形式都写进去。

完整性说明：安装解析到的 tarball 就是你要的 tag/commit，构建在你的机器上用那份源码
完成。想要可复现的环境就用 `#vX.Y.Z`。

### 走代理的环境

本插件用 Node 全局的 `fetch` 访问 pi.dev，而它**默认不读** `http_proxy` / `https_proxy`。如果所在网络只有走代理才能到 pi.dev，一轮同步就会失败并只报一个 `TypeError: fetch failed`——而且是**偶发**的，因为其它主机往往还能直连。启动 dsh 时加上：

```bash
NODE_USE_ENV_PROXY=1 dsh web          # Node >= 24；可用 node --help | grep proxy 确认
```

（`--use-env-proxy` 是同一个开关的命令行写法。）`NO_PROXY` 两种写法都生效。这**刻意做成宿主设置**：从插件内部读代理环境意味着引入一个 HTTP 代理依赖，而本包目前零运行时依赖。

## 配置

编辑 settings 文档里的 `pi-ai-sync` 段（dsh 0.1.x 线上即 `~/.dsh/settings.yaml`）：

```yaml
pi-ai-sync:
  managedRoutes:
    - opencode
    - opencode-go
  settingsMode: unset
  intervalMinutes: 240
```

| 键 | 默认 | 说明 |
|---|---|---|
| `managedRoutes` | `[]` | 要同步的路由；留空 = `opencode`、`opencode-go` |
| `settingsMode` | `unset` | `unset` 移除路由的 `models` 覆盖；`mirror` 用 pi.dev 重写；`keep` 不动 settings |
| `catalogSync` | `true` | 维护已安装的 pi-ai catalog 文件（核心层） |
| `updateExistingModels` | `false` | 同时用 pi.dev 当前的字段刷新 catalog **已有**的记录 |
| `intervalMinutes` | `240` | 自动刷新间隔；`0` = 只跑启动轮 |
| `startupDelaySeconds` | `5` | 第一轮前的延迟 |
| `refreshTimeoutMs` | `120000` | 单轮网络超时 |
| `syncNotify` | `true` | 有内容时把报告写进日志 |
| `keepCatalogOnly` | `true` | `mirror` 模式下，把"只存在于 catalog 里"的 id 也一并写出 |

### 怎么选 `settingsMode`

`models` 是**整份替换**catalog 的。dsh 的判断是
`configured.length > 0 ? configured : catalog`——一旦列表非空，catalog 自己那份就不再被使用。**这正是三个模式的分界线**：

| 值 | 对 `llm-pi-ai.providers.<route>.models` 做什么 | 什么时候用 |
|---|---|---|
| `unset`（默认） | 删掉这个键；`modelOverrides` 故意保留 | 想让补齐后的 catalog 当唯一事实来源——插件的设计默认 |
| `mirror` | 写出完整列表：pi.dev 中 catalog 兜得住的条目 + catalog-only 的 id（裸 `{ id }`） | 想在 settings 里看得见、能编辑这份列表（= dsh-model-sync 的行为） |
| `keep` | 什么都不做，只跑 catalog 层 | 列表完全由你自己管 |

选之前值得知道的几点：

- `mirror` **每轮都会整份重写**，所以你在它写出的条目上手工改的字段**不会保留**。想微调某个模型，就不要用 `models`——见下。
- `mirror` 对带有非空 `modelOverrides` 的路由**拒写**：dsh 不允许两者并存（*"models already replaces the served catalog"*）。
- `keep` **不等于**"由 catalog 决定"。只要你留着非空的 `models`，服务的仍然是那份列表。
- `keepCatalogOnly`（默认 `true`）就是它把 catalog-only 的模型留在 mirror 列表里；设成 `false` 它们就从选择器里消失。

### 不用 `models` 也能微调模型

当路由**没有** `models` 键时，dsh 用 catalog 生成列表，然后逐条叠加 `modelOverrides`：

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

这样该路由提供**全部** catalog 模型，其中你指定的字段被覆盖。这也正是 `settingsMode: unset` 保留下来的形状。dsh 会严格校验三条：`modelOverrides` 只能写 catalog 已描述的 id；不能与非空 `models` 并存；字段只有 `name`、`contextWindow`、`maxTokens`、`input`、`reasoningEfforts`、`compat`——**没有 `api`、没有 `id`**（id 就是字典的键）。

### 为什么会有 "catalog-only" 的 id

两份列表各走各的：

- **磁盘上的 catalog**——出厂快照 + 历次同步合并进来的 id，而且合并**只增不删**；
- **pi.dev 的实时列表**——会不断增删模型。

所以"catalog 里有、pi.dev 此刻没列"的 id 就叫 catalog-only。它**不是 pi.dev 记录出错，也没有任何东西被删除**：catalog 是"历来见过的并集"，两份列表只要 pi.dev 不再提供某个 id 就会产生差异。实际上绝大多数是促销性质的 `-free` 和实验性的 `-exp` 模型在轮换下架——这个数字自己会动（实测 `opencode` 先是 85 个，二十分钟后 83 个）。

v0.1 故意不做删除：pi.dev 短暂故障或网络不好的一天，**绝不能**把你的模型从选择器里删掉。

### 刷新"已经有了"的记录

catalog 的合并是**只增不改**的：已存在的记录永远不动——这正是"pi.dev 某次给不全时不会重写你的模型"的保障。代价是：pi.dev 后来修正过的参数，会一直停留在旧值上。

`updateExistingModels: true` 补上这个缺口。它**只应用 pi.dev 明确给出的字段**——pi.dev 没提的 `cost` 或容量保持 catalog 原值，不会被"缺省"清零；pi.dev 把某个模型换了协议时，记录会被搬到新的 `api` 分组，而不是继续用旧协议。它始终**不会删除**任何记录。

真机实测（同样的数字也记在 `AGENTS.md` 里）：

| 路由 | 刷新的记录数 | 协议迁移 |
|---|---|---|
| `opencode` | 65（`baseUrl`、`type`、`inputLimits`、compat、cost…） | 0 |
| `opencode-go` | 31（`step-5-preview-free`：8K → 1M 上下文，4096 → 65536 输出） | **7** —— 例如 `claude-haiku-5-5` 从 openai-completions 改为 anthropic-messages |

第二列才是重点：有 7 个模型被上一个插件统一写成了 `openai-completions`，于是 dsh 一直在用错误的协议去请求它们。

`baseUrl` 是唯一需要多看一眼的字段。pi.dev 已把 `opencode` 挪到新的 `inference/*` 域名，而 catalog（和上一个插件）里还是 `zen/*`。两套域名目前**都活着且内容完全相同**——2026-10-15 实测：`/zen/v1/models` 与 `/inference/v1/models` 都返回 200，同样是 86 个 id——所以这里跟随 pi.dev 是安全的。想固定某个地址，就在 `llm-pi-ai` 里给该路由设 `baseURL`：路由级的 `baseURL` 会覆盖单条记录的 `baseUrl`，其它字段照旧跟随 pi.dev。

刷新后的 catalog 和新增一样**需要重启**；报告里显示 `catalog ↻N（…）`；首次刷新同样会写备份。

## 命令与服务

- `/pi-ai-sync`——强制跑一轮并打印报告（宿主提供命令注册表时自动注册）。
- `piAiSync.syncNow()`——同一轮的服务形式，供 UI 调用。

## 注意事项

- **catalog 层会写 `node_modules`。** 这是绕不开的：dsh 0.1.x 里，base-less
  模型的协议只能从已安装的 pi-ai catalog 学到。写入是原子的、首次修改前有备份、
  真卸载时会还原（被 pi-ai 升级整体替换过的文件则不动）。pi-ai 升级会覆盖这些新增，
  下一轮会重新补上。
- **一轮会说明“为什么放弃”。** 拉取失败会按 `fetchAttempts`（默认 3）指数退避重试，之后跳过该路由，并在报告里带上完整的 cause 链——`fetch failed ← connect ETIMEDOUT 172.67.221.13:443`，而不是光秃秃一句 `fetch failed`。4xx（429 除外）是 pi.dev 的答复而非抖动，不会重试。跳过是刻意的：**无法验证列表的路由，settings 一个字都不动。**
- **新模型要重启才看得到。** catalog 只在启动时读。
- **不要和 `dsh-model-sync` 在同一批路由上并用。** 一个重写 `models`，一个删除
  `models`。二选一。
- **`mirror` + `modelOverrides`。** `mirror` 模式会跳过带非空 `modelOverrides`
  的路由（折叠/持久化 override 是 `dsh-model-sync` 的 models-store 职责）。`unset`
  模式不受影响，且是推荐的默认值。

## 开发

```bash
npm install
npm run build   # tsc → lib/
npm run check   # tsc --noEmit
npm test        # node --test（pretest 会先构建）
node scripts/smoke-boot.mjs
```

架构、实现依赖的宿主事实与路线图见 [AGENTS.md](./AGENTS.md)。

## 许可证

MIT。
