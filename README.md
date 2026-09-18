# custom-providers

pi extension：把订阅型中转站（CodeCommand / CodeGoat、SCNet 的 OpenAI 与 Anthropic 两条线）注册成 pi provider，模型目录随仓库维护。安装：`pi install git:github.com/P02-1010751281/pi-custom-providers@v0.1.0`（源码 `extensions/custom-providers/`）。本包无 `package.json`（pi 按约定目录 `extensions/` 自动发现），git 安装不依赖 npm；不要再加回。

## 为什么独立成包

- 这些中转站的 `/models` 端点几乎不带元数据（SCNet 只返回 id），参数只能人工整理；原先放在 gitignore 的 `~/.pi/agent/models.json` 里，会漂移，刷新后新模型静默拿到 pi 默认值（128000 上下文 / 16384 输出）。
- pi 要求每个注册模型带 `cost`；缺了会让 `calculateCost()` 在第一次上报用量时抛 `Cannot read properties of undefined (reading 'tiers')`，整轮任务中断。
- 目录进仓库后，参数有版本、有测试、有刷新脚本，不再依赖本机某个文件。

## 安装与迁移

旧版是单文件 `~/.pi/agent/extensions/subscription-providers.ts`（如果本机还留着，必须先删）：

```bash
rm -f ~/.pi/agent/extensions/subscription-providers.ts
```

**两种安装方式只能选一种**，否则 pi 会同时加载两份、provider 注册两次。

方式 A（推荐，作为 pi 包）：

```bash
pi install git:github.com/P02-1010751281/pi-custom-providers@v0.1.0
```

方式 B（把仓库当源码，本地部署副本）：

```bash
rm -rf ~/.pi/agent/extensions/custom-providers
cp -R extensions/custom-providers ~/.pi/agent/extensions/
# 然后在 pi 里 /reload
```

## Providers

| provider id | 协议 / wire | baseUrl | 订阅密钥 |
|---|---|---|---|
| `codecommand` | `openai-completions`（claude-* 用 `anthropic-messages`） | `https://api.commandcode.ai/provider/v1`（Anthropic 线：`https://api.commandcode.ai/provider`） | `CMD_API_KEY` |
| `scnet` | `wire: "openai"`（默认）或 `"anthropic"` | OpenAI 线 `https://api.scnet.cn/api/llm/v1`；Anthropic 线 `https://api.scnet.cn/api/llm/anthropic` | `SCNET_API_KEY` |

选择器里 SCNet 只有**一个**条目：它两条线服务的是同一批 id（19 个里重叠 18 个），而 pi 的注册、鉴权与模型表都以 provider id 为单位，同名 id 在同一个 provider 里只能存在一份。协议因此按**模型**选，见下一节。

### 为什么 Anthropic 线的 baseUrl 要短一截

pi 把 `model.baseUrl` **原样**交给 Anthropic SDK，而 SDK 自己会在后面拼 `/v1/messages`。所以：

- OpenAI 线的 baseUrl 要带 `/v1`（pi 的 OpenAI 客户端拼的是 `/chat/completions`）；
- Anthropic 线的 baseUrl **不能**带 `/v1`，否则请求路径变成 `/v1/v1/messages`。

CodeCommand 两条线在同一个网关下用不同前缀：OpenAI 线 `/provider/v1`，Anthropic 线 `/provider`。实测（2026-09-18）：`POST /provider/v1/messages` 返回 403 `MODEL_NOT_IN_PLAN`（路由存在），而 `POST /provider/v1/v1/messages` 返回 404「not a registered API route」——即修之前 codecommand 上 8 个 claude 模型全部打不通。

一个 Source 里可以两种 wire 混存（codecommand 就是），差异由 `sources.ts` 的 `anthropicBaseUrl` 声明，注册时按每个模型的 `api` 贴上 `baseUrl`。pi 自带目录里同样的写法：`opencode` 的 OpenAI 线是 `/zen/v1`、Anthropic 线是 `/zen`。`models.json` 里手写的模型级 `baseUrl` 优先级更高，会覆盖这一规则。

