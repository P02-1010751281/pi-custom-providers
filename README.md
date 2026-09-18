# custom-providers

pi extension：把订阅型中转站（Command Code / GOAT、SCNet）注册成 pi provider，模型目录随仓库维护，配置词汇全部用 pi 自己的字段。

安装：`pi install git:github.com/P02-1010751281/pi-custom-providers@v0.1.0`（源码 `extensions/custom-providers/`）。本包无 `package.json`（pi 按约定目录 `extensions/` 自动发现），git 安装不依赖 npm；不要再加回。

## 为什么独立成包

- 这些中转站的 `/models` 端点几乎不带元数据（SCNet 只返回 id），参数只能人工整理；原先放在 gitignore 的 `~/.pi/agent/models.json` 里，会漂移，刷新后新模型静默拿到 pi 默认值（128000 上下文 / 16384 输出）。
- pi 要求每个注册模型带 `cost`；缺了会让 `calculateCost()` 在第一次上报用量时抛 `Cannot read properties of undefined (reading 'tiers')`，整轮任务中断。
- 一个厂商常有**两个协议端点**服务同一批 id，而 pi 的文件层表达不了（一个 provider id 里同名的 `model.id` 只能有一份，且 `model.id` 就是请求体的 `model`），所以协议只能按模型选——这正是本扩展要补的那一块。

## 安装与迁移

旧版是单文件 `~/.pi/agent/extensions/subscription-providers.ts`（如果本机还留着，必须先删）：

```bash
rm -f ~/.pi/agent/extensions/subscription-providers.ts
```

**两种安装方式只能选一种**，否则 pi 会同时加载两份、provider 注册两次。本地开发用方式 B：

```bash
pi install git:github.com/P02-1010751281/pi-custom-providers@v0.1.0   # 方式 A
rm -rf ~/.pi/agent/extensions/custom-providers && cp -R extensions/custom-providers ~/.pi/agent/extensions/   # 方式 B，随后 /reload
```

### 从旧版升级（v0.1.0 → v4.0 引擎）

- provider id 由 `codecommand` 改为 **`commandcode`**（域名拼写）。旧键 `providers.codecommand` 仍然被读取（`aliases`），但 pi 会把只在 `models.json` 里声明的 id 也注册成一个 provider，于是选择器里会**多出一个 `codecommand` 条目**。把 `models.json` 里的键改成 `providers.commandcode` 即可消掉。
- `providers.<id>.wire` / `wire.models` 不再被读取（pi 原生 `api` 就是协议）：一个模型要换协议，写模型条目的 `api`。
- `siblingId` / `anthropicBaseUrl` 这两个旧字段已删除；SCNet 的 Anthropic 端点现在是 `apis."anthropic-messages"`。

## Providers

| provider id | 默认协议 | 默认端点 | 其它端点 | 密钥变量 |
|---|---|---|---|---|
| `commandcode` | `openai-completions` | `https://api.commandcode.ai/provider/v1` | `anthropic-messages`: `https://api.commandcode.ai/provider` | `CMD_API_KEY` |
| `scnet` | `openai-completions` | `https://api.scnet.cn/api/llm/v1` | `anthropic-messages`: `https://api.scnet.cn/api/llm/anthropic` | `SCNET_API_KEY` |

SCNet 两条线服务同一批 id（19 个里重叠 18 个），注册成**一个** `scnet`：选择器里只有一条，每个模型带自己的协议。Command Code 的 8 个 Claude id 只走 Anthropic 端点，因此它们的条目自带 `api: "anthropic-messages"`。

### 为什么 Anthropic 线的 baseUrl 要短一截

pi 把 `model.baseUrl` **原样**交给 Anthropic SDK，而 SDK 自己会在后面拼 `/v1/messages`。所以 OpenAI 线的 baseUrl 带 `/v1`，Anthropic 线的不能带（否则路径变成 `/v1/v1/messages`）。实测（2026-09-18）：`POST /provider/v1/messages` 返回 403 `MODEL_NOT_IN_PLAN`（路由存在），`POST /provider/v1/v1/messages` 返回 404「not a registered API route」——旧写法下 codecommand 的 8 个 claude 模型全部打不通。

## 配置：`~/.pi/agent/custom-providers/<id>/`

可选的目录层。没有这个目录时，内置的两个 vendor 行为与「只用 `models.json` 覆盖」完全一致。

