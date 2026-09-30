# Attention

本文件是 CodeStable 技能启动必读的项目注意事项入口。所有 CodeStable 子技能开始工作前必须读取它。

## 报告语言

CodeStable 所有落盘产出的正文用**中文**：plan / design、plan review / design-review、code review、QA、验收、issue（report / analysis / fix-note）、refactor、roadmap、goal、沉淀（compound）等所有人读报告都用中文表达。机器状态（YAML / JSON / `state.yaml` / frontmatter 字段）保持机读格式不翻译。如需改默认语言，改这一节。

## 版本号与发版规则（semver）

发布 tag 用 `vMAJOR.MINOR.PATCH`，严格按 semver（2026-09-30 起生效，推翻此前「只有引擎换代才升 minor」的旧实践）：

- **新增 feature → MINOR**（如 v0.2.4 → v0.3.0）。
- **破坏性变更（`feat!` / `BREAKING CHANGE`）→ MINOR**（0.x 阶段；1.0 之后改升 MAJOR）。
- **bug fix / 文档 / chore → PATCH**（如 v0.2.3 → v0.2.4）。

发版流程（`node tests/run-all.mjs` 全绿 → commit → annotated tag → 双远端分推 master + tag → `pi install ...@<tag>` 重 pin → `~/.pi` pin 提交推送）见 `.agents/skills/pi-custom-providers-release-install/SKILL.md`。

- **未发版状态（2026-09-30）**：v0.4.0 已本地提交（`b5d8e4c` + 两轮审计修复）但**未打 tag、未推送**，`~/.pi` 里的 pin 仍是 `@v0.3.0`；README 已按**将要发布**的 `@v0.4.0` 写，打 tag 后才成立。

## 已知技术债（明确未做，不是遗漏）

- 当前没有待办项（2026-09-30 清零）：`index.ts` 编排器已拆分（见「路径与目录约定」）、测试脚手架合并到 `harness.mjs`、账号撞 id 检查已实现（见「引擎行为（v4.0）」）。
- `sync` 会解析同一份 `<id>/models.json` 两次（`collectVendors` 校验一次，`readBaseTable` 为了拿当前磁盘状态再读一次）；第二次是刻意的（用户可能刚改过文件），`cloneById` 会把未校验行缺的 `input` 补齐。这是设计，不是待修项。

## 项目碎片知识

<!-- cs-note managed: 用 cs-note 维护，新条目按下面分节追加 -->

### 编译与构建

- 无 `package.json`、无 bundler、无 npm 依赖：pi 按约定目录 `extensions/` 发现入口，TS 由 pi 的 jiti loader 现场加载。不要加回 `package.json`（含 manifest 的 git 包会触发 `npm install`）。

### 运行与本地起服务

- 本地部署（开发时）：`rm -rf ~/.pi/agent/extensions/custom-providers && cp -R extensions/custom-providers ~/.pi/agent/extensions/`，随后在 pi 里 `/reload`。
- 部署副本与 `pi install` 包安装**二选一**，同时用会双加载、provider 注册两次。

### 测试

- `node tests/run-all.mjs` 跑全部（14 个）；新增/改名后不用改清单（`run-all` 按目录扫）。单跑 `node tests/apis-test.mjs` / `provider-files-test.mjs` / `accounts-test.mjs` / `sync-test.mjs` / `vanished-test.mjs` / `convention-test.mjs` / `responses-test.mjs` / `pi-native-test.mjs`。
- 测试通过 pi 自己的 jiti loader 加载 TS（见 `tests/harness.mjs`），不写 `~/.pi`；`PI_PKG` 可指定 pi 安装目录。
- `tests/harness.mjs` 在导入被测代码前把 `PI_CODING_AGENT_DIR` 指向临时目录：不这样会被 `getAgentDir()` 带回你真实的 `~/.pi/agent/models.json`，断言会随本机配置变化（曾因此把 scnet 的 `compat` 覆盖进测试）。
- `models-test.mjs` 校验 `tests/fixtures/models.json`（仓库里唯一的模型数据）并调用 pi-ai 的 `calculateCost()`，是「模型缺 `cost` 就崩」的回归防线。
- 测试用的模型表来自 `tests/fixtures/models.json`：`seedDefaultProviders()` 把它写成各 vendor 目录的 `models.json`。仓库本身不带模型表。
- `tests/pi-native-test.mjs` 用 pi 真正的 `ModelRuntime` 跑 `registerProvider → refresh → publish`，全程打桩 `fetch` + 内存 store；改动 `refreshModels`/持久化时先跑它。
- 测试里**不要留着真 `fetch`**：一旦某段走了真网络，断言就随网速/代理时好时坏（曾出现“同一测试三次跑两样”）。每个改 `globalThis.fetch` 的段落都要在 `finally` 里恢复。`harness.mjs` 的 `sessionStart()` 已内置「离线 fetch」包装（`session_start` 会发真请求）；想测在线刷新就自己打桩后直接调 `provider.refreshModels({allowNetwork:true,...})`。
- `harness.mjs` 的 `startExtension()` 是唯一入口：写 `agentPath("models.json")` / `agentPath("custom-providers", "<id>", ...)` 之后再调它。jiti 的 `moduleCache:false` 让每次 `loadTs` 都是新实例，所以「发现结果 memo」要在**同一个** `startExtension()` 返回值上触发（`ext.providers.get(id).refreshModels(...)`），另起一个实例看不到。