密钥解析顺序：`models.json` 的 `apiKey` → 环境变量。扩展启动时会读 `~/.pi/agent/.env` 与 `~/.omp/agent/.env` 补齐环境变量（已存在的变量不覆盖）。`apiKey` 写 UPPER_SNAKE 形式时视为**环境变量名**（与 `$NAME` 等价）；变量未设置时就当没有凭据，不会把变量名当密钥发出去。

### 一个 provider，按模型选协议

SCNet 两条线注册成同一个 `scnet`：每个模型带自己的 wire（`api` + `baseUrl`），协议在 `models.json` 里按模型选。

```json
{
  "providers": {
    "scnet": {
      "apiKey": "$SCNET_API_KEY",
      "wire": { "default": "openai", "models": { "GLM-5.2": "anthropic" } }
    }
  }
}
```

- `wire` 是本扩展自己的键（pi 校验 `models.json` 时放行未知键，实测），取值 `"openai"` / `"anthropic"`，也接受 pi 的 `api` id（`openai-completions` / `anthropic-messages`）。
- 简写：`"wire": "anthropic"` 表示整个 provider 换线；`wire.models` 逐模型覆盖，优先级高于 `wire.default`；模型级 `models[].api` 仍被当作它自己的换线请求（合并前的写法继续有效）。
- 被选中 Anthropic 线的模型会同时带上该线的 `api` 和 `baseUrl`，显示名后缀 `(Anthropic)`（两条线 id 相同，显示名是唯一能区分的地方）。
- 移到某条线的模型如果只存在于另一条线（`MiniMax-M2.5` 只有 OpenAI 线），会留在原线并在 `/custom-providers` 与刷新通知里报告，**不会**被静默挪走。
- provider 级设置仍然是 provider 级的：凭据（`apiKey` / `authHeader`）只有一份，由默认线（`scnet`）提供。某条线要用不同的 key，就把它在 [sources.ts](extensions/custom-providers/sources.ts) 里去掉 `providerId`，回到「一条线 = 一个 provider」的形态。

为什么不能「按请求选协议」：pi 没有 provider 别名机制，provider 的身份就是 id；一个 provider id 里同一个模型 id 只能存在一份（`getModels(provider).find((m) => m.id === id)`，`pi-ai/dist/models.js`），而 `model.id` **就是**发给网关的 `model` 字段。所以协议只能在**配置级**（本节的 `wire`）或 **provider 级**（保留两条线各自成 provider）选择，不存在同一次请求里临时换线的读法。

端点表只有一份：[sources.ts](extensions/custom-providers/sources.ts)。`providerId` 声明哪几条线合并成一个 provider；`scripts/refresh-catalog.mjs` 直接 import 它，所以“注册用的 baseUrl”与“探测用的 baseUrl”不会再各自漂移。

## 模型目录

[catalog.ts](extensions/custom-providers/catalog.ts) 是权威默认值，按**线**分：`codecommand`（70 个）、`scnet`（19 个）、`scnet-anthropic`（18 个）。SCNet 两条线重叠 18 个 id、只有 `MiniMax-M2.5` 是 OpenAI 线独有，所以合并注册后 `scnet` 是 19 个模型（两条线的并集），每个模型落在配置选中的那条线上。运行时合并优先级从低到高：

1. `catalog.ts` — 仓库维护的默认值；
2. `models.json` 同名 id 的字段覆盖，或仅在此处声明的新 id；
3. 实时 `/models` — 只刷新 id 集合、显示名与 `context_length`；**不会**用默认值覆盖已知模型的其他字段；
4. `builtin.ts` — 从 pi 内置目录吸收**白名单** compat 字段（当前只有 `supportsTemperature: false`，用于 Opus 4.7+ 拒非默认温度），并对照内置目录报告漂移。**不会**覆盖 `reasoning` / `input` / `maxTokens` / `contextWindow`：这些以中转站注册表和能力页为准。

实时响应里出现目录中没有的新 id 时，会以保守默认值注册并在通知里列出（`/refresh-custom-models` 或 session 启动时），提示把它补进 `catalog.ts`。反过来，线材里**消失**的 id 不会被删：一次残缺响应不应把可用模型从选择器里拿掉，删除只发生在 `refresh-catalog.mjs`（有 diff 报告、可复核）。

