# Attention

本文件是 CodeStable 技能启动必读的项目注意事项入口。所有 CodeStable 子技能开始工作前必须读取它。

## 报告语言

CodeStable 所有落盘产出的正文用**中文**：plan / design、plan review / design-review、code review、QA、验收、issue（report / analysis / fix-note）、refactor、roadmap、goal、沉淀（compound）等所有人读报告都用中文表达。机器状态（YAML / JSON / `state.yaml` / frontmatter 字段）保持机读格式不翻译。如需改默认语言，改这一节。

## 项目碎片知识

<!-- cs-note managed: 用 cs-note 维护，新条目按下面分节追加 -->

### 编译与构建

- 无 `package.json`、无 bundler、无 npm 依赖：pi 按约定目录 `extensions/` 发现入口，TS 由 pi 的 jiti loader 现场加载。不要加回 `package.json`（含 manifest 的 git 包会触发 `npm install`）。

### 运行与本地起服务

- 本地部署（开发时）：`rm -rf ~/.pi/agent/extensions/custom-providers && cp -R extensions/custom-providers ~/.pi/agent/extensions/`，随后在 pi 里 `/reload`。
- 部署副本与 `pi install` 包安装**二选一**，同时用会双加载、provider 注册两次。

### 测试

- `node tests/run-all.mjs` 跑全部（10 个）；新增/改名后不用改清单（`run-all` 按目录扫）。单跑 `node tests/apis-test.mjs` / `provider-files-test.mjs` / `accounts-test.mjs` / `sync-test.mjs` / `responses-test.mjs` / `pi-native-test.mjs`。
- 测试通过 pi 自己的 jiti loader 加载 TS（见 `tests/harness.mjs`），不写 `~/.pi`；`PI_PKG` 可指定 pi 安装目录。
- `tests/harness.mjs` 在导入被测代码前把 `PI_CODING_AGENT_DIR` 指向临时目录：不这样会被 `getAgentDir()` 带回你真实的 `~/.pi/agent/models.json`，断言会随本机配置变化（曾因此把 scnet 的 `compat` 覆盖进测试）。
- `catalog-test.mjs` 会调用 pi-ai 的 `calculateCost()`，是「模型缺 `cost` 就崩」的回归防线。
- `tests/pi-native-test.mjs` 用 pi 真正的 `ModelRuntime` 跑 `registerProvider → refresh → publish`，全程打桩 `fetch` + 内存 store；改动 `refreshModels`/持久化时先跑它。
- 测试里**不要留着真 `fetch`**：一旦某段走了真网络，断言就随网速/代理时好时坏（曾出现“同一测试三次跑两样”）。每个改 `globalThis.fetch` 的段落都要在 `finally` 里恢复。`harness.mjs` 的 `sessionStart()` 已内置「离线 fetch」包装（`session_start` 会发真请求）；想测在线刷新就自己打桩后直接调 `provider.refreshModels({allowNetwork:true,...})`。
- `harness.mjs` 的 `startExtension()` 是唯一入口：写 `agentPath("models.json")` / `agentPath("custom-providers", "<id>", ...)` 之后再调它。jiti 的 `moduleCache:false` 让每次 `loadTs` 都是新实例，所以「发现结果 memo」要在**同一个** `startExtension()` 返回值上触发（`ext.providers.get(id).refreshModels(...)`），另起一个实例看不到。

### 命令与脚本陷阱

