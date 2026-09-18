# 通用多线 Provider 引擎 — 设计方案（v4.0）

- 日期：2026-09-18（v4.0：端点词汇回归 pi 原生；凭据与计费归 provider；覆盖链压到 4 层。v1–v3.3 的历史见文末「版本沿革」）
- 状态：待人工确认
- 仓库：`pi-custom-providers`（master，0 commit）

**一句话**：文件层只说 pi 自己的话（`api` / `baseUrl` / `headers` / `compat` / `models[]` / `modelOverrides`），我们只做 pi 做不了的四件事 —— 目录扫描、模型发现、per-model 端点的复刻、多账号展开。

## v3.3 → v4.0 变化

| 项 | v3.3 | v4.0 | 原因 |
|---|---|---|---|
| 端点词汇 | 自有 `wires` / `wire` + 7 级选线链 | **pi 原生 `api` + `baseUrl`**（默认端点）+ 可选 `apis.<api>`（第二协议端点）；模型选端点 = **`models[].api`** | 用户裁决：`wire` 就是 API 配置，且与 pi 的 `api` 语义错位；pi 自己就是这么表达的（`ModelDefinitionSchema` 允许 per-model `api`+`baseUrl`，内置 `opencode.json` 每个模型都写 `api`+`baseUrl`）。自有名词只有一个 `apis`，键就是 pi 的 api 值 |
| 凭据归属 | 账号带 `wire`；「跨线不同 key = 两个账号各钉一条线」 | **账号只装认证**（`apiKey`/`authHeader`/`headers`）；**provider 边界 = 产品/计费边界**：不同产品/计费/端点集合就是不同 provider（pi 内置 `opencode`「Zen」与 `opencode-go`「Go」即此形，两者共用同一个 `OPENCODE_API_KEY`） | 用户裁决：凭据与线无关；账号只管认证 |
| 账号字段 | `apiKey`/`envVar`/`authHeader`/`headers`/`wire`/`models` | 删 `wire` / `models`；账号级模型覆盖写进 pi 全局 `models.json` 的 `providers.<accountId>`（pi 原生层，我们本来就读） | 少一个自有概念，多一个原生层 |
| 覆盖链 | L0–L8 八层 + C 层复刻 | **4 层**（基底 → `provider.json` → pi 全局 `providers.<id>`/`models[]` → pi 的 `modelOverrides`），逐字段补丁 | 用户裁决：层级太多、看着乱；顺带把「条目级整条替换 vs 增量」的争论消掉 —— pi 自己的 `modelOverrides` 就是补丁语义 |
| legacy `providers.<id>.wire` / `wire.models` | 保留兼容 | **删除**（出现即报告） | 实测用户本机 `models.json` 两个 provider 块都没有 `wire` 键，兼容层无用户 |
| 命令 | `wires <id>` 单列 | 并入 `custom-providers <id>` | 线表就是端点表，不值得一条命令 |
| **compat 位置** | `provider.json.compat` + `apis.<n>.compat`（vendor/端点级） | **全部移到模型条目**（`<id>/models.json` 的 `compat`）；provider/端点里出现即报告并忽略。**只保留** pi 全局 `models.json` 的 provider 级 `compat`（那是 pi 自己的字段，我们只复刻） | 用户裁决：兼容性是模型属性。pi 自己也是这么做的（`applyExtension()` 丢弃 provider 级 compat；内置 `opencode.json` 的 compat 全在模型条目上） |
| **支持的协议** | 只列 `openai-completions` / `openai-responses` / `anthropic-messages` | **pi `BUILTIN_APIS` 全部 10 种**（`pi-ai/dist/compat.js:108`）；表外的值报告 + 跳过 | 用户裁决：至少覆盖 pi 支持的全部类型。注册与请求本来就由 pi 的 api 注册表提供实现，我们只做校验与发现 |
| **账号 `default`** | `"default": { …凭据对象… }`（default 自己就是一个账号） | `"default": "<账号id>"`（**字符串指针**），被指向的账号注册为 base id；其余账号照常注册 | 用户裁决；顺便让「只想要附加账号」的情形不需伪造一个 default 账号 |
| 历史 | 4 张版本变化表置顶 | 压成文末一段 | 变化史不是设计 |

被删掉的自有概念（全部 → 用 pi 原生字段替代）：`wires`、`wire`（provider 级与账号级）、`siblingId`、`anthropicBaseUrl`、`wireSelectionFor`（7 级链）、L0–L8 表、`ModelTableFile.models[].wire`。

## 1. 目标 / 非目标

**做**：用户可自定义 provider（一个或多个协议端点 + 默认端点 + 按模型指定端点）；**pi 支持的全部 10 种内置协议**都能用；配置词汇与 pi 一致；模型自动发现（手填优先）；每 vendor 一个目录三文件；多账号；每个行为都显式可查。

**不做**（硬理由）：

- 按请求切协议 —— 一个 provider id 内 `model.id` 唯一且就是请求体的 `model`（`pi-ai/dist/api/anthropic-messages.js`、`openai-completions.js` 均为 `model: model.id`），pi 没有独立 slug 字段。
- **pi 级** provider 别名 —— pi 无此机制，provider 身份就是 id（`model-resolver.js` 的 alias 只对模型 id 的无日期写法有意义）。我们的 `aliases` 不是 pi 别名，只是「读哪些 `models.json` 键来配置这个 provider」（§8）。
- 写 pi 全局 `models.json` —— 用户文件，只读。
- 用 JSON 表达 `oauth` / `streamSimple` / `refreshModels` —— 需要函数，报告而非静默丢弃。
- 账号自动轮换 —— 与 pi 的凭据解析优先级冲突。
- 项目级 provider 文件（作用域歧义）、`vendors.json` 索引（第二个真相源）。
- 同一 provider 内同名 id 的两条协议线并存 —— 见「不做」第一条；要么选一条，要么开两个 provider id。

## 2. pi 侧契约（设计前提，均已读源码核实）

### 2.1 模型合成与覆盖

- `models[]` 条目（`ModelDefinitionSchema`，`pi-coding-agent/dist/core/model-config.js:139`）**允许** per-model `api` + `baseUrl`；`modelOverrides`（同文件 `:154`）**不允许**（`applyModelOverride` 也不处理这两个字段）⇒ 换协议只能靠 `models[]`，pi 原生做得到，我们只需复刻（§4）。
- `modelOverrides` 是最高层，且作用在扩展注册的模型**之上**（`composeModelProvider` 的 `getModels()` = `applyExtension(...)` → `applyModelOverride`）⇒ 用户用它覆盖我们，我们不必实现，也不该与之打架。
- `models.json` 的 provider 面（`ProviderConfigSchema`，`:169`）：`name` / `baseUrl` / `api` / `apiKey` / `oauth` / `headers` / `compat` / `authHeader` / `models[]` / `modelOverrides`。schema 类型严格但**放行未知键**：类型错（`apiKey: 123`、`providers: "nope"`）会整份丢弃文件并报 `Invalid models.json schema`（所有 provider 一起消失）。
- **坑**：pi 只认**模型级** compat。`applyExtension()`（`provider-composer.js`）用扩展给的模型定义重建每个模型，provider 级 `compat` 被丢弃；`models.json` 的 provider 级 `compat` 在这之前被 `applyModelsJson()` 合并到内置模型表，随后也被同一重建行为覆盖。⇒ 对扩展注册的 provider，`models.json` 的 `compat` 与 `models[]` 必须由我们重新贴一遍。

### 2.2 注册即抛（我们必须预校验，不交给 pi）

模型无可解析 `api`、模型无可解析 `baseUrl`、`streamSimple` 无 provider 级 `api`、完全无鉴权方式（`no authentication method configured`）。⇒ 我们注册前先自校，不能把这个抛错留给 pi。注意与 §2.3 的分界：这四种是「已经决定注册、但配置不全」（我们不允许发生），§2.3 是「没凭据但**照常注册**」。

### 2.3 无凭据 ≠ 注册报错（本机实测）

真实后果：① 该 provider 的模型不进可用快照（picker 不可见，`getAvailableSnapshot()` = 0）；② 请求时 `authHeader: true` → `No API key found for "<id>"`（内部原文 `authHeader requires a resolved API key`）；③ `authHeader: false` → 静默不带 `Authorization`（网关 401）。

⇒ 我们的选择是「**无凭据也注册**（凭据缺失只报告 + 模型不进快照），绝不自造凭据」（v4.0 早期写的「无凭据不注册」**是错的**）：`/login` 的候选列表就是 `modelRuntime.getProviders()` —— **只列已注册的 provider**（`interactive-mode.js` `getLoginProviderOptions()`），不注册就拝死了 stored 凭据（`auth.json` / `--api-key` / `/login`）这条正道；而 `composeApiKeyAuth` 在无继承凭据、无 `apiKey` 时会自动提供一个“输入 API key”的 login（这是 pi 自带的能力，我们的 provider 免费拿到）。