### compat 怎么落到模型上

compat 一律**按模型**组装（`entryFor`），因为 pi 对扩展 provider 会丢掉 provider 级 `compat`：`applyExtension()` 只用扩展给的模型定义重建每个模型，而 `models.json` 的 provider 级 `compat` 是在那之前合并进内置模型表的。两层都得在这里重新贴回去，否则它们只是看起来生效。优先级从低到高：

1. 从 pi 内置目录吸收的白名单（仅 `supportsTemperature: false`）；
2. `sources.ts` 里该线的 `compat`（整条线通用）；
3. `models.json` 中该模型的 `compat`；
4. `models.json` 中该 provider 的 `compat`（最高，与 pi 对内置 provider 的处理一致）。

所以给某条线加 compat（例如 SCNet 要求 `requiresReasoningContentOnAssistantMessages`）应该写进 `models.json` 的 `providers.scnet.compat`，现在会真正生效；协议专属的 compat **不会**从兄弟线继承（OpenAI 的 compat 键不该贴在 Anthropic 线上）。合并成同一个 provider 后这条规则按**线**生效：`providers.scnet.compat` 只贴给默认线上的模型，`providers["scnet-anthropic"].compat`（如果写）只贴给 Anthropic 线上的模型——被移线的模型不会带走默认线的 provider 级 compat。

### pi 原生刷新（`refreshModels`）

`codecommand` 与 `scnet` 都注册了 pi 的 `refreshModels` 钩子（`scnet` 的钩子会刷新它的两条线），因此：

- `pi update --models` 会刷新它们的目录（pi 以 15s 超时、`force` 调用）；
- 凭据变更、以及以 `allowModelNetwork` 启动的场景也会走这条路径；
- 刷新结果通过 `publish({ persist })` 落到 `~/.pi/agent/models-store.json`，下次启动的离线阶段会先恢复这份快照（缓存里的 id/显示名/上下文窗口先回来，再尝试联网）。

`session_start` 里的延迟刷新仍然保留，所以慢网络不会拖慢 TUI。合并后 `models-store.json` 里可能残留旧的 `scnet-anthropic` 条目：现在没有任何读取方（新的持久化只写 `scnet`），无害，不清理也行。

### 刷新目录

```bash
node scripts/refresh-catalog.mjs --dry-run   # 只打印增/删/改动
node scripts/refresh-catalog.mjs             # 重写 catalog.ts
```

脚本探测 `sources.ts` 里声明的每条线：CodeCommand 的 `/models`（`context_length`、`name`、`supported_endpoints`）与官方能力页 `commandcode.ai/docs/reference/cli/models`（reasoning / vision 标志）、以及 SCNet 两条线的 id 集合；`maxTokens`、`cost`、`thinkingLevelMap` 等线材给不出的字段从旧目录继承，新 id 用族默认值并打印出来。

能力页同时以内嵌 RSC 数据与渲染表格两种形式存在，两者不一致时以**内嵌数据**为准，并把分歧打印出来（`claude-sonnet-5` 当时就是这种现象）。能力页用自己的 id 命名（`claude-haiku-4-5`），与注册表 id（`claude-haiku-4-5-20251001`）不同，脚本会对齐两侧再查；查不到的 id 会明确列出（此前是静默沿用旧值）。

## 命令

- `/refresh-custom-models` — 立刻刷新全部 provider（含 SCNet 两条线）的模型列表，并报告失败原因、目录里缺失的新 id，以及无法按 `wire` 配置挪动的模型。
- `/custom-providers` — 显示每个 provider 的模型数、当前是 live 还是 catalog、未入库的新 id，与 pi 内置目录对上的数量，以及最近一次刷新是否失败。失败与“有 live 数据”是两件事：即使进程内还抱着上一次成功抓到的列表，失败也会被报出来。
- `/custom-providers drift` — 逐条列出与 pi 内置目录的差异（`reasoning` / `input` / `maxTokens` / `contextWindow`）。这些差异**只报告不覆盖**：内置值描述的是上游厂商端点，中转站可能四舍五入或另有限制。

## 测试

```bash
node tests/run-all.mjs
```