### 发现与写盘陷阱

- 仓库**不带模型表**（v0.4.0 起）：基底 = `<id>/models.json`；没有它则该 provider 注册 0 个模型，等发现或用户补表。生成器 `scripts/refresh-catalog.mjs` 与 `catalog.ts` 已删除。
- **空列表 ≠ 目录漂移（2026-09-19 实测，本机 raw curl，非扩展）**：SCNet token plan 配额耗尽时，chat/completions 与 anthropic messages 都返回 **HTTP 429** `Token Plan quota has been exceeded`（两条线一致）；同一时刻 `GET /api/llm/v1/models` 与 `GET /api/llm/anthropic/v1/models` 仍返回 **HTTP 200 + 空数组**（`{"object":"list","data":[]}` / `{"data":[],"has_more":false,...}`），不是 401/429。所以「消失」判定必须要求该 vendor 的所有可发现端点本轮都成功且非空；空数组与失败同等待遇（不报不删），否则配额耗尽会把整张表当 removed。
- 运行期安全：`applyLiveModels()` 只增不删（`rows` 为空时原样返回；已知 id 只更新 name/contextWindow，新 id 才追加），基底表与 `models-store.json` 里的快照都不会被空列表抹掉。发现不再返回的 id 由 `refreshEntry()` 在**该 vendor 所有可发现端点本轮都成功且非空**时算出（取各端点答案并集）并进 `problemLines()` 报告；默认**保留**，只有 `sync <id> --write --prune` 才从 `models.json` 删。未知新 id 的 `reasoning`/`thinkingLevelMap` **不从 pi 内置目录兜底**（已否决）：能力只信上游信息/探测结果。上游不给时走 `convention.ts` 惯例兜底：① 同族继承（基底表里第一条同族条目的 `reasoning`，anthropic 线连 `thinkingLevelMap` 一起继承）；② `CONVENTION_FAMILIES` 已知家族名单（精确匹配 `familyKey()`，anthropic 线补 `{xhigh,max}`，其它线不补 map）；两步不命中才 `reasoning:false`。

### 路径与目录约定