**`authHeader` 精确语义（源码）**：解析成功后 `withConfiguredAuth()` 追加 `Authorization: Bearer <resolved apiKey>`，**且要求 key 可解析**（无 key 则抛，上层转述为 `No API key found for "<id>"`）；不写 = pi 只把 `apiKey` 交给各协议 SDK 自己用（anthropic → `x-api-key`）。

**可用性判定是 provider 级，与 `api` 无关（本轮实证）**：`ModelRuntime.updateModelSnapshot()` 用 `snapshot.configuredProviders`（一个 provider id 集合）过滤 `this.models.getModels()`，该集合在 `runAvailabilityRefresh()` 里由逐 provider 的 `checkAuth` / `configuredRequestAuthStatus(config, extension)` 算出。⇒ 上文三条后果对全部 10 种 `api` 同形，不存在「某协议例外」。

### 2.4 请求侧（pi 自己做，我们只传值）

- 凭据优先级：**stored（`auth.json` / `--api-key` / `/login`）> 扩展 `apiKey` > `models.json` `apiKey`**。
- 值语法由 pi 在请求时解析：`$VAR` / `${VAR}` / `!command` / `$$` / `$!`；解析器 `resolve-config-value.js` **未导出**，我们只能在发现请求里自实现。**裸 `UPPER_SNAKE` 是我们自己的糖：传给 pi 前一律规范化成 `$VAR`**（pi 不认裸变量名，原样传会把变量名当 token 发出去）。
- `headers` 合并顺序（`resolveCompatibilityRequestConfig`）：`{...config.headers, ...extension.headers}`（扩展胜）→ 再被 `modelOverrides[M].headers` 与 `config.models[M].headers` 压过。⇒ 我们发的 headers 是「低于用户 models.json 模型级、高于 provider 级配置」。
- `authHeader`：扩展 > config；`oauth`：扩展 > base。把值**原样**交给 `registerProvider`，自己解析只为自己的发现请求。
- `readStoredCredential(providerId, authPath?)` **已导出**，是扩展优先用 stored 凭据的正道。
- **两条路径的凭据顺序必须一致**（否则探活与真实请求会不一致）：stored → 扩展（= 账号）`apiKey` → pi 全局 `models.json` `apiKey`。
- `resolveConfigValue` 实测：**裸字符串一律当字面量**（只有一个 literal part），只有 `$VAR` / `${VAR}` 才走 env，且 `ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/`（`dist/core/resolve-config-value.js:17,96`）。⇒ 我们的「裸 `UPPER_SNAKE` 规范化为 `$VAR`」不是糖，是**必需**，否则变量名会被当 token 发出去。
- 该模块**不可 import**：`pi-coding-agent/package.json` 的 `exports` 只有 `.` / `./rpc-entry` / `./client` / `./experimental/plugin`，裸深路径报 `ERR_PACKAGE_PATH_NOT_EXPORTED`（实测）。`resolveConfigValue` / `getConfigValueEnvVarNames` / `resolveHeaders` 都是内部导出 ⇒ 发现侧解析只能自实现（§6）。
- **baseUrl 拼接逐协议实测**（`pi-ai/dist/api/*.js`）：

| api | 行为 | 实据 |
|---|---|---|
| `anthropic-messages` | `baseURL = model.baseUrl`，SDK 自拼 `/v1/messages` ⇒ baseUrl **不能带 `/v1`** | `anthropic-messages.js:697,712,733`（实测 `…/v1/v1/messages` → 404） |
| `openai-completions` | `baseURL = model.baseUrl`，SDK 自拼 `/chat/completions` | `openai-completions.js:575` |
| `openai-responses` | `baseURL = model.baseUrl`，拼 `<baseUrl>/responses` | `openai-responses.js:203` |
| `openai-codex-responses` | 以 `/codex/responses` 结尾 → 原样；以 `/codex` 结尾 → `+/responses`；否则 `+ /codex/responses` | `openai-codex-responses.js:455-462` |
| `azure-openai-responses` | Azure 主机（`*.openai.azure.com` / `*.cognitiveservices.azure.com` / `*.ai.azure.com`）且路径为空/`/openai`/`/openai/v1/responses` → **强制改写为 `/openai/v1`**，下游 SDK 再拼 `/deployments/<model>/…` + `?api-version=`。**`model.baseUrl` 只是第三来源**：`options.azureBaseUrl` > `AZURE_OPENAI_BASE_URL` > `AZURE_OPENAI_RESOURCE_NAME`（构造）> `model.baseUrl` | `azure-openai-responses.js:136-181` |
| `google-generative-ai` | `httpOptions.baseUrl = model.baseUrl`（SDK 自拼版本/方法路径） | `google-generative-ai.js:266-267` |
| `google-vertex` | `resolveCustomBaseUrl(model.baseUrl)` + `ResourceScope.COLLECTION`；baseUrl 自带版本段时行为不同 | `google-vertex.js:293-320` |
| `mistral-conversations` | `new URL(baseUrl)` 补尾 `/` 后 `new URL("v1/chat/completions", baseUrl)` ⇒ baseUrl 只到根 | `mistral-conversations.js:159-161` |
| `bedrock-converse-stream` | **不是路径拼接**：`model.baseUrl` 就是显式 endpoint（`config.endpoint = model.baseUrl`），region 从 hostname 推 | `bedrock-converse-stream.js:52-58,965-985` |
| `pi-messages` | 去掉尾 `/` 后拼 `/messages`（`${baseUrl}/messages`） | `pi-messages.js:250` |

### 2.5 发现侧

`refreshModels(context)` 提供 `credential`（仅 `type === "api_key"` 时有 `key`）、`stored.models`、`publish({persist|update})`、`allowNetwork`、`force`、`signal`；返回值**替换**扩展注册的模型列表。**坑**：`ModelRuntime.registerProvider` 结尾是 `void this.refresh({ allowNetwork: false })`，每次重注册都跟一轮**离线**刷新 —— 只存在内存里的实时结果会被降级回 catalog，除非保留进程内快照（优先级：内存 memo > `models-store.json` > 基底），且该离线轮不得抹掉已记录的错误。

### 2.6 内置目录的样板（我们的形态就是它的形态）

`pi-ai/dist/providers/opencode.js` 与 `opencode-go.js`：两个 provider id（同一厂商的不同计费产品）、同一个 `OPENCODE_API_KEY`、各自一份模型表；provider 的 `api` 是**协议 → 实现**的 map，每个模型条目自带 `api` + `baseUrl`（`providers/data/opencode.json`，例如 `claude-fable-5`: `api: "anthropic-messages"`, `baseUrl: "https://opencode.ai/zen"`）。这就是「一个 provider 多协议」的官方形状。

## 3. 配置层

```
~/.pi/agent/custom-providers/
├── scnet/
│   ├── provider.json     # 端点表：api/端点/发现路径/headers（无秘密、无 compat）
│   ├── models.json       # 模型基底表（可省）
│   └── accounts.json     # 凭据（唯一秘密文件；没有 → 用基底表 + 无凭据注册，提示 /login）
└── commandcode/
    └── …
```

- 发现 = 扫描 `custom-providers/` 的子目录，含**可解析 `provider.json`** 的子目录即一个 vendor；其余忽略（`files` 命令列出）。
- 纯 JSON，无注释/尾逗号。**扩展默认不写任何用户文件**（唯一例外 `sync --write`，§9）。
- **fail-closed（文件级）**：`models.json` / `accounts.json` 解析失败 → 该 vendor 整条不注册 + 报告。条目级问题（缺 `id`、类型错、未知键、非法账号名）只跳过该条目 + 报告，不牵连整个 vendor。

### 3.1 `provider.json`（必需，无秘密）

就是一个 pi `providers.<id>` 条目 + 三个自有键（`apis` / `modelsPath` / `override`）：

```json
{
  "name": "SCNet",
  "api": "openai-completions",
  "baseUrl": "https://api.scnet.cn/api/llm/v1",
  "modelsPath": "/models",
  "headers": {},
  "apis": {
    "anthropic-messages": {
      "baseUrl": "https://api.scnet.cn/api/llm/anthropic",
      "modelsPath": "/v1/models"
    }
  }
}
```

