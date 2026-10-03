# custom-providers

给 pi 加上你自己的 LLM 网关（中转站、聚合站、自建代理）：**一个目录 = 一个 provider**，模型表由你提供或联网发现，配置只用 pi 自己的字段。

- 一个厂商的两个协议端点（OpenAI 线 + Anthropic 线）注册成**一个** provider —— pi 的模型 id 在 provider 内必须唯一，所以协议只能按**模型**选，这正是本包要补的那一块。
- 模型参数（`contextWindow`/`maxTokens`/`cost`/`reasoning`…）写在你自己的 `<id>/models.json`，或由 `/models` 发现生成；仓库不附带任何厂商数据。
- 凭据只放 `<id>/accounts.json`，支持环境变量、keyring、密码库、加密文件（都能用 `!command` 接）。
- 只有一个命令：`/providers`（查看 / init / sync / rescan）。

本包无 `package.json`，pi 按约定目录 `extensions/` 自动发现，git 安装不依赖 npm。

> 导航：[安装](#安装) · [快速开始](#快速开始) · [为什么独立成包](#为什么独立成包) · [迁移](#迁移) · [Providers](#providers) · [配置](#配置) · [配置优先级](#配置优先级4-层逐字段补丁) · [命令](#命令) · [密钥解析](#密钥解析) ·
 [模型能力与模型表](#模型能力与模型表) · [故障排查](#故障排查) · [测试](#测试)

## 安装

```bash
pi install ssh://forgejo@git.lentech.site/C02-1010751281/pi-custom-providers.git@v0.5.3
```

GitHub 镜像把 host 换成 `git:github.com/P02-1010751281/pi-custom-providers`。版本历史见 [CHANGELOG.md](CHANGELOG.md)；升级前建议看一眼下面的「迁移」。

**两种安装方式只能选一种**，否则 pi 会同时加载两份、provider 注册两次。日常用方式 A；本地改代码用方式 B（改完随后 `/reload`）：

```bash
pi install ssh://forgejo@git.lentech.site/C02-1010751281/pi-custom-providers.git@v0.5.3                      # 方式 A
rm -rf ~/.pi/agent/extensions/custom-providers && cp -R extensions/custom-providers ~/.pi/agent/extensions/   # 方式 B
```

## 快速开始

1. **写端点声明** —— `/providers init my-relay --url https://relay.example/v1 --api openai-completions --models-path /models`
   （有 UI 时走向导，缺什么问什么；`--key` 可以顺手把凭据写进 `accounts.json`）
2. **给模型** —— `/providers sync my-relay` 抓 `/models` 生成一份 `models.json`，或手写这个文件把参数补齐（发现只给 id/名字/上下文，能力字段得自己写）
3. **用** —— `/providers status` 看注册结果；模型随后就能在 pi 的模型选择器里选
4. **手改过文件之后** —— `/providers rescan my-relay` 让当前会话看见（新目录、手改的 `provider.json`/`models.json`/`accounts.json`、删掉的目录）。只有**扩展代码**变了才需要 pi 的 `/reload`

配置长什么样、字段怎么写，见下面的「配置」一节；升级到 v0.5.0 及以后要先做哪几件事，见「从 v0.4.1 升级」。

## 为什么独立成包

- 这些中转站的 `/models` 端点几乎不带元数据（SCNet 只返回 id），参数只能人工整理；原先放在 gitignore 的 `~/.pi/agent/models.json` 里，会漂移，刷新后新模型静默拿到 pi 默认值（128000 上下文 / 16384 输出）。
- pi 要求每个注册模型带 `cost`；缺了会让 `calculateCost()` 在第一次上报用量时抛 `Cannot read properties of undefined (reading 'tiers')`，整轮任务中断。
- 一个厂商常有**两个协议端点**服务同一批 id，而 pi 的文件层表达不了（一个 provider id 里同名的 `model.id` 只能有一份，且 `model.id` 就是请求体的 `model`），所以协议只能按模型选——这正是本扩展要补的那一块。

## 迁移

### 从 v0.4.1 升级（v0.5.0：命令面与「模型的家」）

- **命令改名**：`/custom-providers` 与 `/refresh-custom-models` 合并为单一 **`/providers`**（动词表驱动）；`drift` 不再是命令，并进 `status`（概览给计数、`status <id>` 给明细）。任何不匹配的动词/旗标都回 `Usage:`，不再静默忽略（旧版打字错的动词会被当成 provider id 回答）。
- **出厂层删除**：不再有内置 vendor、内置默认账号、`envVar` 兜底。以前靠出厂默认拿凭据的目录（如 `scnet`、`commandcode`）升级后必须**自备 `accounts.json`**，否则该 provider 无凭据——症状是 pi 侧「not registered」，而不是报错。
- **第 3 层不再提供模型内容**：模型只有一个家 = `<id>/models.json`（`sync`/发现写它）。`providers.<id>.models[]` 现在**不被读取**（pi 对扩展注册的 id 也只校验、不应用这个数组），写了会在 `/providers` 报告里点名；
  - **加模型**写进模型表，**改已注册模型**（`name`/`maxTokens`/`contextWindow`/`compat`）用第 4 层 `modelOverrides[M]`。
- **手改文件后**用 `/providers rescan` 让会话看见（新目录、手改的 `provider.json`/`models.json`/`accounts.json`、删掉的目录）；只有**扩展代码**变了才用 pi 的 `/reload`。

### 从 v0.3.0 升级（v0.4.0：不再带模型表）

- 仓库不再带模型表。**已经写了 `<id>/models.json` 的机器不受影响**；只有 `provider.json`、没写过模型表的机器升级后该 provider 会**暂时 0 模型**，直到联网发现成功（发现会自动补 id/名字/上下文）或你补一份 `models.json`。
- `/custom-providers sync <id> --write`（v0.4.0 当时的命令名；
  现在是 `/providers sync <id>`）可用发现结果生成一份，但它写的是**发现的原始事实**：发现不发能力字段、也**不推断 `api`**，所以 Command Code 的 Claude 类 id 要自己补 `api: "anthropic-messages"`（见 Providers 一节），否则会被打到默认的 OpenAI 端点。
- 出厂 vendor 的模型参数（`cost` / `maxTokens` / `reasoning` 等）不再由仓库提供；要固定下来就写进自己的 `models.json`。

### 从旧版升级（v0.1.0 → v4.0 引擎）

- 先删掉更早的单文件版本（如果本机还留着，不删会和本包同时加载）：`rm -f ~/.pi/agent/extensions/subscription-providers.ts`
- provider id 由 `codecommand` 改为 **`commandcode`**（域名拼写）。**旧写法 `providers.codecommand`（或 `codegoat`）已不再被读取**：pi 只按注册 id 解析 provider 块，本包不比它多读一份。
  旧块还会被 pi 当成另一个「只在 `models.json` 里声明」的 provider 注册进选择器（模型为空）。把键改成 `providers.commandcode` 即可。
- 一个模型要换协议，写模型条目的 `api`。
- `siblingId` / `anthropicBaseUrl` 这两个旧字段已删除；SCNet 的 Anthropic 端点现在是 `apis."anthropic-messages"`。

## Providers

下表是**本机（owner）`~/.pi/agent/custom-providers/` 当前的目录**，只是示例——仓库不附带任何 vendor，新装的扩展里一个都没有（见下节）。

| provider id | 默认协议 | 默认端点 | 其它端点 | 密钥变量 |
|---|---|---|---|---|
| `commandcode` | `openai-completions` | `https://api.commandcode.ai/provider/v1` | `anthropic-messages`: `https://api.commandcode.ai/provider` | `CMD_API_KEY` |
| `scnet` | `openai-completions` | `https://api.scnet.cn/api/llm/v1` | `anthropic-messages`: `https://api.scnet.cn/api/llm/anthropic` | `SCNET_API_KEY` |

SCNet 两条线服务同一批 id（19 个里重叠 18 个），注册成**一个** `scnet`：选择器里只有一条，每个模型带自己的协议。Command Code 的 Claude id 只走 Anthropic 端点，因此它们在 `models.json` 里的条目要自带 `api: "anthropic-messages"`。

### 为什么 Anthropic 线的 baseUrl 要短一截

pi 把 `model.baseUrl` **原样**交给 Anthropic SDK，而 SDK 自己会在后面拼 `/v1/messages`。所以 OpenAI 线的 baseUrl 带 `/v1`，Anthropic 线的不能带（否则路径变成 `/v1/v1/messages`）。

实测（2026-09-18）：`POST /provider/v1/messages` 返回 403 `MODEL_NOT_IN_PLAN`（路由存在），`POST /provider/v1/v1/messages` 返回 404「not a registered API route」——旧写法下 codecommand 的 8 个 claude 模型全部打不通。

## 配置

目录是 provider 的**唯一来源**：没有 `provider.json` 的目录不算 vendor，没有目录就没有这个 provider。**仓库不带任何出厂 vendor**（v0.5.0 删除了 `sources.ts`/`DEFAULTS`）：没有「内置 id」，也没有「目录 replace 内置」这回事。

**仓库不含模型表**：新装机器先跑 `/providers init <id> --url … --api …`（有 UI 时是向导，会问 id/端点/协议/发现路径，可直接填 key）写出端点声明，再自己放 `models.json`，或跑 `/providers sync <id>` 用实时发现生成一份（发现不推断协议：走非默认协议的 id 要自己补 `api`）。

```
~/.pi/agent/custom-providers/
├── scnet/
│   ├── provider.json     # 端点表：api / baseUrl / modelsPath / headers / apis（无秘密、无 compat）
│   ├── models.json       # 模型基底表（可省；省了就没有模型，直到发现填上）
│   └── accounts.json     # 凭据（唯一秘密文件；可省）
└── my-relay/
    └── provider.json     # 新 vendor 只要这一个文件
```

- 发现 = 扫描子目录，**含可解析 `provider.json`** 的子目录才算一个 vendor；其余忽略（`/providers files` 会列出来）。
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

`apiKey` / `authHeader` / `compat` / `models` / `modelOverrides` 写在这里会被**报告并忽略**，消息会指明它们该去哪：凭据只属 `accounts.json`；`compat` 是模型字段、`modelOverrides` 是逐条模型补丁，都属模型条目；
`models` 整张表属本目录的 `models.json`（`sync` 是它唯一的写出口）。

pi 全局 `models.json` 的 `providers.<id>` 与 `modelOverrides` 是**补丁层**（见分层表 3/4），不是第二个模型表之家。`oauth` 不在支持范围（报告后忽略）。

### `models.json`（可选）= 模型基底表

```json
{ "models": [
  { "id": "glm-5.2", "api": "anthropic-messages", "name": "GLM-5.2", "reasoning": true, "input": ["text"],
    "contextWindow": 200000, "maxTokens": 131072,
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
] }
```

字段 = pi 的 `ModelDefinitionSchema` 全部字段（`id`/`name`/`api`/`baseUrl`/`reasoning`/`thinkingLevelMap`/`input`/`inputLimits`/`cost`/`promptCache`/`contextWindow`/`maxTokens`/
`samplingParams`/`headers`/`compat`），没有自有字段；`cost` 里的 `tiers` 等 pi 认识的其它键原样带过。

也接受纯数组简写。省略 `api` = 默认协议；写了 `apis` 里的协议就自动用该端点的 `baseUrl`。

`compat` 另有一条检查：pi 的请求构造器**各读自己那一份键**（实测 `anthropic-messages` 读 13 个、`openai-completions` 读 27 个、`google-*` 一个都不读），写了目标协议不读的键 pi 照样收下、然后静默丢掉。
本包用 pi 的读键表点名这类键（`status` 里的 `compat key "X" has no effect on <api>`），`modelOverrides[M].compat` 这一层也一并看。

`type`（pi 扩展侧的 chat/image/classifier，`ModelDefinitionSchema` 里没有）不在这里：本包只注册 chat 模型，写了会被报告而不是猜。

### `accounts.json`（可选）= 凭据

```json
{ "default": "main",
  "main": { "apiKey": "$SCNET_API_KEY", "authHeader": true },
  "work": { "apiKey": "!pass show scnet/work" } }
```

**凭据文件就叫 `accounts.json`**（`extensions/custom-providers/credentials.ts` 是读写它的模块名，不是另一个文件名；`accounts.json` 只出现在 `<id>/` 目录里，不写进 `provider.json`，也不写 pi 全局的 `auth.json`）。一个 provider 的所有账号都在这一个文件里。

`default` 是**账号 id 字符串指针**：被指向的账号注册为 `<id>`，其余注册为 `<id>-<name>`（上例 → `scnet` 与 `scnet-work`）。账号**只装认证**（`apiKey` / `authHeader` / `headers`）。

- 没有 `apiKey` 的账号被跳过并报告；非法账号名同理。
- **账号 id 撞车会被跳过并报告**：`<id>-<name>` 若已被另一个 provider 占用（另一个目录的 id、或 pi 内置 provider id），该账号不注册，其余账号与 `<id>` 不受影响。
  例：已有目录 `demo-work` 时，`demo` 的 `work` 账号注册不上（pi 按 id 合并，不检查就会静默并进 `demo-work`）。注意用户自己写在 `providers` 里的 `<id>-<name>` 不算撞车——那正是该账号的配置块。
- `accounts.json` 不存在 / 为空 / 全无凭据 → `<id>` **照常注册**（不带凭据、模型不进可用快照），`/login <id>`、`--api-key` 或 stored 凭据随时能把它救回来。
- 有账号但 `default` 指针缺失或指向不存在的账号 → 目录 vendor **不注册** `<id>`（其余账号照常）。
- 账号级模型覆盖写 pi 全局 `models.json` 的 `providers.<accountId>`，本扩展不另造一层。
- 同一产品多把 key = 一个目录多个账号；**不同产品/计费 = 不同目录、不同 provider id**（pi 的 `auth.json` 是一 id 一凭据）。

## 配置优先级（4 层，逐字段补丁）

| # | 层 | 粒度 |
|---|---|---|
| 1 | 基底模型表（`<id>/models.json`） | 模型 |
| 2 | `provider.json`（默认协议 + 端点 + `apis` + headers） | provider |
| 3 | pi 全局 `models.json` 的 `providers.<id>`（provider 字段；`models[]` 不是模型的家） | provider |
| 4 | pi 全局 `models.json` 的 `modelOverrides[M]` | 模型（pi 自己最后应用） |

每一层都是补丁：写了就赢，没写往下掉。唯一例外是 `baseUrl`，按 pi 原义 `config.baseUrl ?? model.baseUrl` —— 第 3 层的 provider 级 `baseUrl` 只重定向「自己没有端点的模型」。

协议选择只有两步：模型条目写了 `api` 就用它（`baseUrl` 取条目自己的，否则 `apis.<api>.baseUrl`）；没写就用**有效默认协议** = 第 3 层 `providers.<id>.api` ?? `provider.json.api`。
落在默认协议上的模型**不带** `api`/`baseUrl`（这样 `providers.<id>.baseUrl` 以后还能重定向它）；不在默认协议上的两者都带，显示名加 ` (协议)` 后缀。

### 第 3 层对本扩展 provider 的现实（2026-10-02 实测 pi，`provider-composer.js`）

pi 在**注册时**就用它自己内置的模型表校验用户写的 `providers.<id>` 块，而本扩展的 provider 在 pi 侧没有内置基底（除非 `override` 了某个内置 id），所以：

- 块里**只有 `api`** 不够：pi 报 `must specify "baseUrl", "headers", "compat", "modelOverrides", or "models"` 并拒该 provider。`api` 要和 `baseUrl` 一起写才能翻转默认协议。
- 块里写 `models[]` 条目会被 pi 当成**新建自定义模型**校验：
  每条得能拿到 `api` 与 `baseUrl`——条目自己带，或同块给 provider 级 `api`+`baseUrl`（否则 `no "api" specified` / `"baseUrl" is required when defining custom models`，pi 拒掉**整个 provider**，不只是那条目）。
  - pi 读这个数组**只校验、不应用**：实测对扩展注册的 id，`models[]` 条目（哪怕合法、哪怕本扩展注册了 0 个模型）**不会**进模型表，`modelOverrides[M]` **会**（只有无人注册的 config-only id 两者都生效）。
- **模型内容只有一个家 = `<id>/models.json`**（`sync` 写它、发现喂它），所以本包**不读**第 3 层的 `models[]`：写了不会生效，命令里会点名
  （`providers.<id>.models[] is not read for a provider this extension registers (pi only validates it); models live in <id>/models.json and a per-model tweak belongs in modelOverrides`）。

本扩展会把这些被 pi 拒掉的块**在调用 pi 之前**报出来（含上面三句 pi 原文），一个坏块不会连带带走后面的 provider。

同一条道理适用于**没有目录的 key**：`providers` 里如果有一个 id 既不是这里的目录（含账号 id `<id>-<name>`）、也不是 pi 内置 provider，pi 会把它当 config-only provider 自己注册，而本扩展**永远不会读它的块** —— 别名旧 key、打错的 id 都落在这一类，
命令里会点名（`providers.<key>: no directory for this id … nothing here reads this block`），不会静默无效。

## 命令

动词表 + 每动词旗标表驱动解析；不匹配一律回 `Usage:`（文案由表生成）。`/providers` 是唯一命令。

| 动词 | 作用 | 写盘 |
|---|---|---|
| `/providers [<id>]` | 总览，或单个 provider 详情（协议分布、账号、校验问题、与 pi 内置目录的差异明细） | 否 |
| `/providers files` | 扫描结果：每个目录的 id、来源、模型数、账号，被忽略的目录，文件校验问题 | 否 |
| `/providers init [<id>]` | 有 UI 走向导（问缺的部分，key 直接收但会警告明文）；无 UI 必须给 `--url`/`--api`。写 `provider.json`，给了 key 且 `accounts.json` 不存在时写它 | `provider.json`、`accounts.json` |
| `/providers sync [<id>] [--dry-run] [--prune]` | 联网抓 `/models` → 逐端点跳过失败/空答 → 写基底表；省略 id = 全部 vendor；`--prune` 必须带 id | `<id>/models.json` |
| `/providers rescan [<id>] [--dry-run]` | 重扫目录 + 用**新快照**重新注册（拾取手改的文件、新目录，并撤销已删目录）；永不写盘 | 否 |

`init` 的旗标：`--url <u> --api <a> [--models-path <p>] [--key <v>] [--force]`。

`sync` 写的是**基底 ⊕ 发现**，不含第 3/4 层用户覆盖（否则一次 sync 就把用户覆盖烤进基底）；发现里消失的 id 默认保留并在摘要里标为「kept」，加 `--prune` 才真删（仅当该 vendor 本轮**所有可发现端点都成功且非空**才算「消失」，任一失败/空答则跳过该端点并点名，全部失败则不写盘）。
写完提示 `run /providers rescan [<id>]` —— 盘变了不等于会话变了。

## 密钥解析

`accounts.json` 的 `apiKey` 支持 pi 的值语法：`$VAR` / `${VAR}` / `!command` / `$$` / `$!`，以及裸 `UPPER_SNAKE`（视为环境变量名，交给 pi 前会规范化为 `$VAR` —— pi 只插值 `$…`，裸字符串会被当字面量发出去）。

发现请求用的凭据顺序与 pi 的请求侧一致：stored（`auth.json` / `--api-key` / `/login`）→ 账号 `apiKey` → 第 3 层 `providers.<id>.apiKey`。启动时读取 `~/.pi/agent/.env` 与 `~/.omp/agent/.env` 补齐环境变量（已存在的不覆盖）。

`!command` 就是给秘密后端留的插座——本插件不绑定任何后端，任何能把 key 打到 stdout 的命令都行：

| 方式 | `apiKey` 写法 | 备注 |
|---|---|---|
| 直接写 | `"sk-…"` | 单机最省事；`accounts.json` 必须 gitignore + `chmod 600` |
| 环境变量 | `"$SCNET_API_KEY"` | key 放自己的 `~/.pi/agent/.env`（该文件须在 `.gitignore` 里） |
| 系统 keyring | `"!secret-tool lookup service scnet account main"` | GNOME `secret-tool` / KDE `kwallet-query` |
| 密码库 | `"!keepassxc-cli show -q -s -a password ~/secrets.kdbx pi/scnet"` | 也可 `"!pass show scnet/work"`、`"!op read op://vault/item/credential"` |
| 加密文件 | `"!gpg --batch --decrypt ~/.pi/secrets/scnet.gpg"` | `age` / `sops` 同理，能打印 key 即可 |

base64 没有原生的值形式（pi 的语法里没有 base64），要内联就把它接进 `!command`。这种命令要**按 POSIX sh 写**——它跑在 pi 的 shell 里（见下）：

```json
{ "main": { "apiKey": "!printf %s 'c2st-…base64…' | openssl base64 -d -A" } }
```

- `openssl base64 -d -A`：Linux / macOS / Windows(Git Bash) 都有 `openssl`，`-A` 表示单行输出，最省心。
- `base64 -d`：Linux ✓、Windows 的 Git Bash ✓；macOS 自带的 `base64` 是 BSD 版，解码头是 `-D`（新版也收 `-d`），拿不准就用上一行。
- 更省事的做法是不内联：配置前先把 base64 解出来，写进 `.env` 用 `$VAR`，或直接写明 + `chmod 600`。

`!command` 在发现刷新（本扩展）和请求（pi）时都会执行：10s 超时、stderr 被吞、非零退出 = 拿不到 key；pi 侧结果进程内缓存，**轮换 key 后需重启 pi**。

它跑在 **pi 的 shell** 里：Linux/macOS 上是 `sh -c`（Node 的默认 shell；Debian/Ubuntu 上就是 dash），Windows 上是 pi 找到的 Git Bash（没装 Git Bash 才回落平台的 `cmd.exe`）——本插件用 pi 同一个 `getShellConfig()` 起命令，
所以刷新时与真正请求时看到的是同一个 shell，命令按 **POSIX sh** 写（Git Bash 也兼容 sh，但 `[[ ]]`/`<<<` 在 dash 上不成立）。

无人值守取密总需要本机已有可自动解开的本钱（keyring 登录态 / 无口令私钥 / agent 缓存），它防的是**误提交与误备份**，不是本机失陷。

**凭据永远不进仓库**（私有仓库、镜像仓库同理）：`accounts.json` 与 `.env` 属用户层，仓库里只该出现 `provider.json` / `models.json`。别人装本插件用的是自己的 `~/.pi/agent/custom-providers/<id>/accounts.json`，与本项目互不相干。

## 模型能力与模型表

仓库**不带模型表**（v0.4.0 起）：基底 = 你的 `<id>/models.json`，没有它则该 provider 暂时没有模型，等发现或你补表。因此：

- `reasoning` / `input` / `thinkingLevelMap` / `maxTokens` / `contextWindow` / `cost`（含 `tiers`）/ `samplingParams` / `inputLimits` / `promptCache` 都以 **`models.json` 里写的为准**；
  实时 `/models` 从不生成能力字段（它基本不发）。
  - 字段形状照 pi 的 `ModelDefinitionSchema`（`id` 必填）：
    - `input` = `text`/`image`；`thinkingLevelMap` 的键是 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，值是字符串或 `null`。
    - `cost` = `{input, output, cacheRead, cacheWrite, tiers:[{inputTokensAbove, …同四项}]}`；`promptCache` = `{short, long}`。
    - `inputLimits` = `{maxRequestBytes, images:{resize:{maxWidth, maxHeight, maxBytes, jpegQuality}, maxPerMessage, maxPerRequest}}`。
- 只有 `/models` **新引入**的 id（基底表没有）才走 `convention.ts` 的惯例兜底：① 同族继承——从基底表里第一条同族条目继承 `reasoning` 与 `thinkingLevelMap`，**与线无关**（同表同族条目是这个网关的策展事实，不是别家目录的拷贝）；
  - ② 已知可推理家族名单（`CONVENTION_FAMILIES`，精确匹配族名）——这一路没有同族可继承，`{xhigh, max}` 是凭空合成的，所以只在 `anthropic-messages` 线补。两步都不命中则保持 `reasoning: false`（不猜）。兜底会进启动报告（`new model(s) not in models.json`），不静默写盘。
- `/providers status`（`drift` 自 v0.5.0 起不再是命令）把注册表与 pi 内置目录对一遍（`reasoning`/`input` 按多数票）；它**只报不改**，也不写回 `models.json`。

## 故障排查

| 症状 | 先看哪里 |
|---|---|
| pi 的模型选择器里没有这个 provider | `/providers files` 看目录有没有被忽略（必须能解析 `provider.json`）；`/providers status` 看 error 行 |
| provider 在，但一个模型都没有 | 该目录没有 `models.json`，发现也没成功：`/providers sync <id>`，或手写模型表 |
| 请求报 401 / `No API key found for "<id>"` | 凭据：`<id>/accounts.json` 存在吗；`$VAR` 在 `~/.pi/agent/.env` 里有值吗（未设置的变量**静默**解析不出，不会报错） |
| 模型数突然变少 | 不会因为上游返回空列表而变（空答案按「跳过」处理，不删不报）；看 `status` 的 drift 计数与「消失 id」段 |
| 手改了 `models.json` 但会话里没变 | 盘变了不等于会话变了：`/providers rescan <id>`；只有**扩展代码**变了才 `/reload` |
| 同一个 provider 出现两次 | 目录副本与 `pi install` 包安装同时存在，二选一（见「安装」） |
| `/providers` 回了 `Usage:` | 动词或旗标写错了（文案由动词表生成）；不带参数是总览 |

## 测试

两个命令：

```bash
node tests/run-all.mjs      # 25 个套件，每套件独立进程 + 独立临时 PI_CODING_AGENT_DIR
node tests/graph-test.mjs   # 模块依赖图：无环、全可达、每个相对 import 都存在、叶子无本地依赖
```

覆盖：命令面与 `Usage:` 解析、预报告（对着真 `ModelRuntime` 注册）、目录/账号/凭据、发现与消失、pi 字段表与 compat 读键表、文档 schema 字段守卫、真 loader 加载。模型表来自 `tests/fixtures/models.json`；
测试通过 pi 自己的 jiti loader 加载 TS，不写 `~/.pi`。每个套件负责什么，看文件头的注释。

## 许可

MIT，见 `LICENSE`。