- `node scripts/refresh-catalog.mjs` 会重写 `catalog.ts`；先 `--dry-run` 看增删改。CodeCommand `/models` 偶发 TLS/http2 失败（脚本会重试，但整次运行仍可能中止且不写文件）；重跑即可，不要在半途手动改 `catalog.ts`。
- 脚本不再自己维护端点表：它 import `extensions/custom-providers/{sources,env,builtin}.ts`（经 jiti，带 `@earendil-works/pi-ai` → compat 的 alias）。`sources.ts` 现在是**vendor 表**：`{ id, name, aliases, declaration: { api, baseUrl, modelsPath, apis } }`，生成器对 `declaration.api` + 每个 `apis.<api>` 各探一次（`ENDPOINTS`），合并时默认端点胜。改 baseUrl/envVar 只改 `sources.ts`。
- 「能力权威」不在这处重复实现：`reasoning`/`input`/`thinkingLevelMap` 都走 `builtin.ts` 的 `capabilityAuthority()` / `builtinLevelMap()`（生成器与运行期 `drift` 共用一份），所以 `drift` 里 `reasoning`/`input` 恒为 0；若哪天不为 0，说明 catalog 过期，重新生成即可。
- 脚本只写数据：schema 在 `types.ts`，生成物只有 `import type` + `CATALOG`。改字段要先改 `types.ts` 再改脚本里的 `freshModel`/`serialize` 字段表，两边不同步就会静默丢字段。
- `catalog.ts` 现在按 **vendor** 键（`commandcode` / `scnet`）分块，`Record<VendorId, CatalogModel[]>`；`scnet-anthropic` 这个键已经不存在（Anthropic 端点是 `apis."anthropic-messages"`）。
- `probeCaps()` 读的是能力页内嵌的 RSC（flight）数据，键名按**去日期后缀 + 小写**对齐（文档 `claude-haiku-4-5` vs 注册表 `claude-haiku-4-5-20251001`）。归一化前这类 id 会静默沿用旧值。键名对不上、以及内嵌数据与渲染表格自相矛盾，现在都会在脚本输出里列出来。
- CodeCommand `/models` 首次请求可能 TLS 重置，脚本已内建重试；断言失败前先重试。
### 路径与目录约定

- `extensions/custom-providers/`：`types.ts` 共享类型（手写）、`sources.ts` 端点表（手写，生成器也 import）、`config.ts` models.json 层 + 兄弟线继承、`env.ts` .env 解析（扩展与脚本共用）、`catalog.ts` 生成的数据、`builtin.ts` 内置目录交叉校验与 compat 吸收、`index.ts` 分层合并/注册/命令（含进程内 `liveSnapshots`）。
- `models.json` 只读：本扩展把它当覆盖层，从不写回。
- 一个 provider = 一个（端点 × 协议）：SCNet 两条线是两个 id，用 `siblingId` 共享凭据（不共享 models/baseUrl/api/compat）。

### 环境变量与凭证

- `CMD_API_KEY`（CodeCommand）、`SCNET_API_KEY`（SCNet 两条线）。
- 启动时从 `~/.pi/agent/.env` 与 `~/.omp/agent/.env` 补齐，已存在的环境变量不覆盖。
- 仓库与 README 不写密钥。
- CodeCommand 账号受限（2026-09-18 实测）：claude 系列全部 `MODEL_NOT_IN_PLAN`，部分 OpenAI 线模型 `insufficient credits`，所以目录里 claude 的 `reasoning`/`input` 只能在升级计划后实测。

### 其他