| 字段 | 类型 | 必填 | 默认 | 语义 |
|---|---|---|---|---|
| `name` | string | 否 | 目录名 | 显示名 |
| `api` | string | **是** | — | **默认协议**（pi 值） |
| `baseUrl` | string | **是** | — | **默认端点** |
| `modelsPath` | string | 否 | `/models` | 默认端点的发现路径 |
| `headers` | object | 否 | — | vendor 级请求头（值可用 pi 值语法；**不写秘密**） |
| `apis` | object | 否 | — | **额外协议端点**：键 = pi 的 `api` 值（或别名），值 = `{ baseUrl(必填), modelsPath?, headers? }` |
| `override` | bool | 否 | false | 允许接管 pi 已知 id（§8） |

- 为什么有 `apis`：同一 vendor 的第二个协议端点（SCNet 的 Anthropic 端点服务同一批 19 个 id），避免每条模型都重复写 `baseUrl`；键就是 pi 的 `api` 值 ⇒ 默认协议用 `api`+`baseUrl`，其余协议都在 `apis` 里。（模型条目仍可自带 `baseUrl`、第 3 层仍可改 `baseUrl` —— 那是 pi 原生字段的功劳，与 `apis` 不冲突。）
- 同一协议要第二个端点时，在模型条目里写 `baseUrl`（pi 原生字段，§3.2）。
- headers 合并（低 → 高）：`provider.json.headers` → `apis.<api>.headers` → 账号 `headers`。
- **headers 怎么落地（否则会串端点）**：合并结果**逐条贴到该端点模型的 `headers`**，**不**往 `registerProvider` 的 provider 级 `headers` 放 —— pi 的 provider 级头会洒到该 id 的全部模型，Anthropic 端点的头跑到 OpenAI 请求上就是 400/401。与用户层的次序由 pi 定（§2.4）：我们的模型级 headers < `modelOverrides[M].headers` < `config.models[M].headers`（> config provider 级 `headers`）。
- **compat 不在这里**：兼容性是模型属性（pi 只认模型级 compat，§2.1），写进 `<id>/models.json` 的模型条目（§3.2）。`provider.json` / `apis.<n>` 里出现 `compat` → 报告并忽略。
- **凭据类键（`apiKey` / `envVar` / `authHeader`）出现 → 报告并忽略**：它们只属于 `accounts.json`。其余未知键 → 报告，不静默忽略。
- `api` 可写 pi 的**全部内置协议**（`pi-ai/dist/compat.js:108` `BUILTIN_APIS`，10 种）：`anthropic-messages` / `openai-completions` / `openai-responses` / `openai-codex-responses` / `azure-openai-responses` / `google-generative-ai` / `google-vertex` / `mistral-conversations` / `bedrock-converse-stream` / `pi-messages`。别名（大小写不敏感）：`openai` / `chat` → `openai-completions`，`anthropic` / `messages` → `anthropic-messages`，`responses` → `openai-responses`。**不在表里的值 → 报告 + 跳过**（不猜、不原样透传给 pi）。**归一化在加载时统一做**：`provider.json.api`、`apis` 的键、`models[].api` 全部先归一，再做判重/比对，交 `registerProvider` 时一律是 pi 的规范值。

### 3.2 `models.json`（可选，模型基底 = 完整条目表）

```json
{ "models": [
  { "id": "glm-5.2", "api": "anthropic-messages", "name": "GLM-5.2",
    "contextWindow": 200000, "maxTokens": 128000, "reasoning": true, "input": ["text"],
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
] }
```

- 形态：规范 `{"models":[...]}`；也接受纯数组简写（`sync` 只写规范形态）。
- 条目字段 = pi `ModelDefinitionSchema` 全部字段（`id` / `name` / `api` / `baseUrl` / `reasoning` / `thinkingLevelMap` / `input` / `cost` / `contextWindow` / `maxTokens` / `samplingParams` / `headers` / `compat`）。**没有自有字段**。`id` 必填（缺 → 报告并跳过该条）。
- **`compat` 只在这里**（模型级）：pi 的行为就是这样（`applyExtension()` 丢弃 provider 级 compat，§2.1）。同一个 vendor 的多个模型共享一套 compat 就在每条上重复写（内置 vendor 由生成器写，不手敲）；键必须属于该模型**有效协议**的家族（§5.3），否则报告不改写。
- `api` 省略 = 默认协议；写成 `apis` 里的协议 = 该端点，`baseUrl` 自动取 `apis.<api>.baseUrl`（也可显式写 `baseUrl` 覆盖）。
- 未列出的 id 仍可被**发现**补进来（§6）。
- 与 pi 全局 `~/.pi/agent/models.json` 是同名不同层：那份是**用户覆盖层**（更高，§4）。

### 3.3 `accounts.json`（可选，凭据的唯一位置）

```json
{
  "default": "main",
  "main": { "apiKey": "$SCNET_API_KEY", "authHeader": true },
  "work": { "apiKey": "!pass show scnet/work" }
}
```

`default` 的值是**账号 id（字符串指针）**，不是账号对象：它指向的那个账号注册为 base id `<id>`，其余账号注册为 `<id>-<name>`。上例 → `scnet`（用 `main` 的凭据）与 `scnet-work`。

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `apiKey` | string | **是** | pi 值语法（`$VAR` / `${VAR}` / `!command` / `$$` / `$!` / 字面量）；裸 `UPPER_SNAKE` = 环境变量名（我们规范化为 `$VAR` 再交 pi） |
| `authHeader` | bool | 否 | 是否追加 `Authorization: Bearer`（默认 false） |
| `headers` | object | 否 | 认证类请求头（如组织 id）；值支持 pi 值语法 |

- 没有 `apiKey` → 跳过该账号 + 报告（理由见 §2.3）。
- **全部账号都无凭据 / 根本没有 `accounts.json` → 仍然注册**（用基底模型表，不带 `apiKey`）：模型不进可用快照，但 `/login` / `--api-key` / stored 凭据能把它救回来（§2.3）；报告里直接提示 `/login <id>`。
- 账号**只管认证**。模型/端点级覆盖请写 pi 全局 `models.json` 的 `providers.<accountId>`（§4 第 3 层）—— 那是用户文件、pi 原生层，我们不复制一份。
- 账号 id（键）：`^[a-z][a-z0-9-]{0,31}$`；`default` 是保留键（指针，不是账号名）。
- **base id 何时注册**：① `accounts.json` 存在且有账号 → 由 `default` 指针定（无指针 / 指针不存在 → 不注册 base id，其余账号照常注册）；② `accounts.json` 不存在、为空、或全部账号无凭据 → **仍然注册 base id**（基底模型表 + 无 `apiKey`，报 `/login <id>` 提示，§2.3）；③ 内置 vendor → 总有内置基底账号兜底（§8）。
- 账号 `headers` 是最高一层**厂商/端点**头（覆盖 provider / 端点同名键）；整体仍低于用户显式写的 `modelOverrides[M].headers` / `config.models[M].headers`（pi 的次序，§2.4）。
- 该文件是唯一秘密载体 → 建议 gitignore；`provider.json` / `models.json` 可入库分享。
- **多账号的存在理由**：同一 vendor、同一产品/计费关系下的**多份凭据**（多人/多组织共用同一端点与模型表）。不同 key 但同一产品 → 一个目录多个账号；**不同产品/计费 → 不同目录、不同 provider id**（§7）。

## 4. 覆盖链（4 层，逐字段补丁）

低 → 高：

| # | 层 | 谁提供 | 粒度 | 说明 |
|---|---|---|---|---|
| 1 | **基底模型表** | `catalog.ts`（内置 vendor）或 `<id>/models.json`（目录 vendor） | 模型 | 模型事实的写入处：`cost` / `maxTokens` / `reasoning` / `input` / `thinkingLevelMap` / `contextWindow` |
| 2 | `provider.json` | 我们的文件层 | provider | 默认 `api` + `baseUrl` + `modelsPath`，以及 `apis`（第二协议端点）、`headers` |
| 3 | pi 全局 `models.json` 的 `providers.<id>` | 用户 | provider + 模型 | provider 级字段（`baseUrl` / `api` / `headers` / `compat` / `apiKey` / `authHeader`）+ `models[]` 逐条按字段覆盖 |
| 4 | pi 全局 `models.json` 的 `modelOverrides[M]` | 用户 | 模型 | **pi 自己最后应用**（`applyExtension` → `applyModelOverride`），我们不管，也不该与之打架 |

规则：