- `extensions/custom-providers/`：`types.ts` 共享类型（手写）、`sources.ts` 端点表（手写）、`config.ts` pi api 词汇 + `models.json` 层（第 3 层复刻）、`env.ts` .env 解析 + pi 值语法解析、`builtin.ts` 内置目录交叉校验与 compat 吸收、`convention.ts` 未知新 id 的能力惯例兜底（同族继承 + 家族名单）、`provider-files.ts` 目录层（扫描 / 逐文件校验 / 接管白名单 + `writeProviderFile` 写 `provider.json`）、`providers.ts` 目录 → 可注册 provider（条目展开 + 分层合并 + 基底视图）、`live.ts` 发现与「wire 答案怎么并进表」的规则（含进程内 `liveSnapshots`/`vanishedByVendor`/`lastErrors`）、`status.ts` 每 provider 状态与问题文本、`sync-models.ts` `models.json` 的 diff + 写盘（`sync --write` 的唯一路径）、`util.ts` JSON 对象类型 + 三个 JSON 守卫（依赖图的叶子，不 import 任何本地模块）、`index.ts` 扩展接线（`registerEntry`、`statusOf`、五个命令分支 `runInit`/`runDrift`/`runFiles`/`runSync`/`runStatus`、钩子）。`tests/fixtures/models.json` 是测试用的模型表。
- pi 全局的 `models.json` 只读：本扩展把它当覆盖层，从不写回。本扩展只写自己目录里的文件：`provider.json`（`init`）与 `models.json`（`sync --write`）。
- 一个 provider = 一个 **vendor**（不是一条线）：SCNet 的两条线注册成一个 `scnet`，第二条线由 `provider.json` 的 `apis."anthropic-messages"` 描述，模型级 `api` 选线；凭据是 provider 级（一条 key）。
- `extensions/custom-providers/` 目前**扁平放置**（13 文件 / 2200 行）：pi 发现只需 `extensions/<name>/index.ts` 这一层，模块之间的相对 import 可以自由嵌套，所以扁平只是可读性选择。真需要分组时的触发条件：文件 >20 个或单文件 >600 行。
- `tests/` **必须保持扁平**：`run-all.mjs` 是 `readdirSync` 单层扫描（不递归），放进子目录的测试会静默不被执行。`tests/fixtures/` 是数据不是测试（当前唯一的子目录）。
- `.codestable/reference/`（12 份框架文档）与 `.codestable/gates/` 由 CodeStable 插件管理（`.codestable/runtime-manifest.json` 的 `managed_paths`，`updated_by: codestable-runtime-sync`）：**手改会被下次同步覆盖**，项目自己的文档是 `attention.md` 与 `features/<epic>/`。
- 模块依赖图**无环**且每个模块都能从 `index.ts` 到达，由 `tests/graph-test.mjs` 守护（含 type-only 回边：`util.ts` 是叶子，`JsonObject` 这类共享类型放叶子模块才不会成环）。
- `.agents/`（记忆、会话日志、技能）整体 gitignored，不进仓库、不进 tag。

### 环境变量与凭证

- `CMD_API_KEY`（Command Code）、`SCNET_API_KEY`（SCNet 两条线）。
- 启动时从 `~/.pi/agent/.env` 与 `~/.omp/agent/.env` 补齐，已存在的环境变量不覆盖。
- 仓库与 README 不写密钥。
- Command Code 账号受限（2026-09-18 实测）：claude 系列全部 `MODEL_NOT_IN_PLAN`，部分 OpenAI 线模型 `insufficient credits`，所以目录里 claude 的 `reasoning`/`input` 只能在升级计划后实测。

### 其他

