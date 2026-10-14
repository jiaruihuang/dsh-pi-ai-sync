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
  2. catalog 腿  → 把已安装 catalog 缺失的记录补进
                   dist/providers/data/<route>.json
                   （原子写 + 首次修改前备份）
                   ⇒ 模型变成 base-matching；需重启
  3. settings 腿 → 整理 llm-pi-ai.providers.<route>.models
                   （默认 unset；可选 mirror/keep）
```

catalog 只在 dsh 启动时读进内存，所以第 2 步要**重启**才生效——本轮若补了模型，报告
会带 `restartNeeded`。

## 安装

```bash
npm install dsh-pi-ai-sync
dsh plugin --profile web add dsh-pi-ai-sync
# 或从本地目录：
dsh plugin --profile web add /path/to/dsh-pi-ai-sync
```

装完需重启 dsh（bundle 层变更）。

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
| `catalogSync` | `true` | 维护已安装的 pi-ai catalog 文件（核心腿） |
| `intervalMinutes` | `240` | 自动刷新间隔；`0` = 只跑启动轮 |
| `startupDelaySeconds` | `5` | 第一轮前的延迟 |
| `refreshTimeoutMs` | `120000` | 单轮网络超时 |
| `syncNotify` | `true` | 有内容时把报告写进日志 |
| `keepBuiltinOnly` | `true` | `mirror` 模式下保留 catalog-only 的 id |

## 命令与服务

- `/pi-ai-sync`——强制跑一轮并打印报告（宿主提供命令注册表时自动注册）。
- `piAiSync.syncNow()`——同一轮的服务形式，供 UI 调用。

## 注意事项

- **catalog 腿会写 `node_modules`。** 这是绕不开的：dsh 0.1.x 里，base-less
  模型的协议只能从已安装的 pi-ai catalog 学到。写入是原子的、首次修改前有备份、
  真卸载时会还原（被 pi-ai 升级整体替换过的文件则不动）。pi-ai 升级会覆盖这些新增，
  下一轮会重新补上。
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