- **每一层都是补丁：写了的字段赢，没写的往下掉。** 基底是完整条目，其余层允许只写 `{id, api}` 这类最小增量。这与 pi 的 `modelOverrides` 语义一致；用户本机 `models.json` 的 `models[]` 条目也正是补丁写法（实测：`{"id":"GLM-5.3","reasoning":true,"contextWindow":1000000,"maxTokens":131072}`）。
- **合成时点**：每一次产出模型表都跑完整链（启动注册、`refreshModels` 返回值、pi 重注册后的离线轮）——否则发现一次就把用户覆盖洗掉。
- **唯一例外：`baseUrl` 遵循 pi 的原义 `config.baseUrl ?? model.baseUrl`**（不是「高层直接胜」）：第 3 层 provider 级 `baseUrl` 只对**自身无 `baseUrl`** 的模型生效（用户的 `providers.<id>.baseUrl` 是用来重定向默认端点，不是覆盖阿里那些自带端点的模型）。其余字段无例外。
- **pi 侧第 3 层必须由我们复刻**（§2.1 坑）：provider 级 `baseUrl` / `api` / `name` / `compat` / `models[]` / 条目级 `baseUrl` 在 `applyExtension` 后全部由我们的注册表取代 —— pi 只剩 `modelOverrides` / `apiKey` / `headers` / `authHeader` 四项还会从 `models.json` 流到我们的 provider（精确分工见 §8「接管后谁来做什么」）。其中 provider 级 `compat` 只贴**合成后仍未显式声明 `api`** 的模型（即落在有效默认协议上的那些）。
- **有效默认协议** = 第 3 层 `providers.<id>.api` ?? `provider.json.api`（用户层可改默认，pi 自己就是 `model.api ?? provider.api`）。第 3 层只翻了协议、没给 `baseUrl` 时，端点取 `apis.<新协议>.baseUrl`；取不到 → 报告并拒绝该 provider（不猜）。
- `api` / `baseUrl` 只能由第 1/2/3 层决定（第 4 层没有这两个字段）。
- 落端点后的显示名后缀 ` (协议)` 属于第 2 层的计算产物（该 vendor 有多个协议且该模型不在**有效默认协议**上时才加）⇒ 第 3 层显式写 `name` 会顶掉它（pi 同序）。账号后缀 ` (<账号名>)` 在前，协议后缀在后：`Name (work) (anthropic-messages)`。
- 账号 id 的第 3 层：`providers.<accountId>` 逐键压 `providers.<baseId>`，两份都生效、账号侧胜。
- 这 4 层只是**模型字段**的链；其它字段族各自成链（`headers` 见 §3.1，`compat` 见 §5.3，`modelsPath` 是第 2 层独有、不参与合成）。

## 5. 端点（协议）选择

### 5.1 规则（只有两步）

1. 模型条目写了 `api` → 用它（`baseUrl` = 条目自己的，否则 `apis.<api>.baseUrl`）。
2. 没写 → **有效默认协议** = 第 3 层 `providers.<id>.api` ?? `provider.json.api`。

没有优先级链、没有 tie-break、没有「账号 wire」「legacy wire」。pi 的原生规则本来就是 `model.api ?? provider.api`。

### 5.2 落端点后的字段改写

| 情况 | 动作 |
|---|---|
| 默认协议 | 不写 `api` / `baseUrl`（保留用户在第 3 层用 `baseUrl` 重定向默认端点的能力） |
| 非默认协议 | **同时**写 `api` + `baseUrl`（只写 `api` 会让 pi 用默认端点说错协议）；vendor 有多个协议且该模型不在**有效默认协议**上时，显示名加 ` (协议)` 后缀 |
| `api` 指向既非默认、也不在 `apis` 的协议 | **只要解析得出 `baseUrl` 就放行**（模型条目自带 / `apis` / 第 3 层均可）：`api` 只要在 `BUILTIN_APIS` 里就合法；仅当 `baseUrl` 无处可取时才报告 + 回落默认协议 |
| `openai-responses` | 与 `openai-completions` 同形发现（Bearer + `{data:[]}`）；请求打 `<baseUrl>/responses` |

### 5.3 compat 分族

四族键集合（`pi-ai/dist/types.d.ts:736` 的条件类型 + 各族 interface，逐键数过）：`openai-completions` 26 键（`:468-532`）、`openai-responses` 9 键（`:534-553`，同时覆盖 `azure-openai-responses` / `openai-codex-responses`）、`anthropic-messages` 11 键（`:555-617`）、`bedrock-converse-stream` **1** 键（`:619-622`，只有 `supportsStrictMode`）。其余协议（`google-generative-ai` / `google-vertex` / `mistral-conversations` / `pi-messages`）在条件类型里 compat 为 `never` ⇒ **不接受 compat**，写了就报告。折叠时「未显式声明 `api`」按**合成后**的模型表判（基底里写了 `api` 也算显式）。折叠顺序（低 → 高）：内置白名单（**按目标协议家族**吸收，仅 `supportsTemperature: false` 一类「少发参数」的键）→ **模型条目的 `compat`**（`<id>/models.json` 基底条目 / 第 3 层 `models[]` 条目）→ 第 3 层 provider 级 `compat`（pi 全局 `models.json` 的字段，只贴未显式声明 `api` 的模型 —— 这条是**我们对 pi 的刻意偏离**，见决策 17）。键不属于目标协议家族，或该协议在 pi 类型里 compat 为 `never` → **报告，不改写、不跨协议搬运**（把 OpenAI 线的 compat 贴到 Anthropic 线会 400）。

## 6. 自动发现

发现是**补缺来源，不是层**：它只补基底没有的 id/name/contextWindow，不覆盖任何显式写下的字段。下列四块分别回答：打哪里（6.1）、用谁的凭据（6.2）、拿回什么（6.3）、拿不到或拿回坏数据时怎么办（6.4）。

### 6.1 探针（打哪里）

| 项 | 规则 |
|---|---|
| 触发 | 启动注册（离线，用基底/memo/快照）→ `session_start`（在线）→ pi `refreshModels` → `refresh-custom-models` 命令 |
| 探针集合 | 每个**声明过**的端点一条：默认端点（`baseUrl` + `modelsPath`）+ 每个 `apis.<api>`（同理）；按 `(baseUrl, modelsPath)` 去重（同址不同路径是两条探针）。不猜未声明的端点 |
| `modelsPath` 缺省 | `apis.<api>.modelsPath` 省略 → 继承 `provider.json.modelsPath`；两处都缺 → **该端点无发现**（报告 `no modelsPath: no discovery`），**不猜 `/models`** |
| URL / 头 | `baseUrl.replace(/\/+$/,"") + modelsPath`（modelsPath 保证前导 `/`，否则补）；`Accept: application/json`；叠加端点/vendor/账号 headers |
| 支持的协议 | 发现只实现 OpenAI 形（`{data:[]}` + Bearer）与 Anthropic 形（同形 + `x-api-key`）两类；其余协议（google / bedrock / mistral / codex / azure / pi-messages）**能注册能请求，但无发现** → 报告 `no discovery for api "<api>"` |
| 鉴权形态 | **由协议定，与账号 `authHeader` 无关**：anthropic 系取 `anthropic-version: 2023-06-01` + `x-api-key`，其余取 `Authorization: Bearer` |

### 6.2 凭据（用谁的 key）

| 项 | 规则 |
|---|---|
| 用哪个账号探 | 用 **base id 账号**（`default` 指针所指 / 内置基底账号）的凭据探一次，结果全账号共享（同一 provider 定义下各账号服务集合一致；账号权限不同属未支持情形，报告差异） |
| 凭据顺序 | **与 §2.4 一致**：`readStoredCredential(<id>)` → `context.credential.key` → 账号 `apiKey` → 第 3 层 `providers.<P>.apiKey` → 内置基底账号 `envVar` |
| 值解析 | 自实现 `$VAR` / `${VAR}` / `$$` / `$!` / `!command`（10s 超时）/ 裸 `UPPER_SNAKE` = 环境变量名 / 字面量（§2.5：`resolve-config-value.js` 不可 import） |
| 环境来源 | `process.env` + 启动时 `loadEnvFile` 读入的 `~/.pi/agent/.env` 与 `~/.omp/agent/.env`（已存在的不覆盖）。写的就是 `process.env` ⇒ 同一份值也供 pi 在请求时解析 `$VAR` |
| 无凭据 | 不请求（保留上一份）；报 `no API key: <account> (accounts.json)` + 提示 `/login <id>` 或 `providers.<id>.apiKey`，**绝不把变量名当 token** |

### 6.3 结果吸收（拿回什么）