- **Anthropic 线的 baseUrl 不能带 `/v1`**：pi 把 `model.baseUrl` 原样交给 Anthropic SDK，SDK 自己拼 `/v1/messages`（`anthropic-messages.js` 里 `new Anthropic({ baseURL: model.baseUrl })`，无任何归一化）。Command Code 的 OpenAI 线是 `/provider/v1`、Anthropic 线是 `/provider`，差异写在各 vendor 的 `apis."anthropic-messages".baseUrl`（`sources.ts` 或目录 `provider.json`），注册时按模型 `api` 贴 `baseUrl`。实测：`/provider/v1/messages` → 403 `MODEL_NOT_IN_PLAN`（路由存在），`/provider/v1/v1/messages` → 404。pi 自带目录同规律（`opencode`: `/zen/v1` vs `/zen`）。
- `models-store.json` 里可能残留旧的（错误的）`baseUrl`：实测扩展注册的模型优先，脏快照不影响请求路径，下一次 `pi update --models` 会写回正确值（`session_start` 的刷新不写盘，因为走的是 `allowNetwork:false` 的 `registerProvider` 离线轮）。
- 验证请求路径的手段：把部署副本的 baseUrl 临时改成本地 mock（`/tmp/mock-gateway.mjs` 模式），`pi -p --no-tools --provider X --model Y` 跑一次，mock 会打出手里的真实路径（实测会看到 `POST /provider/v1/messages?beta=true`——`client.beta.messages` 会再加 `?beta=true`）。比读源码猜可靠。
- 用真请求验证网关时的坑：**403/40x 与 404 要分开读**——403 `MODEL_NOT_IN_PLAN` 说明路由存在、是账号计划问题；404 + `cause` 里写着具体 URL 才是路径错。选 URL 的代码不要把“非 200”当成“路径不对”，否则后续探针全打在错路径上（本次就踩过）。
- pi 的 `calculateCost()` / `provider-composer` 直接读 `model.cost.tiers`，注册模型必须带 `cost`，否则整轮报 `Cannot read properties of undefined (reading 'tiers')`。
- 实时 `/models` 只用于发现 id/上下文/显示名；已知模型的 `maxTokens`、`reasoning`、`input` 等不得被默认值覆盖。
- pi 内置目录可从扩展读取（loader 把 `@earendil-works/pi-ai` 映射到 compat 入口，导出 `getProviders`/`getModels`）。只允许吸收**少发参数**类字段：目前仅 `supportsTemperature: false`（仅 Anthropic 线，Opus 4.7+ 拒非默认温度）。改请求体形状的字段（`thinkingFormat`、`maxTokensField`、`supportsDeveloperRole`、`forceAdaptiveThinking` 等）是按上游域名调好的，套到中转站会 400，**不得吸收**；`reasoning`/`input`/`maxTokens`/`contextWindow` 只报告不覆盖。
- provider 注册支持 pi 的 `refreshModels` 钩子：`pi update --models`、凭据变更、联网启动都会触发；返回值**替换**扩展注册的模型列表（不是合并），并可用 `context.publish({ persist })` 写入 `~/.pi/agent/models-store.json`。迁移前 `session_start` 是唯一的自动刷新路径（现在两者并存）。
- **坑**：pi 的 `ModelRuntime.registerProvider` 结尾是 `void this.refresh({ allowNetwork: false })`（`model-runtime.js`），所以每次重新注册都会紧跟着跑一轮**离线** `refreshModels`。如果实现者在联网刷新后只把 live 结果注册进去而不落盘，这轮离线反射会把值降级回基底表（`live.ts` 用进程内 `liveSnapshots` 顶住，优先级：memo > persisted > 基底表；`tests/pi-native-test.mjs` 就是这个回归测试）。
- `refreshModels` 只有在凭据能解析（`resolveRefreshCredential`）时才会跑联网阶段；没配 key 时不会发网请求。`context.credential` 只在 `type === "api_key"` 时有 `key`。
- **坑**：pi 只认**模型级** compat。`applyExtension()`（`provider-composer.js`）用扩展给的模型定义重建每个模型，provider 级 `compat` 被丢弃；而 `models.json` 的 provider 级 `compat` 是在这之前被 `applyModelsJson()` 合并到内置模型表上的，随后也被同一个重建行为覆盖掉。所以对扩展注册的 provider，`models.json` 里写的 compat / `models[]` 都得我们自己再贴一遍（`providers.ts` 的 `synthesizeModels()`、`config.ts` 的 `applyModelPatch()` + `resolveModelEndpoint()`）。不对应的后果是“看起来配了、其实无效”。
- **坑**：omp 的 provider 字段不是 pi 的字段。`disableStrictTools` / `replayUnsignedThinking`（来自 `~/.omp/agent/models.yml`）在整个 pi 包里没有任何读取点，抄进扩展只是死配置；写 provider 选项前先在 `$PI/dist` 里 grep 字段名。
- **坑**：UPPER_SNAKE 的明文值一律当**环境变量名**。`resolveApiKey` 旧实现变量未设置时会 `return value`，把变量名当密钥发出去（表现为莫名 401）。`apiKeyConfig` 与 `resolveApiKey` 必须保持同一判定。
- Command Code 能力页（https://commandcode.ai/docs/reference/cli/models）**自相矛盾且相对实时注册表陈旧**，不要单看渲染出来的表格：
  - 同一次抓取里，内嵌 flight 数据与渲染表格的 `aria-label` 只在 `claude-sonnet-5` 上不一致（flight `vision=false`、表格写 `Text input, Vision, Reasoning`）。
  - 两种视图都还挂着已不在实时注册表的 `gpt-6-astra` 和旧 id `claude-haiku-4-5`；flight 另缺 `deepseek/deepseek-v4-flash`。
  - 因此能力页只能当**弱证据**：以实时注册表/实测为准。