```
~/.pi/agent/custom-providers/
├── scnet/
│   ├── provider.json     # 端点表：api / baseUrl / modelsPath / headers / apis（无秘密、无 compat）
│   ├── models.json       # 模型基底表（可省；省了就用内置目录）
│   └── accounts.json     # 凭据（唯一秘密文件；可省，省了提示 /login）
└── my-relay/
    └── provider.json     # 新 vendor 只要这一个文件
```

- 发现 = 扫描子目录，**含可解析 `provider.json`** 的子目录才算一个 vendor；其余忽略（`/custom-providers files` 会列出来）。
- 字段全是 pi 自己的词汇，只有四个是我们加的：`apis`（第二协议端点）、`modelsPath`（发现路径）、`override`（接管 pi 内置 provider id）、`accounts.json`。

### `provider.json`（必需）

```json
{
  "name": "My Relay",
  "api": "openai-completions",
  "baseUrl": "https://relay.example/v1",
  "modelsPath": "/models",
  "headers": {},
  "apis": {
    "anthropic-messages": { "baseUrl": "https://relay.example/anthropic", "modelsPath": "/v1/models" }
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `api` | 是 | 默认协议，取 pi 全部 10 种内置协议之一（别名：`openai`/`chat`、`anthropic`/`messages`、`responses`）。表外的值 → 报告并跳过该 vendor。 |
| `baseUrl` | 是 | 默认端点。 |
| `modelsPath` | 否 | 默认端点列模型的路径；缺省 = 无发现（**不猜** `/models`）。 |
| `headers` | 否 | vendor 级请求头（值支持 pi 的值语法；不写秘密）。 |
| `apis` | 否 | 额外协议端点，键 = pi 的 api 值，值 = `{ baseUrl(必填), modelsPath?, headers? }`。省略 `modelsPath` = 继承 `provider.json.modelsPath`。 |
| `override` | 否 | 允许接管 pi 已知 provider id（如自建 `anthropic` 代理）。不加则跳过并报告。 |

`apiKey` / `authHeader` / `envVar` / `compat` 写在这里会被**报告并忽略**：凭据只属 `accounts.json`，compat 只属模型条目（pi 只认模型级 compat）。

### `models.json`（可选）= 模型基底表

```json
{ "models": [
  { "id": "glm-5.2", "api": "anthropic-messages", "name": "GLM-5.2", "reasoning": true, "input": ["text"],
    "contextWindow": 200000, "maxTokens": 131072,
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
] }
```

字段 = pi 的 `ModelDefinitionSchema` 全部字段（`id`/`name`/`api`/`baseUrl`/`reasoning`/`thinkingLevelMap`/`input`/`cost`/`contextWindow`/`maxTokens`/`samplingParams`/`headers`/`compat`），没有自有字段。也接受纯数组简写。省略 `api` = 默认协议；写了 `apis` 里的协议就自动用该端点的 `baseUrl`。

### `accounts.json`（可选）= 凭据

```json
{ "default": "main",
  "main": { "apiKey": "$SCNET_API_KEY", "authHeader": true },
  "work": { "apiKey": "!pass show scnet/work" } }
```

`default` 是**账号 id 字符串指针**：被指向的账号注册为 `<id>`，其余注册为 `<id>-<name>`（上例 → `scnet` 与 `scnet-work`）。账号**只装认证**（`apiKey` / `authHeader` / `headers`）。

- 没有 `apiKey` 的账号被跳过并报告；非法账号名同理。
- `accounts.json` 不存在 / 为空 / 全无凭据 → `<id>` **照常注册**（不带凭据、模型不进可用快照），`/login <id>`、`--api-key` 或 stored 凭据随时能把它救回来。
- 有账号但 `default` 指针缺失或指向不存在的账号 → 目录 vendor **不注册** `<id>`（其余账号照常）；内置 vendor 回落到内置密钥变量。
- 账号级模型覆盖写 pi 全局 `models.json` 的 `providers.<accountId>`，本扩展不另造一层。
- 同一产品多把 key = 一个目录多个账号；**不同产品/计费 = 不同目录、不同 provider id**（pi 的 `auth.json` 是一 id 一凭据）。

## 配置优先级（4 层，逐字段补丁）

| # | 层 | 粒度 |
|---|---|---|
| 1 | 基底模型表（`catalog.ts` 或 `<id>/models.json`） | 模型 |
| 2 | `provider.json`（默认协议 + 端点 + `apis` + headers） | provider |
| 3 | pi 全局 `models.json` 的 `providers.<id>`（provider 字段 + `models[]` 逐条补丁） | provider + 模型 |
| 4 | pi 全局 `models.json` 的 `modelOverrides[M]` | 模型（pi 自己最后应用） |

每一层都是补丁：写了就赢，没写往下掉。唯一例外是 `baseUrl`，按 pi 原义 `config.baseUrl ?? model.baseUrl` —— 第 3 层的 provider 级 `baseUrl` 只重定向「自己没有端点的模型」。

协议选择只有两步：模型条目写了 `api` 就用它（`baseUrl` 取条目自己的，否则 `apis.<api>.baseUrl`）；没写就用**有效默认协议** = 第 3 层 `providers.<id>.api` ?? `provider.json.api`。落在默认协议上的模型**不带** `api`/`baseUrl`（这样 `providers.<id>.baseUrl` 以后还能重定向它）；不在默认协议上的两者都带，显示名加 ` (协议)` 后缀。

## 命令

| 命令 | 作用 | 写盘 |
|---|---|---|
| `/refresh-custom-models` | 刷新全部 vendor 全部端点的模型列表 | 否 |
| `/custom-providers` | 状态总览（模型数、live/基底、协议分布、新 id、上次错误） | 否 |
| `/custom-providers <id>` | 单 provider 详情：协议分布、账号、校验问题 | 否 |
| `/custom-providers drift` | 与 pi 内置目录的差异（只报不改） | 否 |
| `/custom-providers files` | 扫描结果：目录、三文件、被忽略的目录、校验问题 | 否 |
| `/custom-providers sync <id> [--write]` | 打印「基底 ⊕ 发现 vs `<id>/models.json`」差异；`--write` 才落盘（先留 `.bak`） | 仅 `--write` |

`sync --write` 写的是**基底 ⊕ 发现**，不含第 3/4 层用户覆盖（否则一次 sync 就把用户覆盖烤进基底）；发现里消失的 id 会保留并在摘要里标为「kept」。

## 密钥解析

`accounts.json` 的 `apiKey` 支持 pi 的值语法：`$VAR` / `${VAR}` / `!command` / `$$` / `$!`，以及裸 `UPPER_SNAKE`（视为环境变量名，交给 pi 前会规范化为 `$VAR` —— pi 只插值 `$…`，裸字符串会被当字面量发出去）。发现请求用的凭据顺序与 pi 的请求侧一致：stored（`auth.json` / `--api-key` / `/login`）→ 账号 `apiKey` → 第 3 层 `providers.<id>.apiKey` → 内置密钥变量。启动时读取 `~/.pi/agent/.env` 与 `~/.omp/agent/.env` 补齐环境变量（已存在的不覆盖）。

## 模型能力与目录生成

`extensions/custom-providers/catalog.ts` 是生成物（`node scripts/refresh-catalog.mjs`，先 `--dry-run`）。其中：

- `reasoning` / `input` 的权威是**官方 / pi 内置目录**（同一 id 在 pi 内置各 provider 间多数票 → 厂商能力页 → 旧值）；中转线自己的 `/models` 根本不发能力字段。
- `thinkingLevelMap` 只在 anthropic 协议线上取 pi 内置值（那是 Anthropic 自己的 adaptive-effort 档位，属模型事实）；OpenAI 形线的 effort 词表是网关自定义的，不照搬。
- `maxTokens` / `contextWindow` / `cost` 以代理为准（只报不改：中转线会截断，高报会 400）。

## 测试

```bash
node tests/run-all.mjs
```

10 个用例：`apis-test`（协议选择 / 内置协议表与 pi 注册表一致）、`provider-files-test`（目录扫描与校验、接管边界）、`accounts-test`（账号展开与凭据回落）、`sync-test`（差异、`.bak`、round-trip）、`responses-test`（用 pi 自己的实现验证 `POST <baseUrl>/responses`）、`builtin-test`、`catalog-test`、`pi-native-test`（真 `ModelRuntime`：`registerProvider → refresh → publish`，全程离线）、`smoke`、`loadtest`（pi 真实 loader 加载无错）。测试通过 pi 自己的 jiti loader 加载 TS，`PI_CODING_AGENT_DIR` 指向临时目录，不写 `~/.pi`。