| 项 | 规则 |
|---|---|
| 解析 | 顶层 `data` 或 `models` 数组；行必须 `id: string` |
| **吸收白名单** | **只补** id 集合（未知 id 追加 + 报告）、`name`、`contextWindow`。**永不生成** `cost` / `maxTokens` / `reasoning` / `input` / `thinkingLevelMap`，也**不推断 `api`**（`supported_endpoints` 只在 `custom-providers <id>` 里报告）；消失的 id 保留。⚠ 别与**生成期**的能力权威搞混：`reasoning`/`input` 是 `catalog.ts` 里的静态事实，由生成器按官方/pi 内置写（决策 18）；这里说的是**实时 `/models` 不能改能力**（它根本不发能力字段） |
| 与覆盖链的关系 | 吸收结果作为 §4 的第 3 层参与合成（每层按字段补丁），**不**直接替换注册表 —— 否则一次刷新就洗掉用户第 4 层 |

### 6.4 失败与持久化

| 项 | 规则 |
|---|---|
| 失败 | 每条线独立；保留上一份（memo > 快照 > 基底）；错误单列（不覆盖 live 状态），消息含 URL |
| 返回值自校验 | `refreshModels` 返回的表 pi 会在 `publish` 前用 `applyExtension` 再校一遍（缺 `api`/`baseUrl` 就抛）⇒ **我们返回前先自校**（每条 `cost` 存在、`api` 在 `BUILTIN_APIS`、`baseUrl` 可解析），不合规的条目剔除 + 报告，不让 pi 抛 |
| 写盘 | pi `models-store.json`（pi 自己的 `publish`）+ 内存 memo。**只有 pi 写这个缓存**，我们自己的写盘永远只有 `sync --write`；`persist` 前每条补 `api`/`provider`/`baseUrl`（pi 的 `Model` 对象形状），恢复时读 `context.stored.models` |

## 7. 多账号

| 项 | 规则 |
|---|---|
| 注册 | `accounts.json` 的 `default` 指针所指账号 → `<id>`；其余每个 `<name>` → `<id>-<name>` |
| 显示名 | `<provider name> (<name>)`；被 `default` 指针指向的账号不加后缀 |
| 共享 | 全部 provider 定义（端点 / 协议 / headers）与基底模型表 |
| 账号自带 | 只有认证（`apiKey` / `authHeader` / `headers`） |
| 账号级模型覆盖 | 写 pi 全局 `models.json` 的 `providers.<accountId>`（§4 第 3 层） |
| 不同产品 / 不同端点集合 | **不同 provider**（不同目录、不同 provider id）—— pi 内置 `opencode`（Zen）与 `opencode-go`（Go）就是这个形状，两者还共用同一个 `OPENCODE_API_KEY`。`auth.json` 是「一 id 一凭据」 |
| 同一产品 / 多把 key | 同一目录、多个账号（`default` 指针选 base id） |
| pi 侧独立 | `auth.json[<id>]` / `--api-key` / `/login` / store 条目各自独立 → 这就是「切换账号」 |
| 冲突 | 名字非法 / id 冲突（撞另一个 provider 或账号）/ 无凭据 → 跳过该账号 + 报告（其余账号与 `<id>` 不受影响） |

## 8. 接管边界

**白名单**：① 内置 vendor（`scnet`、`commandcode`）；② `custom-providers/` 下有合法 `provider.json` 的目录；③ 命中 **pi 内置目录**（`pi-ai` 自带的约 39 provider / 961 模型 id）**必须** `"override": true`，否则跳过 + 报告。其余一律不碰。

> ③ **不算 pi 全局 `models.json` 里已声明的 provider id**：那是用户自己的配置层（也是本扩展的主用层），不构成「接管一个已有 provider」。例如用户写 `providers.scnet` 是正常覆盖，不需要 `override`（§13 零迁移）。
>
> 实测补充：**`models.json` 里只写 `providers.<id>` 的 provider 会被 pi 自己注册**（`providerIds()` 含 `config.getProviderIds()`；`recomposeProvider` 在 `base === undefined` 时仍调 `composeModelProvider`；`applyModelsJson(…, [])` + `applyExtension(…, undefined)` 直接用 `config.models[]`，每条经 `modelFromJson` 取 `definition.api ?? config.api ?? defaults.api` / 同名 `baseUrl`）。所以「config-only provider」是真实存在的第二类接管对象 —— 我们注册同名 id 时它的模型表被我们的整表替换（其 `models[]` 由我们复刻），且它的 `models[]` 若缺 `api`/`baseUrl`，pi 在 `registerProvider` 的 `validateExtensionProvider` 里**直接抛**。

**内置 vendor 的定义 = 「内置 provider + 内置基底账号」**：`sources.ts` 用同一 schema（`api`/`baseUrl`/`modelsPath`/`apis` + 一个内置账号的 `envVar`+`authHeader`，内部表示，不落文件）。用户建同名目录时：目录的 `provider.json` 覆盖内置定义（报告），`accounts.json` 里被 `default` 指针指中的账号接管 base id、其余账号追加；**若用户只写了附加账号、没写 `default` 指针，内置基底账号继续用**（不注销内置 base id —— §10 #11 只适用于目录 vendor）。⇒ `siblingId` 与 `anthropicBaseUrl` 两个特例字段删除（Anthropic 端点就是 `apis."anthropic-messages".baseUrl`）。

**接管后谁来做什么（逐项实测，非推测）**：

| 项 | 谁做 | 实据 |
|---|---|---|
| `models[]` 合并、provider 级 `baseUrl`/`api`/`name`/`compat` | **我们**（pi 全丢） | `applyExtension` 第三参是我们的注册配置：`config.models` 存在时直接返回我们的表（整表替换），`baseUrl`/`api` 只从我们的定义取；`model.baseUrl` 才是请求用的 |
| `modelOverrides[M]` | **pi**（最后一层） | `composeModelProvider` 末尾 `applyModelOverride` |
| `apiKey` | 两层都有：扩展胜、config 兵底 | `configuredApiKey() = extension?.apiKey ?? config?.apiKey` |
| `headers` | 两层都有：request 时 `{...config.headers, ...extension.headers}`，再被 `modelOverrides[M].headers` + `config.models[M].headers` 压 | `resolveConfiguredModelHeaders` / `resolveCompatibilityRequestConfig` / `rawModelHeaders` |
| `authHeader` | 两层都有：`extension ?? config ?? false` | 同行 |
| config 的 `oauth` | **不流入**（只有 extension 原生 oauth 或 base oauth）；`oauth === "radius"` 走 `configureRadiusProviders()` 特例 | `composeOAuthAuth` |
| `oauth` / `streamSimple` / 原生 `refreshModels` | 不能用 JSON 表达 → 报告（决策 16） | — |

⇒ 结论：**只有 `modelOverrides` / `apiKey` / `headers` / `authHeader` 四项还能从 models.json 流入我们的 provider**；其余全部靠我们复刻。

**id 拼写**：provider id = `commandcode`（域名 commandcode.ai），`aliases = ["codecommand", "codegoat"]`（既有全局 `models.json` 的 `providers.codecommand` 继续生效）；显示名 `CommandCode (GOAT)`；`CMD_API_KEY` 不变。已知边界：pi 只按**注册 id** 找 `modelOverrides` ⇒ `providers.codecommand.modelOverrides` 失效，发现即报。

## 9. 命令

| 命令 | 行为 | 写盘 |
|---|---|---|
| `refresh-custom-models` | 刷新全部 provider 全部端点（保持现有输出） | 否 |
| `custom-providers` | 状态总览（每 id：模型数、live/catalog、各协议分布、账号 id、未知 id、上次错误） | 否 |
| `custom-providers <id>` | 单 provider 详情：端点表（协议/baseUrl/modelsPath/每端点模型数）、逐模型实际生效的 `api`+`baseUrl`、全部校验问题 | 否 |
| `… drift` | 与 pi 内置目录的差异（现有）；id 匹配用 `normalizeModelId`（去命名空间 / 去 `-YYYYMMDD` 日期尾 / 去分隔符 + 小写）；**内置目录读不到 → 静默跳过 drift**（只报“built-in catalog unavailable”，不当错误）。`reasoning`/`input` 已在**生成期**对齐内置（决策 18）⇒ 这两项还报差异即意味着 `catalog.ts` 过期（重新生成）；`maxTokens`/`contextWindow` 的差异按代理权威**只报不改** | 否 |
| `… files` | 扫描结果：provider 目录、三文件在位情况、被忽略的目录、全部校验问题 | 否 |
| `… sync <id> [--write]` | 打印「当前基底 ⊕ 发现 vs `<id>/models.json`」差异摘要；`--write` 才落盘（先 `models.json.bak`） | 仅 `--write` |

输出约束：所有命令都走 `ctx.ui.notify`（toast）⇒ **必须裁剪**（每个 id 先列 8 行 + `(+N more)`；超长总数只给计数）。`sync --write` 写的内容 = **基底（catalog 或现有 `<id>/models.json`）⊕ 发现结果**，**不含** pi 全局 `models.json` 的用户层（第 3 层）与 `modelOverrides`（否则一次 sync 就把用户覆盖烤进基底）；发现里消失的 id **保留** + 报告（删不删由用户定）。