- `tests/smoke.mjs`：用 pi 自己的 jiti loader 加载扩展，断言两个 provider（`codecommand`、`scnet`）都注册、每个模型都有 `cost` / `contextWindow` / `maxTokens`、命令齐全，并守住 loader 别名（`@earendil-works/pi-ai` 必须跟 pi 真实 loader 一样指向 compat 入口，`dist/index.js` 没有 `getProviders`/`getModels`）；另外守住 wire 与 baseUrl 的搭配（Anthropic 线的模型不得继承以 `/v1` 结尾的 baseUrl），以及 SCNet 只注册一次、合入的是两条线的并集。
- `tests/wire-test.mjs`：合并 provider 与按模型选协议的行为断言——不配 `wire` 时全部模型留在默认线；`wire.models` 只挪指定模型（检查 `api`、该线 `baseUrl`、显示名后缀，以及状态行里的 `[openai 18 (catalog), anthropic 1 (catalog)]` 拆分）；`"wire": "anthropic"` 整线切换，且只存在于另一条线的 `MiniMax-M2.5` 留在原线并被报告；provider 级声明的模型对两条线都可用。
- `tests/catalog-test.mjs`：目录字段不变量，并调用 pi-ai 的 `calculateCost()` 跑一遍全部模型——这是 `cost` 崩溃的回归防线；同时覆盖 `models.json` 覆盖合并、实时合并、`input` 取值过滤、模型对象不被别名共享（不能写坏 `CATALOG`），以及 `models.json` 层：缺文件不算错误、坏 JSON 要报、兄弟线只继承凭据、provider 级 compat 覆盖 model 级、compat 真的贴到了注册出去的每个模型上。
- `tests/builtin-test.mjs`：内置目录可读、归一化匹配、吸收白名单（仅 `supportsTemperature`、仅 Anthropic 线）、不把无效的 provider 级选项/omp 专有字段传给 pi，以及 `refreshModels` 的离线快照 / 联网持久化 / 线材失败 / 无凭据四条路径。
- `tests/pi-native-test.mjs`：用 pi 自己的 `ModelRuntime` 跑端到端 `registerProvider → refresh → publish`，断言 `pi update --models` 走的就是这条路径，并验证：(a) 离线阶段先恢复持久化快照，(b) 刷新结果会写入 `models-store.json`（含 Anthropic 线正确的 baseUrl），(c) **pi 在每次 `registerProvider` 之后会以 `allowNetwork:false` 再跑一轮 `refreshModels`**（`registerProvider` 结尾的 `void this.refresh({allowNetwork:false})`），没有进程内 live 快照时这轮会把刚拿到的 live 值降级回 catalog。全程打桩 `fetch` + 内存 store，不写 `~/.pi`。
- `tests/loadtest.mjs`：用 pi 真正的扩展发现器 `discoverAndLoadExtensions()` 加载本仓库，断言恰好 1 个扩展、0 错误。

测试会把 `PI_CODING_AGENT_DIR` 指向临时目录，所以不会读你真实的 `~/.pi/agent/models.json` / `.env`（否则断言会随本机配置变化）。

`PI_PKG=/path/to/@earendil-works/pi-coding-agent` 可在 pi 不在全局 npm root 时指定安装位置。

## 本次修正的模型参数（对照 provider 自己的注册表，2026-09-18）

旧 `models.json` 的 `contextWindow` 与 CodeCommand 实际 served 值不一致，且缺 `cost`：

- `gpt-5.4` / `gpt-5.5`：1050000 → **400000**；`gpt-5.3-codex`：272000 → **400000**。
- `Qwen/Qwen3.6-Plus`：262144 → **200000**；`Qwen/Qwen3.8-27B`：1000000 → **262144**。
- `MiniMaxAI/MiniMax-M3`：512000 → **1000000**；`nvidia/nemotron-3-ultra-550b-a55b`：131072 → **1000000**。
- `google/gemini-3.x-flash*`：1048576 → **1000000**；`zai-org/GLM-5` / `GLM-5.1`：204800 → **200000**。
- `moonshotai/Kimi-K2.5` / `K2.6` / `K2.7-Code`：262144 → **256000**。
- 补齐了 23 个只在实时注册表里、旧缓存没有的模型（`claude-sonnet-4-6`、`gpt-5.6-*`、`meta/muse-spark-1.x`、`stepfun/Step-3.5-Flash` 等）。
- 所有模型补上 `cost`（订阅线无按 token 计价，取 0），修掉 `reading 'tiers'` 崩溃。
- SCNet 两条线补齐到实时 id 集合（OpenAI 19、Anthropic 18；`MiniMax-M2.5` 仅 OpenAI 线），`DeepSeek-V4-Flash-0731` 的 `maxTokens` 从等于上下文的 1048576 改回 384000。