- `claude-sonnet-5` 的 vision 三源冲突：能力页 flight `false`、能力页表格 `true`、上游 Anthropic 目录 `true`。仓库不再固化该值（v0.4.0）；要用就在自己的 `models.json` 里定并实测。
- `commandcode` 的实时注册表在部分网络下首次请求 TLS/http2 失败（实测报 `http2ErrorCode: 2`）：手写探测脚本要退避重试；运行期发现失败只保留上一次快照并报告。
- **SCNet 两条线服务的是同一批 id**（实测重叠 18/19，仅 `MiniMax-M2.5` 是 OpenAI 线独有）。它们注册成**一个** `scnet`（v4.0 起）不是因为“模型表不同”，而是 pi 的硬约束：一个 provider id 内同 id 只能存在一份（`getModels(provider).find((m) => m.id === id)`，`pi-ai/dist/models.js`），而 `model.id` **就是**发给网关的 `model` 字段（`anthropic-messages.js:339`、`openai-completions.js:176` 均为 `model: model.id`），pi 没有独立的 wire-id/slug 字段。所以同一 id 只能挂在一条线上，**按请求切协议做不到**。
- pi **没有 provider 别名机制**：`model-resolver.js` 里的 alias 只是“无日期模型 id 优先”，与 provider 无关；provider 身份就是 id。provider 级设置只有 `models.json` 的 `name`/`baseUrl`/`api`/`apiKey`/`headers`/`authHeader`/`compat`/`models[]`/`modelOverrides`/`oauth`，加上扩展侧的 `streamSimple`/`refreshModels`。
- `modelOverrides` 是**最高层且作用在扩展注册的模型之上**（`composeModelProvider` 的 `getModels()` = `applyExtension(...)` 之后再 `applyModelOverride`，源码注释自称 “topmost user-config layer … after … extension model replacement”），但 `ModelOverrideSchema` **没有 `api`/`baseUrl`**，`applyModelOverride` 也不处理这两个字段 → pi 原生**不能**按模型换 wire。它能改的是 `name`/`reasoning`/`thinkingLevelMap`/`input`/`cost`/`contextWindow`/`maxTokens`/`samplingParams`/`headers`/`compat`——这些字段用户可以直接在 `models.json` 覆盖我们的模型，扩展不必自己实现。
- `models.json` 的 schema 校验（`model-config.js` 的 `validateModelsConfig`）：类型错（`apiKey: 123`、`providers: "nope"`）会**整份丢弃**整个文件并报 `Invalid models.json schema`（所有 provider 一起消失），但**放行未知键**（塞 `providers.scnet.wire: "anthropic"` 能过校验）→ 扩展自定义的 provider 级开关不需要改 pi 就能读。
- **设计：同一 vendor 的两条线注册成一个 provider**（`sources.ts` 的 `apis` 声明额外端点，键就是 pi 的 `api` 值）。理由：两条线服务同一批 id，一个 provider id 内同名 id 只能有一份；协议按**模型**选（`provider.json` 或 pi 全局 `models.json` 的 `providers.<id>.models[].api`）。代价：凭据变成 provider 级（一条 key）、**不可能按请求换线**。想保留“一条线一个 provider + 随时切换”就得给第二条线单开一个目录，两种形态只能选一个。
- **坑（实现时先被测试拦住）**：把模型移到非默认协议时，必须给它打上该线的 `api`。基底表里的模型本身不带 `api`，只贴 `baseUrl` 会导致 pi 用 provider 级 `api`——**对正确的主机说错协议**（打到 Anthropic 端点发 chat/completions）。规则：非默认协议时同时贴 `api` 与 `baseUrl`。
- **坑**：provider 级 `models[]` 里声明的模型必须并入该 provider 的**每一条**协议线，否则用户为它选了另一条线也挪不过去（那条线的列表里根本没这个 id）。实现：非默认线的 config 里 `models = 去重(默认线声明 + 该线自己的声明)`，该线自己的条目胜出。
- **compat 的归属按模型**：provider 级 `compat` 由我们折到该 provider 的模型上；只想给某一条线，就写在 `models.json` 的模型条目里（v4.0 起不再有“按线分 provider”这回事）。
- **合并后的验证手段（已实测）**：把**部署副本**的 `sources.ts` 两条 baseUrl 临时指向本地 mock（`/tmp/mock-gateway.mjs`），一次运行里就能看到同一个 provider 内不同模型走不同路径——`GLM-5.2`（协议=anthropic）→ `POST /anthropic/v1/messages?beta=true`，`DeepSeek-V4-Flash`（默认线）→ `POST /openai/chat/completions`，且两条线的 `/models` 都被探测。改完重新拷贝部署副本即还原。
- `models-store.json` 里会残留旧的 `scnet-anthropic` 条目：合并后没有任何读取方（新持久化只写 `scnet`），无害；它不会被自动清掉。
- **缺凭据不会在注册时抛错**（本机实测，修正早先推断）：`composeModelProvider` 里那句 `no authentication method configured` 实际几乎不可达（`composeApiKeyAuth` 在「无 key 且无 oauth」时仍返回对象而非 `undefined`）。真实后果：该 provider 的模型**不进可用快照**（`configuredProviders` 不含它 → picker 里看不到，实测 `getAvailableSnapshot()` = 0）；请求时 `authHeader: true` 报 `No API key found for "<id>"`，`authHeader: false` 则**不带 `Authorization` 静默发出**（网关 401）。所以「无凭据的账号不注册 + 启动时报告」是扩展主动选择，不是 pi 逼的。
- **实测（`ModelRuntime` 真运行时）**：模型条目自带 `api`+`baseUrl`、provider 级什么都不给，注册与 `getModels()` 都正常（provider 级只是 fallback）；模型条目上的未知键（例如早先版本用的 `wire`）会被 pi **原样保留**（`{...definition, api, provider, baseUrl, headers: undefined}` 是展开拷贝）；`ModelRuntime.create(...)` 返回 **Promise**，忘了 `await` 会得到 `registerProvider is not a function`。