## 10. 校验与错误表

| # | 条件 | 动作 | 消息 |
|---|---|---|---|
| 1 | 子目录无 `provider.json` | 忽略 | （`files` 里列「忽略」） |
| 2 | `provider.json` JSON 非法 / 根非对象 | 跳过该 vendor | `cannot parse <path>: <err>` |
| 3 | `provider.json` 未知键 | 不影响加载 + 报告 | `provider.json: unknown key "x"` |
| 3b | `provider.json`（含 `apis.<n>`）出现凭据类键 | 忽略该键 + 报告 | `"apiKey" belongs in accounts.json` |
| 3c | `provider.json`（含 `apis.<n>`）出现 `compat` | 忽略该键 + 报告 | `compat belongs on model entries in models.json` |
| 4 | 无 `baseUrl` | 跳过该 vendor | `<path>: "baseUrl" is required` |
| 5 | `api` 缺失（且 `apis` 也空）或不在 `BUILTIN_APIS`（10 种）里 | 跳过该 vendor，报告 | `unsupported api "<api>"` |
| 6 | `apis.<api>` 缺 `baseUrl` | 跳过该条目 + 报告 | `apis.<api>: "baseUrl" is required` |
| 6b | `apis` 里重复声明了默认协议（键 = `provider.json.api`） | 忽略该条 + 报告（默认端点胜） | `apis.<api>: already the default endpoint` |
| 6c | 字段类型错（`headers`/`apis` 非对象、`override` 非布尔、`default` 非字符串、`apiKey` 非字符串、`models` 非数组） | 跳过该字段/条目 + 报告 | `<path>: "<key>" has the wrong type` |
| 7 | `models.json` JSON 非法 / 根非数组也非 `{models:[]}` | **跳过该 vendor**（fail-closed） | `cannot parse <id>/models.json: <err>` |
| 8 | 模型条目缺 `id` | 跳过该条 + 报告 | `<id>/models.json: model #<i> has no "id"` |
| 8b | 模型条目 `api` 未声明（既非默认协议，也不在 `apis`） | 回落默认协议 + 报告 | `<id>: no endpoint for api "<api>", fell back to "<default>"` |
| 9 | `accounts.json` JSON 非法 / 根非对象 | **跳过该 vendor**（fail-closed） | `cannot parse <id>/accounts.json: <err>` |
| 10 | 账号缺 `apiKey` | 跳过该账号 | `account "<n>": needs "apiKey"` |
| 10b | 账号出现 `wire`/`models` 等非认证键 | 忽略 + 报告 | `account "<n>": "<k>" is not an auth field; put model overrides in models.json` |
| 11 | `accounts.json` 有账号但无 `default` 指针 / 指针指向不存在的账号（**目录 vendor**） | 不注册 base id `<id>`，其余账号照常；内置 vendor 回落内置基底账号（§8）；**若文件不存在/为空/全无凭据 → base id 照常注册但无凭据** | `no "default" account: <id> not registered (custom-providers/<id>/accounts.json)` |
| 12 | 账号名非法 | 跳过该账号 | `account "<n>": invalid name` |
| 13 | 账号 id 冲突 | 跳过 | `account id <x> collides with <y>` |
| 14 | pi 全局 `providers.<P>.wire` / `wire.models`（已删的 legacy 键） | 不改写 + 报告 | `"wire" is no longer read; set "api" on the model entry instead` |
| 15 | compat 跨族 / 该协议在 pi 类型里不接受 compat | 不改写 + 报告 | `compat.<key> is not part of <api>` |
| 16 | `oauth` / `streamSimple` / `refreshModels` | 忽略 + 报告 | `<key> is not supported in provider files` |
| 17 | 命中 **pi 内置目录**的 id 且无 `override`（pi 全局 `models.json` 里声明的 id 不算） | 跳过 + 报告 | `provider <id> exists in pi; set "override": true to take it over` |
| 18 | 别名下的 `modelOverrides` | 不改写 + 报告 | `modelOverrides under "<alias>" is inert (registers as "<id>")` |
| 19 | `/models` 失败 | 保留上一份 + 报错 | `<endpoint>: HTTP <n> (GET <url>)` / `timeout after 10s` / `no data/models array (GET <url>)` |
| 20 | 新 id | 追加 + 报告 | `<id>: <n> new model(s) not in catalog: …` |
| 21 | pi 全局 `models.json` 非法 | pi 自己丢弃并报错；我们附提醒 | — |
| 22 | 用户 `providers.<id>` 块为空对象（无 `baseUrl`/`headers`/`compat`/`modelOverrides`/`models`/`apiKey`/`oauth`/`authHeader`） | **预先报告**（否则 pi 在 `applyModelsJson` 里抛） | `providers.<id>: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models"` |
| 23 | 用户 `providers.<id>.models[]` 条目缺 `api`/`baseUrl`（或 `contextWindow`/`maxTokens` ≤ 0） | **预先报告**（pi 在 `applyModelsJson`/`validateExtensionProvider` 抛，会连带注册失败） | `providers.<id>.models[i]: "api" is required` / `"baseUrl" is required` |
| 24 | 用户给我们的 provider id 写了 `providers.<id>.oauth` | 不改写 + 报告（实测 `composeOAuthAuth` 只取 extension/base 的 oauth，config 侧不流入；`oauth === "radius"` 除外） | `providers.<id>.oauth is inert for extension providers` |
| 25 | 目录名撞另一个 vendor 的 `aliases`（如同时存在 `commandcode/` 与 `codecommand/`） | 跳过后者 + 报告（否则两个目录争同一 id） | `directory "codecommand" collides with alias of "commandcode"` |
| 26 | 我们自己的模型表不合规（缺 `cost`、`api` 不在 `BUILTIN_APIS`、`baseUrl` 不可解析、0 条也没 creds） | 剔除该条 + 报告（**不能在 `refreshModels` 里抛**，pi 会把它变成 provider 错误） | `<id>/<model id>: skipped (…)` |
| 27 | 无任何可用凭据（账号全无 `apiKey` / 无 `accounts.json` / 无 `models.json` `apiKey`） | **仍注册** + 警告（模型不进快照；“/login <id>” 提示） | `<id>: no credential; run /login <id> or set providers.<id>.apiKey` |

报告出口：`ctx.ui.notify(msg, "warning")`，聚合上报；扩展**不写 stderr**。

## 11. 代码改动清单

| 文件 | 动作 | 内容 |
|---|---|---|
| `types.ts` | 改 | `api` 不再手写三种（改字符串 + 运行时按 `BUILTIN_APIS` 校验）；`Source` 删 `siblingId` / `anthropicBaseUrl`，加 `apis` / `modelsPath`（与 `provider.json` 同词）；新增 `ProviderFile` / `AccountsFile` / `LoadIssue` / `ProviderEntry` |
| `provider-files.ts` | 新增 | 扫描目录、读三文件、校验（fail-closed、凭据键越位、账号只认认证键）、账号展开、issue 汇总（IO 注入便于测） |
| `config.ts` | 改 | `normalizeWire`/`wireSelectionFor` → `normalizeApi`/`apiFor(model)`（§5.1 两条规则）；删 `siblingId` 继承与 `INHERITED_KEYS`（凭据归账号后无跨线继承）；保留并整理第 3 层复刻 |
| `sync-models.ts` | 新增 | `sync` 的差异计算 + 原子写 + `.bak`（唯一写盘路径） |
| `sources.ts` | 改 | 内置 vendor 改同一 schema（`api`/`baseUrl`/`apis`）+ 内置基底账号字段；id `commandcode` + 别名；删 `siblingId`/`anthropicBaseUrl` |
| `index.ts` | 改 | 输入 = 内置 vendor + 扫描到的目录；账号展开注册；memo 按 (provider, endpoint) 键控；命令扩展；状态结构扩展 |
| `builtin.ts` | 改 | compat 吸收按协议家族过滤（四族；另四类协议不接受 compat） |
| `catalog.ts` / `scripts/refresh-catalog.mjs` | 改 | 生成器迭代 `sources.ts` 的端点（含 responses）；`commandcode` 重命名；**catalog 条目不烘焙 `api`/`baseUrl`**（落端点由加载时 §5.2 计算，同今天）。⚠ **不在此列**：能力权威已按决策 18 改完（内置多数票 → 能力页 → 旧值，`builtin.ts` 的 `normalizeModelId` 复用不改） |
| `README.md` / `.codestable/attention.md` | 改 | 三文件布局、字段表、优先级、命令、错误表、测试清单 |
| `tests/*` | 改/增 | 见 §12；`tests/run-all.mjs` 的硬编码清单同步（6 → N 个，含改名后的 `apis-test.mjs`） |