- **Anthropic 线的 baseUrl 不能带 `/v1`**：pi 把 `model.baseUrl` 原样交给 Anthropic SDK，SDK 自己拼 `/v1/messages`（`anthropic-messages.js` 里 `new Anthropic({ baseURL: model.baseUrl })`，无任何归一化）。CodeCommand 的 OpenAI 线是 `/provider/v1`、Anthropic 线是 `/provider`，差异写在 `sources.ts` 的 `anthropicBaseUrl`，注册时按模型 `api` 贴 `baseUrl`。实测：`/provider/v1/messages` → 403 `MODEL_NOT_IN_PLAN`（路由存在），`/provider/v1/v1/messages` → 404。pi 自带目录同规律（`opencode`: `/zen/v1` vs `/zen`）。
- `models-store.json` 里可能残留旧的（错误的）`baseUrl`：实测扩展注册的模型优先，脏快照不影响请求路径，下一次 `pi update --models` 会写回正确值（`session_start` 的刷新不写盘，因为走的是 `allowNetwork:false` 的 `registerProvider` 离线轮）。
- 验证请求路径的手段：把部署副本的 baseUrl 临时改成本地 mock（`/tmp/mock-gateway.mjs` 模式），`pi -p --no-tools --provider X --model Y` 跑一次，mock 会打出手里的真实路径（实测会看到 `POST /provider/v1/messages?beta=true`——`client.beta.messages` 会再加 `?beta=true`）。比读源码猜可靠。
- 用真请求验证网关时的坑：**403/40x 与 404 要分开读**——403 `MODEL_NOT_IN_PLAN` 说明路由存在、是账号计划问题；404 + `cause` 里写着具体 URL 才是路径错。选 URL 的代码不要把“非 200”当成“路径不对”，否则后续探针全打在错路径上（本次就踩过）。
- pi 的 `calculateCost()` / `provider-composer` 直接读 `model.cost.tiers`，注册模型必须带 `cost`，否则整轮报 `Cannot read properties of undefined (reading 'tiers')`。
- 实时 `/models` 只用于发现 id/上下文/显示名；已知模型的 `maxTokens`、`reasoning`、`input` 等不得被默认值覆盖。
- pi 内置目录可从扩展读取（loader 把 `@earendil-works/pi-ai` 映射到 compat 入口，导出 `getProviders`/`getModels`）。只允许吸收**少发参数**类字段：目前仅 `supportsTemperature: false`（仅 Anthropic 线，Opus 4.7+ 拒非默认温度）。改请求体形状的字段（`thinkingFormat`、`maxTokensField`、`supportsDeveloperRole`、`forceAdaptiveThinking` 等）是按上游域名调好的，套到中转站会 400，**不得吸收**；`reasoning`/`input`/`maxTokens`/`contextWindow` 只报告不覆盖。
- provider 注册支持 pi 的 `refreshModels` 钩子：`pi update --models`、凭据变更、联网启动都会触发；返回值**替换**扩展注册的模型列表（不是合并），并可用 `context.publish({ persist })` 写入 `~/.pi/agent/models-store.json`。迁移前 `session_start` 是唯一的自动刷新路径（现在两者并存）。
- **坑**：pi 的 `ModelRuntime.registerProvider` 结尾是 `void this.refresh({ allowNetwork: false })`（`model-runtime.js`），所以每次重新注册都会紧跟着跑一轮**离线** `refreshModels`。如果实现者在联网刷新后只把 live 结果注册进去而不落盘，这轮离线反射会把值降级回 catalog（`index.ts` 用进程内 `liveSnapshots` 顶住，优先级：memo > persisted > catalog；`tests/pi-native-test.mjs` 就是这个回归测试）。
- `refreshModels` 只有在凭据能解析（`resolveRefreshCredential`）时才会跑联网阶段；没配 key 时不会发网请求。`context.credential` 只在 `type === "api_key"` 时有 `key`。
- **坑**：pi 只认**模型级** compat。`applyExtension()`（`provider-composer.js`）用扩展给的模型定义重建每个模型，provider 级 `compat` 被丢弃；而 `models.json` 的 provider 级 `compat` 是在这之前被 `applyModelsJson()` 合并到内置模型表上的，随后也被同一个重建行为覆盖掉。所以对扩展注册的 provider，`models.json` 里写的 compat / `models[]` 都得我们自己再贴一遍（`index.ts` 的 `applyCompat`、`config.ts` 的 `sourceConfigFor` + `normalizeModel`）。不对应的后果是“看起来配了、其实无效”。
- **坑**：omp 的 provider 字段不是 pi 的字段。`disableStrictTools` / `replayUnsignedThinking`（来自 `~/.omp/agent/models.yml`）在整个 pi 包里没有任何读取点，抄进扩展只是死配置；写 provider 选项前先在 `$PI/dist` 里 grep 字段名。
- **坑**：UPPER_SNAKE 的明文值一律当**环境变量名**。`resolveApiKey` 旧实现变量未设置时会 `return value`，把变量名当密钥发出去（表现为莫名 401）。`apiKeyConfig` 与 `resolveApiKey` 必须保持同一判定。
- `claude-haiku-4-5-20251001` 的 `reasoning` 现为 `false`（能力页不标 Reasoning），因为键名对齐后能力页才真正生效。如实测确认支持 thinking，改回 `true` 并补 `thinkingLevelMap`。
- CodeCommand 能力页（https://commandcode.ai/docs/reference/cli/models）**自相矛盾且相对实时注册表陈旧**，不要单看渲染出来的表格：
  - 同一次抓取里，内嵌 flight 数据与渲染表格的 `aria-label` 只在 `claude-sonnet-5` 上不一致（flight `vision=false`、表格写 `Text input, Vision, Reasoning`）。
  - 两种视图都还挂着已不在实时注册表的 `gpt-6-astra` 和旧 id `claude-haiku-4-5`；flight 另缺 `deepseek/deepseek-v4-flash`。
  - 因此能力页只能当**弱证据**：68/70 与目录一致，2 个（`claude-haiku-4-5-20251001`、`deepseek/deepseek-v4-flash`）因 id 对不上而实际未采信。