### 引擎行为（v4.0）

- 四个自有词汇之外全部是 pi 的字段：`apis`(第二协议端点) / `modelsPath`(发现路径) / `override`(接管内置 id) / `accounts.json`。协议用 pi 的 `api` 值，别名（`openai`/`chat`、`anthropic`/`messages`、`responses`）在加载时归一。
- 落端点规则：默认协议上的模型**不带** `api`/`baseUrl`（保住 `providers.<id>.baseUrl` 的重定向能力）；非默认协议两者都带，名字加 ` (协议)`。实现见 `config.ts` 的 `resolveModelEndpoint()`，别在别处再写一套。
- 写盘只有两条且都在明面上：`provider.json`（`init` → `provider-files.ts` 的 `writeProviderFile`）与 `<id>/models.json`（`sync --write` → `sync-models.ts` 的 `writeBaseTable`，先留 `.bak`，写基底 ⊕ 发现）；pi 自己的 `models-store.json` 快照由 pi 落盘。扩展永不写 **pi 全局**的 `models.json`。
- 报告一律走 `ctx.ui.notify` 并裁剪（8 行 + `(+N more)`）；扩展**不写 stderr**。
- 目录名撞内置 vendor 的 `aliases`（如同时有 `commandcode/` 与 `codecommand/`）会跳过后者并报告：两个目录会争同一个 provider 的配置。
- **没有内置 provider（2026-09-22 改）**：`sources.ts` 的 `DEFAULTS` 只在**同名目录存在**时作基底（端点 / 密钥变量），`collectVendors` 不再预置它 —— 没目录就没 provider。因此旧警示 `replaces the built-in definition` 整段删除（连同测试）。命中 **pi 自带** provider id 仍需 `"override": true`（另一分支，不变）。`/custom-providers init [<id>] [--force]` 把默认端点写成 `<id>/provider.json`（已存在不动）。
- **不带模型表（v0.4.0）**：出厂 vendor 不再有模型表；目录只有 `provider.json` 时注册 0 个模型。模型来自 `<id>/models.json`（用户表）或实时发现（`sync --write` 可把发现写回基底）。`builtin.ts` 的 `capabilityAuthority`/`builtinLevelMap` 随生成器一起删除，多数票逻辑只剩 `summarizeDrift` 内联使用。
- **账号 id 撞车（2026-09-30 实现，设计 §7/§10 #13）**：`providers.ts` 的 `collectEntries()` 先占住「pi 已有 id（`piProviderIds`）+ 所有目录 vendor id」，再逐个分配账号 id；冲突的账号**跳过 + 进 `globalIssues` 报告**（其余账号与 `<id>` 不受影响）。用户 `models.json` 里声明的 `providers.<id>-<name>` **不**算占位——那是该账号自己的配置块（`providerLayerFor(entry.id, ...)`），列进去会把多账号覆盖功能一刀切掉（`tests/accounts-test.mjs` 守住这两侧）。