不新增 `package.json` / `tsconfig.json`。

## 12. 测试计划（红测试先行，全程离线）

| 测试 | 覆盖 |
|---|---|
| `tests/apis-test.mjs`（`wire-test.mjs` 改名 + 扩写） | 现有 SCNet 行为不回归（`scnet` 一个 id 两个协议、落端点字段、compat 归属）；`normalizeApi` 别名；`models[].api` 压默认；非默认协议补 `api`+`baseUrl`+后缀；未声明协议回落 + 报告；**10 种 BUILTIN_APIS 全部接受，表外的拒绝** |
| `tests/provider-files-test.mjs`（新） | 扫描发现；无 `provider.json` 忽略；JSON 非法/未知键/凭据键越位/**`compat` 越位**/缺 `baseUrl`/协议不在 `BUILTIN_APIS`/`apis.<n>` 缺 `baseUrl`/`apis` 重复默认协议；`models.json` 非法→vendor 跳过；条目缺 `id`；`accounts.json` 非法→vendor 跳过；第 3 层补丁语义（只写 `{id, api}` 时基底 `contextWindow`/`cost` 不被清零）；模型条目的 compat 按有效协议的家族校验 |
| `tests/accounts-test.mjs`（新） | `"default": "main"` 指针 → `main` 注册为 `<id>`、`work` → `<id>-work`；有账号但无 `default` 指针 → 不注册 base id 但其余账号照常；指针指向不存在的账号 → 只不注册 base id；**无 `accounts.json` / 空文件 / 全无凭据 → base id 照常注册且无凭据（§2.3 的 /login 通路）**；账号 id 非法；id 冲突；账号非认证键被报告；`providers.<accountId>` 第 3 层基底+覆盖 |
| `tests/sync-test.mjs`（新） | 差异摘要内容；`--write` 才落盘；`.bak` 生成；写后内容可被重新加载（round-trip） |
| `tests/pi-native-test.mjs`（改） | 真 `ModelRuntime`：responses 端点（stub fetch）；离线轮不抹错误；**`refreshModels` 返回值回来时第 3 层覆盖仍在**（不会被发现洗掉）；`no authentication method configured` 断言按 §2.3 校正 |
| 发现与接管补测（并入 `provider-files-test` / `pi-native-test`） | §6：吸收白名单（只补 id/name/contextWindow）、失败保留上一份、memo > store > 基底、按 `(baseUrl, modelsPath)` 探针去重、`modelsPath` 缺省继承与「两处都缺 → 无发现」、URL 拼接规范化、`.env` 参与 `$VAR` 解析；§8：`override: true` 接管内置 id、无 `override` 跳过 + 报告、pi 全局 `models.json` 声明的 id 不触发接管（错误 #17/#18）、目录名撞别名（#25） |
| 凭据/登录补测（新增或并入 `accounts-test`） | 无凭据时**仍然注册**且 `pi` 侧存在 login 方法（#27）；stored 凭据（`auth.json` / `--api-key`）优先于账号 `apiKey`；`authHeader: true` 无 key 时请求期报 `No API key found`；`refreshModels` 返回非法表时**我们**先剔条报告（#26），不让 pi 抛 |
| `tests/smoke.mjs` / `loadtest.mjs` / `catalog-test.mjs` / `builtin-test.mjs` | 加载与注册（含账号 id）、catalog 结构、吸收白名单家族过滤 |

约束：每条断言实现前先跑一次确认 FAIL；`fetch` 打桩必须在 `finally` 恢复；`PI_CODING_AGENT_DIR` 指向临时目录 + 临时 `custom-providers/`；`ModelRuntime.create` 记得 `await`。

## 13. 部署 / 迁移 / 回滚

- 部署（本机开发）：`rm -rf ~/.pi/agent/extensions/custom-providers && cp -R extensions/custom-providers ~/.pi/agent/extensions/`，随后 pi `/reload`。正式安装走 `pi install git:…@v0.1.0`，两者**二选一**。
- 迁移：现有全局 `models.json` 用法零迁移（`providers.scnet` / `providers.codecommand` 的 `baseUrl`/`compat`/`models[]` 继续生效）。不建 `custom-providers/` 目录 = 行为与今天一致。legacy `providers.<id>.wire` 无用户（实测本机配置无此键），不兼容、只报告。
- 回滚：装回旧代码即可；无配置迁移。我们自己的写盘只有 `sync --write`（有 `.bak`）；pi 会写它自己的 `models-store.json` 缓存（`publish`，非用户配置）。
- 备份：`/tmp/pi-sub-prod-pre-merge-163841.tgz` 已存在。

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| 复刻第 3 层有偏差 → 用户配置静默失效 | §2.1 逐条对照源码 + 回归测试 + `custom-providers <id>` 显示实际生效值 |
| `~/.pi/agent/custom-providers/` 撞 pi 原生约定 | 目录名 = 项目名；只认含 `provider.json` 且能解析的子目录，其余忽略并在 `files` 列出 |
| compat 跨协议误贴 | §5.3 家族校验 + 报告 + 测试 |
| `accounts.json` 被误当成配置中心 | 只接受认证键，其它键报告并指向 `models.json` |
| `sync --write` 覆盖手改 | 默认只打印；`--write` 才写 + `.bak` |
| 账号把 picker 拉长 | 仅用户显式建账号时发生；显示名带后缀；`files` 列出全部 |
| `override: true` 打坏内置 provider | 必须显式 + README 警示 + 重载即恢复 |
| 生成器网络（commandcode.ai 不通） | 先用 `api.scnet.cn` 验证多协议生成；恢复后补 `--dry-run` |

## 15. 实施顺序与证据

| # | 步骤 | 证据 |
|---|---|---|
| 0 | （需授权）提交现有 SCNet 合并 + `v0.1.0` | `git log --oneline` / `git tag` |
| 1 | 冻结基线 | `node tests/run-all.mjs` → 6 passed（**已跑，2026-09-18 通过**） |
| 2–3 | `apis-test` 红 → `config.ts` 的 api 规则绿 | FAIL→PASS 输出 |
| 4–5 | `provider-files-test` 红 → `provider-files.ts` + index 接入 | FAIL→PASS |
| 6–7 | `accounts-test` 红 → 账号展开注册 | FAIL→PASS |
| 8 | `sync-test` 红 → `sync-models.ts` 绿 | FAIL→PASS + round-trip |
| 9 | responses 端点端到端 | mock 网关记录 `POST <base>/responses`；部署副本临时改 baseUrl 跑 `pi -p`；还原 + md5 比对 |
| 10 | 命令（`custom-providers <id>` / `files` / `sync`） | 每条命令实际输出 |
| 11 | 生成器多协议 + `commandcode` 重命名 | `refresh-catalog.mjs --dry-run`（scnet 可达） |
| 12 | 全量测试 + 部署 | `run-all` 全绿 ×2；`diff -rq` in sync；loader 6 扩展 / errors 0 |
| 13 | 文档 + 证据汇总 | README/attention 更新；测试输出/mock 日志/diff/loader 输出 |

## 16. 已定决策（可否决，报编号）