未能从线材拿到的 `maxTokens` 与 `thinkingLevelMap` 沿用既有值/族默认值，属于保守估计，不是 provider 声明值。

### 待确认

- **计划限制（2026-09-18 实测）**：本机的 CodeCommand 账号对 `claude-haiku-4-5-20251001` / `claude-sonnet-5` / `claude-opus-5` 全部返回 403 `MODEL_NOT_IN_PLAN`（"available in Pro and above plans or extra on demand usage"），OpenAI 线部分模型返回 `insufficient credits`。因此下面两条**无法在本机实测定案**，需要升级计划或开按量付费后才能测。
- `claude-sonnet-5`：三个来源冲突——能力页内嵌数据 `vision=false`、能力页渲染表格 `vision=true`、上游 Anthropic 目录 `vision=true`。本目录取 `input: ["text"]`（与 `scripts/refresh-catalog.mjs` 读的内嵌数据一致），未实测；如需定型请用一次图片输入实测。能力页本身还挂着已下线的 `gpt-6-astra`、旧 id `claude-haiku-4-5`，只能当弱证据（详见 `.codestable/attention.md`）。
- `claude-haiku-4-5-20251001` 的 `reasoning` 由 `true` 改为 **`false`**：能力页对 Haiku 4.5 不标 Reasoning，而先前因能力页键名是 `claude-haiku-4-5`（无日期后缀）导致查不到、静默沿用了上游 Anthropic 的值。键名已归一化修复；如果实测发现 Haiku 确实支持 thinking，把这一行的 `reasoning` 改回 `true` 并补回 `thinkingLevelMap` 即可。
- `~/.pi/agent/models.json` 里仍有一条 `claude-haiku-4-5`（无日期后缀）不在实时注册表中，作为用户覆盖层被注册，所以 `/custom-providers` 会显示 codecommand 比 `catalog.ts` 多 1 个。该文件是用户配置，仓库不改写；如需清理请自行删除。
- 原先挂在 `scnet-anthropic` 上的 `disableStrictTools: true` 与 `compat: { replayUnsignedThinking: true }` 已删：它们是 **omp 的字段**（来自 `~/.omp/agent/models.yml`），在 pi 里不存在——provider 级 `compat` 被 pi 丢弃，`disableStrictTools` 无任何读取点。SCNet 的 Anthropic 线本来就不开 strict tools（pi 对自定义 Anthropic provider 的 `supportsStrictTools` 默认 false），所以行为不变。若该线真的拒收重放的空签名 thinking，pi 的原生开关是模型级 `compat.allowEmptySignature`，可通过 `models.json` 加——但那需要实测依据，不在此臆断。

## 目录结构

```
extensions/custom-providers/
├── types.ts     # 手写：共享类型（CatalogModel / Source / LiveModelRow）
├── sources.ts   # 手写：端点表（唯一真相，生成器也 import 它）
├── config.ts    # 手写：models.json 层（只读）+ 兄弟线继承规则
├── env.ts       # 手写：.env 读取（扩展与脚本共用，避免解析分叉）
├── catalog.ts   # 生成：纯数据（import type 自 types.ts）
├── builtin.ts   # 手写：pi 内置目录交叉校验 + compat 白名单吸收
└── index.ts     # 手写：分层合并、注册、refreshModels、命令
scripts/refresh-catalog.mjs
tests/{smoke,catalog-test,builtin-test,pi-native-test,wire-test,loadtest,harness,run-all}.mjs
.codestable/     # CodeStable 项目骨架
```