- `claude-sonnet-5` 的 vision 三源冲突：能力页 flight `false`、能力页表格 `true`、上游 Anthropic 目录 `true`。当前目录取 `input:["text"]`（采信 flight，与 `scripts/refresh-catalog.mjs` 一致），未实测；改动前先确认。
- `codecommand` 的实时注册表在部分网络下首次请求 TLS/http2 失败（实测报 `http2ErrorCode: 2`），脚本已内建 3 次退避重试；手写探测脚本时也要重试。整次刷新可能因它中止，此时不会写文件，重跑即可。
- **SCNet 两条线服务的是同一批 id**（实测重叠 18/19，仅 `MiniMax-M2.5` 是 OpenAI 线独有）。它注册成两个 pi provider id 不是因为“模型表不同”，而是 pi 的硬约束：一个 provider id 内同 id 只能存在一份（`getModels(provider).find((m) => m.id === id)`，`pi-ai/dist/models.js`；我们的 `mergeCatalogModels` 也按 id 去重），而 `model.id` **就是**发给网关的 `model` 字段（`anthropic-messages.js:339`、`openai-completions.js:176` 均为 `model: model.id`），pi 没有独立的 wire-id/slug 字段。所以合并两条线必须给每个重叠 id 二选一，**按请求切协议做不到**。
- pi **没有 provider 别名机制**：`model-resolver.js` 里的 alias 只是“无日期模型 id 优先”，与 provider 无关；provider 身份就是 id。provider 级设置只有 `models.json` 的 `name`/`baseUrl`/`api`/`apiKey`/`headers`/`authHeader`/`compat`/`models[]`/`modelOverrides`/`oauth`，加上扩展侧的 `streamSimple`/`refreshModels`。
- `modelOverrides` 是**最高层且作用在扩展注册的模型之上**（`composeModelProvider` 的 `getModels()` = `applyExtension(...)` 之后再 `applyModelOverride`，源码注释自称 “topmost user-config layer … after … extension model replacement”），但 `ModelOverrideSchema` **没有 `api`/`baseUrl`**，`applyModelOverride` 也不处理这两个字段 → pi 原生**不能**按模型换 wire。它能改的是 `name`/`reasoning`/`thinkingLevelMap`/`input`/`cost`/`contextWindow`/`maxTokens`/`samplingParams`/`headers`/`compat`——这些字段用户可以直接在 `models.json` 覆盖我们的模型，扩展不必自己实现。
- `models.json` 的 schema 校验（`model-config.js` 的 `validateModelsConfig`）：类型错（`apiKey: 123`、`providers: "nope"`）会**整份丢弃**整个文件并报 `Invalid models.json schema`（所有 provider 一起消失），但**放行未知键**（塞 `providers.scnet.wire: "anthropic"` 能过校验）→ 扩展自定义的 provider 级开关不需要改 pi 就能读。
- **设计：同一 vendor 的两条线注册成一个 provider**（`Source.providerId` 分组，SCNet 的 `scnet-anthropic` → `providerId: "scnet"`）。理由：两条线服务同一批 id，一个 provider id 内同名 id 只能有一份；协议按**模型**选（`models.json` 的 `providers.<id>.wire`，支持 `"anthropic"` 简写与 `{ default, models }` 形式）。代价：凭据变成 provider 级（一条 key）、**不可能按请求换线**。想保留“一条线一个 provider + 随时切换”就得把 `providerId` 去掉，两种形态只能选一个。
- **坑（实现时先被测试拦住）**：把模型移到非默认线时，必须给它打上该线的 `api`。catalog 里的模型本身不带 `api`，只贴 `baseUrl` 会导致 pi 用 provider 级 `api`——**对正确的主机说错协议**（打到 Anthropic 端点发 chat/completions）。规则：`wire !== primary` 时同时贴 `api` 与 `baseUrl`。
- **坑**：provider 级 `models[]` 里声明的模型必须并入该 provider 的**每一条** wire，否则用户为它选了另一条线也挪不过去（那条线的列表里根本没这个 id）。实现：非默认线的 config 里 `models = 去重(默认线声明 + 该线自己的声明)`，该线自己的条目胜出。
- **compat 的归属按线**：`providers.scnet.compat` 只贴默认线的模型，`providers["scnet-anthropic"].compat` 只贴 Anthropic 线的模型。被移线的模型不会带走默认线的 provider 级 compat（catalog-test 里有判别性断言）。
- **合并后的验证手段（已实测）**：把**部署副本**的 `sources.ts` 两条 baseUrl 临时指向本地 mock（`/tmp/mock-gateway.mjs`），一次运行里就能看到同一个 provider 内不同模型走不同路径——`GLM-5.2`（wire=anthropic）→ `POST /anthropic/v1/messages?beta=true`，`DeepSeek-V4-Flash`（默认线）→ `POST /openai/chat/completions`，且两条线的 `/models` 都被探测。改完重新拷贝部署副本即还原。
- `models-store.json` 里会残留旧的 `scnet-anthropic` 条目：合并后没有任何读取方（新持久化只写 `scnet`），无害；它不会被自动清掉。
- `scripts/refresh-catalog.mjs --dry-run` **需要网络**且会依次探测所有线：`commandcode.ai` 连不上时直接抛 `ConnectTimeoutError` 退出，这是网络问题而不是幂等失败，别误判成目录漂移。
- **缺凭据不会在注册时抛错**（本机实测，修正早先推断）：`composeModelProvider` 里那句 `no authentication method configured` 实际几乎不可达（`composeApiKeyAuth` 在「无 key 且无 oauth」时仍返回对象而非 `undefined`）。真实后果：该 provider 的模型**不进可用快照**（`configuredProviders` 不含它 → picker 里看不到，实测 `getAvailableSnapshot()` = 0）；请求时 `authHeader: true` 报 `No API key found for "<id>"`，`authHeader: false` 则**不带 `Authorization` 静默发出**（网关 401）。所以「无凭据的账号不注册 + 启动时报告」是扩展主动选择，不是 pi 逼的。
- **实测（`ModelRuntime` 真运行时）**：模型条目自带 `api`+`baseUrl`、provider 级什么都不给，注册与 `getModels()` 都正常（provider 级只是 fallback）；模型条目上的未知键 `wire` 会被 pi **原样保留**（`{...definition, api, provider, baseUrl, headers: undefined}` 是展开拷贝）；`ModelRuntime.create(...)` 返回 **Promise**，忘了 `await` 会得到 `registerProvider is not a function`。

### 引擎行为（v4.0）

- 四个自有词汇之外全部是 pi 的字段：`apis`(第二协议端点) / `modelsPath`(发现路径) / `override`(接管内置 id) / `accounts.json`。协议用 pi 的 `api` 值，别名（`openai`/`chat`、`anthropic`/`messages`、`responses`）在加载时归一。
- 落端点规则：默认协议上的模型**不带** `api`/`baseUrl`（保住 `providers.<id>.baseUrl` 的重定向能力）；非默认协议两者都带，名字加 ` (协议)`。实现见 `config.ts` 的 `resolveModelEndpoint()`，别在别处再写一套。
- 写盘只有两条且都在明面上：`sync --write`（先留 `.bak`，写基底 ⊕ 发现）与 pi 自己的 `models-store.json` 缓存。扩展永不写 `models.json`。
- 报告一律走 `ctx.ui.notify` 并裁剪（8 行 + `(+N more)`）；扩展**不写 stderr**。
- 目录名撞内置 vendor 的 `aliases`（如同时有 `commandcode/` 与 `codecommand/`）会跳过后者并报告：两个目录会争同一个 provider 的配置。