1. 布局：`~/.pi/agent/custom-providers/<id>/{provider.json, models.json, accounts.json}`；扫描目录；无索引、无单文件。
2. `provider.json` 无秘密；秘密只在 `accounts.json`。
3. 端点声明用 pi 原生 `api` + `baseUrl`（两者都必填 = 默认端点），第二协议端点写 `apis.<api>`（键 = pi 的 api 值）；**不使用自有 `wires`/`wire` 概念，不设选线链**。`api` 接受 pi `BUILTIN_APIS` 全部 10 种，表外的报告 + 跳过。
4. 模型选端点 = pi 原生 `models[].api`（pi 的规则本来就是 `model.api ?? provider.api`）；同协议要第二个端点时用模型级 `baseUrl`（pi 原生字段）。
5. `accounts.json` 的 `default` 是**字符串指针**（值为账号 id，不是账号对象），只决定 base id 注册与否；文件里列出的其它账号照常注册（`<id>-<name>`）。
6. 凭据只在 `accounts.json`，账号只装认证（`apiKey` / `authHeader` / `headers`）；账号不带 `wire`/`models`。账号只影响**鉴权**：同一产品下多把 key 才用多账号；不同产品/计费就是不同目录、不同 provider id（决策 7）。
7. **provider 边界 = 产品/计费边界**：不同产品、不同计费关系、不同端点集合 = 不同 provider 目录 / 不同 provider id（如 pi 内置 `opencode` 与 `opencode-go`）。**同一产品下的多把 key = 同一目录里的多个账号**（§3.3）。旧的「跨线不同 key 用两个账号各钉一条线」作废。
8. 覆盖链 4 层：基底模型表 → `provider.json` → pi 全局 `providers.<id>`（provider 级 + `models[]`）→ pi 的 `modelOverrides`；每层按字段补丁。
9. 发现只是补缺来源（id / name / contextWindow），不是层；`cost`/`maxTokens`/`reasoning`/`input`/`thinkingLevelMap` 永不生成，`api` 也不推断。
10. **compat 是模型属性**：只写 `<id>/models.json` 的模型条目（容器由生成器批量写）；`provider.json` / `apis` 里出现即报告并忽略；pi 全局 `models.json` 的 provider 级 `compat` 仍复刻（那是 pi 自己的字段）。跨协议只报不改；吸收白名单只吸收「少发参数」类键。
11. 坏文件 fail-closed（文件级）：`models.json` / `accounts.json` 解析失败 → 该 vendor 整条不注册；条目级问题不牵连 vendor。
12. 接管边界 = 白名单（内置 vendor / 有 `provider.json` / `override: true`）。
13. 写盘只有一条：`sync --write`（带 `.bak`）。没有别的写盘命令。
14. provider id 改 `commandcode`；`aliases = ["codecommand", "codegoat"]` 只是「从哪些 `models.json` 键读配置」（不是 pi 别名，pi 无此机制）。
15. 已删概念不保留兼容：`wires` / `wire` / `siblingId` / `anthropicBaseUrl` / `providers.<id>.wire`（实测本机配置无 `wire` 键）。
16. `oauth` / `streamSimple` / `refreshModels` 不支持（报告）。
17. pi 全局 `models.json` 的 provider 级 `compat` 只贴**有效默认协议**上的模型（§4/§5.3）—— 这是对 pi 原义的**刻意偏离**：`applyModelsJson` 把 `config.compat` 合进**每一条** base 模型（不分协议），而把 OpenAI 系 compat 贴到用户搬到 Anthropic 端点的模型上属无意义的跨族搬运，也与 §5.3「跨协议键只报不改」自相矛盾。
18. **能力元数据（`reasoning` / `input`）的权威 = 官方 / pi 内置目录**（用户 2026-09-18 裁决）。实测三条中转线的 `/models` 都不发能力字段（codecommand 只给 `id/name/context_length/supported_endpoints`；scnet 的 OpenAI 形只有 `id/object/ownedBy`；其 Anthropic 形 `capabilities` 18 行全 `null`），CodeCommand 的能力页自己就自相矛盾（embedded vision=false / rendered vision=true），而 pi 内置目录对同一 id 跨 provider **一致**（少数第三方托管点的孤立异议被多数票压过）。⇒ 生成器写 `catalog.ts` 时按此优先级逐字段定：**内置目录（按 `normalizeModelId` 归一后多数票）→ 能力页 embedded → 旧值**；页面/旧值与内置不一致时**报告**。`maxTokens` / `contextWindow` **不在**此列（仍代理权威、只报不自动应用：中转线会截断，高报会 400）。**`thinkingLevelMap` 的例外边界**（用户 2026-09-18 追加裁决「按 pi 的来」）：只取 **anthropic 协议线**的内置映射——那里映射的是 Anthropic 自己的 adaptive-effort 档位（哪些档存在、`off: null` = 关不掉思考），是**模型事实**，跨端点可搬；OpenAI 形线的 effort 词表是**网关自定义**（同一 id 在 9 个托管点有 9 种映射：`off:"none"` / `minimal:null` …），照搬别的网关的映射会发出端点不认的值 ⇒ 不用、只报。实测：机械套用「同协议内置多数票」会命中 75 行，其中约 40 行是「内置无映射」，套用等于**删掉**我们的映射（pi 沉默 ≠ 无档位）；另有整行只有单一第三方托管点（openrouter/vercel）一票——与 `mimo-v2.5` 的孤立异议同类，不采信。实际落地 6 行（`claude-sonnet-5`/`sonnet-4-6`/`fable-5`/`fable-5-1`/`opus-4-8`/`opus-4-7`；`claude-opus-5` 内置平票 → 保留并报告）。`cost` 仍保留旧值。

### 待用户回答

1. v4.0 照此实施？（有异议报决策编号 1–18）
2. 第 0 步（提交 SCNet 合并 + `v0.1.0`）是否授权？git 归你。

## 17. 后期候选（本轮不做）

华为 MaaS（ModelArts Studio）/ 阿里 ModelScope：用户 2026-09-18 裁决为**后期工作** —— 本轮不纳入、不预留机制（YAGNI）。真接时先实测端点与鉴权形态（静态 key vs IAM token 交换）：

- 若是 OpenAI 兼容端点且静态 key → 新增 vendor 就是 `sources.ts` 一条 + `catalog.ts` 一批，或用户自己的目录；`apis` 已是 api + baseUrl + headers 的通用容器。
- 若需**动态换 token**（如华为 IAM 的 `X-Auth-Token` 交换）→ `accounts.json` 的 `apiKey` + `authHeader` 不够；可行路子是把 `apiKey` 写成 pi 的 `!command` 插值（pi 在请求时执行，扩展只透传，§2.4），但必须先实测再决定是否需要文件层支持。

## 附：与 pi 原生词汇的对照

| 我们的东西 | pi 词汇 | 说明 |
|---|---|---|
| 默认协议 / 端点 | `api` / `baseUrl` | 原样 |
| 第二协议端点 | `apis.<api>`（自有键） | 因为 pi 没有「多端点」的表达；键就是 pi 的 api 值 |
| 模型选端点 | `models[].api`（+ `baseUrl`） | 原样，pi 原生就允许 |
| 模型表 | `models[]` | 原样（`<id>/models.json` 与 pi 全局同名不同层） |
| 发现路径 | `modelsPath`（自有键） | pi 没有模型列表路径概念 |
| 接管开关 | `override`（自有键） | pi 没有「扩展接管内置 provider」的概念 |
| 账号 | `accounts.json`（自有文件） | pi 的凭据在 `auth.json`（一 id 一凭据），多账号只能多 id |
| 账号级模型覆盖 | pi 全局 `models.json` 的 `providers.<accountId>` | 复用 pi 自己的层，不再造 |

自有词汇只剩 4 个：`apis` / `modelsPath` / `override` / `accounts.json`（及其与 `default` 指针的约定）。

## 附：本轮实证清单（开工前不再有「推测」项）

| # | 问题 | 结论 | 实据 |
|---|---|---|---|
| 1 | 裸 `UPPER_SNAKE` 会被 pi 当变量名吗 | **不会**，是字面量 ⇒ 规范化到 `$VAR` 必需 | `resolve-config-value.js:17,96` |
| 2 | 能否重用 pi 的值解析器 | **不能**，`exports` 只导出四个入口，裸深路径 `ERR_PACKAGE_PATH_NOT_EXPORTED` | `pi-coding-agent/package.json` exports（实测） |
| 3 | 只在 `models.json` 声明的 provider | **会被 pi 自己注册**（config-only provider，模型级 `api`/`baseUrl` 生效；`models[]` 缺字段则 `registerProvider` 招） | `model-runtime.js:126-149`、`provider-composer.js:48-78,291-300` |
| 4 | `applyExtension` 后 config 侧还剩什么 | 仅 `modelOverrides` / `apiKey` / `headers` / `authHeader`；`oauth`（非 radius）不流入 | `provider-composer.js:171-176,258-283,291-312` |
| 5 | 各协议 baseUrl 拼接 | 见 §2.4 表（10 种） | `pi-ai/dist/api/*.js` |
| 6 | 无凭据不进快照是否分协议 | **不分**，provider 级判定 | `model-runtime.js:171,187,229-252` |
| 7 | compat 族键数 | 26 / 9 / 11 / **1** | `types.d.ts:468-622,736` |

## 版本沿革（压缩）

v1 → v2：去掉单文件形态、`vendors.json` 索引、顶层 `baseUrl`/`api` 简写；凭据归账号；默认线只在 provider 文件。v2 → v3：目录内容定为 `provider.json` + `models.json` + `accounts.json`；`sync` 回归（默认只打印）。v3 → v3.1：凭据彻底移出 `provider.json`；补 L0–L8 层级表；条目级 `models[]` 定为增量覆盖。v3.1 → v3.2：私有目录名用项目名。v3.2 → v3.3：项目改名 `pi-custom-providers` / `custom-providers`（命令、远端、会话 header 的 `cwd` 同步）。v3.3 → v4.0：见文首变化表。
