# Attention

本文件是 CodeStable 技能启动必读的项目注意事项入口。所有 CodeStable 子技能开始工作前必须读取它。

## 索引

- 规则三节：报告语言 · 版本号与发版规则 · 已知技术债
- **项目碎片知识**（主题小节，顺序即阅读顺序）：编译与构建 · 运行与本地起服务 · 测试 · 发现与写盘陷阱 · 路径与目录约定 · 数据流 · 单元归属 · 分层与接口 · pi 各协议的 baseUrl 拼接 · 环境变量与凭证 · 端点、
  协议与请求路径 · pi 的字段与 schema · pi 的注册与刷新钩子 · pi 的坑与易错点 · 模型快照残留 · 上游站实测与验证手段 · 设计取舍 · 接管面 · 引擎行为
- 找不到某个事实：先按主题扫上面这一行，再 grep 关键词（本文件是「必读入口」，不是教程）。

## 报告语言

CodeStable 所有落盘产出的正文用**中文**：plan / design、plan review / design-review、code review、QA、验收、issue（report / analysis / fix-note）、refactor、roadmap、goal、沉淀（compound）等所有人读报告都用中文表达。
机器状态（YAML / JSON / `state.yaml` / frontmatter 字段）保持机读格式不翻译。如需改默认语言，改这一节。

## 版本号与发版规则（semver）

发布 tag 用 `vMAJOR.MINOR.PATCH`，严格按 semver（0.x 阶段 feature 与破坏性变更都升 MINOR）：

- **新增 feature → MINOR**（如 v0.2.4 → v0.3.0）。
- **破坏性变更（`feat!` / `BREAKING CHANGE`）→ MINOR**（0.x 阶段；1.0 之后改升 MAJOR）。
- **bug fix / 文档 / chore → PATCH**（如 v0.4.0 → v0.4.1）。

发版流程（`node tests/run-all.mjs` 全绿 → commit → annotated tag → 双远端分推 master + tag → `pi install ...@<tag>` 重 pin → `~/.pi` pin 提交推送）见 `.agents/skills/pi-custom-providers-release-install/SKILL.md`。

- **当前已发版 = `v0.5.3`**（纯测试 + 文档的 PATCH，`extensions/` 零改动）：把文档形态的六条规则搬进 `docs-structure-test.mjs`（含 v0.5.1 漏出厂围栏 bug 的根因），套件数 24 → 25。
  - 破坏性变更仍自 `v0.5.0` 起（见 README 迁移段）；tag 已推双远端，`~/.pi` 的 pin = `@v0.5.3`，README 安装行与本文一致。

## 已知技术债（明确未做，不是遗漏）

- 当前没有待办项（2026-10-01 清零）；闭合记录见 `audits/2026-10-03-history-and-closures.md`。



## 项目碎片知识

<!-- cs-note managed: 用 cs-note 维护，新条目按下面分节追加 -->

### 编译与构建

- 无 `package.json`、无 bundler、无 npm 依赖：pi 按约定目录 `extensions/` 发现入口，TS 由 pi 的 jiti loader 现场加载。不要加回 `package.json`（含 manifest 的 git 包会触发 `npm install`）。

### 运行与本地起服务

- 本地部署（开发时）：`rm -rf ~/.pi/agent/extensions/custom-providers && cp -R extensions/custom-providers ~/.pi/agent/extensions/`，随后在 pi 里 `/reload`。
- 部署副本与 `pi install` 包安装**二选一**，同时用会双加载、provider 注册两次。

### 测试

- `node tests/run-all.mjs` 跑全部（25 个；`harness.mjs`/`run-all.mjs` 不是用例）；新增/改名后不用改清单（`run-all` 按目录扫）。单跑例如 `node tests/apis-test.mjs` / `directory-test.mjs` / `accounts-test.mjs` /
   `credential-test.mjs` / `sync-test.mjs` / `vanished-test.mjs` / `convention-test.mjs` / `responses-test.mjs` / `env-test.mjs` / `pi-surface-test.mjs` / `pi-native-test.mjs`。

- `credential-test.mjs` 守发现探针的凭据：顺序（本次会话 → 账号 → pi 全局 `models.json` 的 provider 层）、auth 形态（协议默认 + `authHeader` 补 `Authorization: Bearer`）、以及无凭据时不发请求。
  形态不靠注释：bearer 那条对着 pi 自己的 `composeModelProvider`（拿我们真注册的 payload 跑）断言，`x-api-key`/`anthropic-version` 对着 pi-ai 实际用的 Anthropic SDK 的真请求头断言。
- `env-test.mjs` 把 `env.ts` 的值语法（含 `!command` 跑在哪个 shell）逐例对照 pi 自己的 `resolveConfigValueUncached`；
  `pi-surface-test.mjs` 把 `MODEL_KEYS` 与 pi 的 `ModelDefinitionSchema` 双向对照（从 `dist/core/model-config.js` 读，pi 不导出它）并做全字段读写往返。这两个事实 pi 都不导出，只能这样钉。
  `graph-test.mjs` 另守 `apis.ts` 与 `util.ts` 两个图叶子（词汇层不许长出依赖）。
- `docs-structure-test.mjs` 守 tracked 文档的形状：围栏成对（闭合围栏不带 info string、不短于开启者）、每张表的行与表头格数一致且都有分隔行、散文行 ≤200 字（表格行与围栏内行豁免）、标题前有空行、缩进条目不悬空（上方同一列表里得有更浅的条目）、文档写的套件数 == `tests/` 实际数。
  立这条是因为这类检查原先只在仓库外的手工脚本里：v0.5.1 的 `README.md` 带着一个未闭合的围栏出厂（后面两段被渲染成代码），而当时那个脚本只翻转一个布尔、从不校验配对。

**各测试文件的职责与纪律**

- 测试通过 pi 自己的 jiti loader 加载 TS（见 `tests/harness.mjs`），不写 `~/.pi`；`PI_PKG` 可指定 pi 安装目录。
- `tests/harness.mjs` 在导入被测代码前把 `PI_CODING_AGENT_DIR` 指向临时目录：不这样会被 `getAgentDir()` 带回你真实的 `~/.pi/agent/models.json`，断言会随本机配置变化。

- `models-test.mjs` 校验 `tests/fixtures/models.json`（仓库里唯一的模型数据）并调用 pi-ai 的 `calculateCost()`，是「模型缺 `cost` 就崩」的回归防线。
- 测试用的模型表来自 `tests/fixtures/models.json`：`seedDefaultProviders()` 把它写成各 vendor 目录的 `models.json`。仓库本身不带模型表。
- `tests/pi-native-test.mjs` 用 pi 真正的 `ModelRuntime` 跑 `registerProvider → refresh → publish`，全程打桩 `fetch` + 内存 store；改动 `refreshModels`/持久化时先跑它。

- 测试里**不要留着真 `fetch`**：一旦某段走了真网络，断言就随网速/代理时好时坏。每个改 `globalThis.fetch` 的段落都要在 `finally` 里恢复。`harness.mjs` 的 `sessionStart()` 已内置「离线 fetch」包装（`session_start` 会发真请求）；
  想测在线刷新就自己打桩后直接调 `provider.refreshModels({allowNetwork:true,...})`。
- `harness.mjs` 的 `startExtension()` 是唯一入口：写 `agentPath("models.json")` / `agentPath("custom-providers", "<id>", ...)` 之后再调它。
  jiti 的 `moduleCache:false` 让每次 `loadTs` 都是新实例，所以「发现结果 memo」要在**同一个** `startExtension()` 返回值上触发（`ext.providers.get(id).refreshModels(...)`），另起一个实例看不到。

### 发现与写盘陷阱

- 仓库**不带模型表**：基底 = `<id>/models.json`；没有它则该 provider 注册 0 个模型，等发现或用户补表。

- **空列表 ≠ 目录漂移（2026-09-19 实测，本机 raw curl，非扩展）**：SCNet token plan 配额耗尽时，chat/completions 与 anthropic messages 都返回 **HTTP 429** `Token Plan quota has been exceeded`（两条线一致）；
  - 同一时刻 `GET /api/llm/v1/models` 与 `GET /api/llm/anthropic/v1/models` 仍返回 **HTTP 200 + 空数组**（`{"object":"list","data":[]}` / `{"data":[],"has_more":false,...}`），不是 401/429。
  - 所以「消失」判定必须要求该 vendor 的所有可发现端点本轮都成功且非空；
  - 空数组与失败同等待遇（不报不删），否则配额耗尽会把整张表当 removed。

**运行期安全：只增不删 + 惯例兜底**

- 运行期安全：`applyLiveModels()` 只增不删（`rows` 为空时原样返回；已知 id 只更新 name/contextWindow，新 id 才追加），基底表与 `models-store.json` 里的快照都不会被空列表抹掉。
  - 发现不再返回的 id 由 `refreshEntry()` 在**该 vendor 所有可发现端点本轮都成功且非空**时算出（取各端点答案并集）并进 `problemLines()` 报告；
  - 默认**保留**，只有 `sync <id> --prune` 才从 `models.json` 删。
  - 未知新 id 的 `reasoning`/`thinkingLevelMap` **不从 pi 内置目录兜底**（已否决）：能力只信上游信息/探测结果。
  - 但 `contextWindow`/`maxTokens`/`input` 会先看内置目录里**该模型厂商自己的条目**（`builtin.vendor` / `vendorFacts`）。
    - 厂商 host 是显式政策表：`deepseek`/`moonshotai`/`zai`/`qwen-token-plan*`/`minimax*`——pi 目录里没有可判定的标记，`opencode` 这类转售者也用裸 id。
    - 日期快照也认基名（`DeepSeek-V4-Pro-0813` → `deepseek-v4-pro`），只用于这次回退，不动 `normalizeModelId`。
    - 厂商条目缺该 id（或该族没有厂商 host）时退回 `builtin.unanimous`（**每家**上架该 id 的 provider 都给同一个值）；两者都没有则留兜底。
    - **线上自报的 ctx 是上限**：厂商 1M 而网关报 128k 时取 128k——ctx 同时决定压缩点与 `maxTokens` 上限，写大了是每个请求都超预算 400，不只是长对话。`maxTokens` 雨夹进最终窗口。
    - 取到的值在 `sync` 报告与 `status <id>` 里带来源点名（`<id> (vendor moonshotai)` / `<id> (every provider agrees)`），不静默。
    - 实测覆盖率：SCNet 那 17 条里厂商条目只有 11 条（`deepseek` 名单无 V4.x、`zai` 无 GLM-5/5.1、`moonshotai` 无 K2.5、`minimax` 无 M2.5）。
  - 上游不给时走 `convention.ts` 惯例兜底：① 同族继承（基底表里第一条同族条目的 `reasoning`，anthropic 线连 `thinkingLevelMap` 一起继承）；
  - ② `CONVENTION_FAMILIES` 已知家族名单（精确匹配 `familyKey()`，anthropic 线补 `{xhigh,max}`，其它线不补 map）；
  - 两步不命中才 `reasoning:false`。

### 路径与目录约定

- `extensions/custom-providers/` 16 个模块（扁平，按层看）：
  - **词汇与类型（叶子）**
    - `types.ts` 共享类型（手写）
    - `verbs.ts` `/providers` 动词表 + 解析（叶子，无 import）
    - `apis.ts` pi 的 api 词汇（协议 id + 别名 + `FALLBACK_CONTEXT_WINDOW`/`FALLBACK_MAX_TOKENS`；图叶子）
    - `util.ts` JSON 编解码与落盘词汇（`readJson`/`JsonRead`、`serializeJson`、`writeTextAtomic` + 对象类型 + 三个守卫；依赖图的叶子，只 import `node:fs`/`node:path`，不 import 任何本地模块）
  - **载荷：一个数据单元一个文件**
    - `config.ts` pi 全局 `models.json` 层（第 3 层复刻：`readModelsConfig`/`validateModelsConfig`/`providerBlockFor`/`providerLayerFor`/`preflightLayer`；只读配置，不应用任何补丁）
    - `env.ts` .env 解析 + pi 值语法解析
    - `endpoints.ts` 端点表（读 + `init` 的 `writeProviderFile`）
    - `model-table.ts` 模型基底表（读 + `sync` 的 `FIELD_ORDER`/`serializeBaseTable`/`diffBaseTable`/`writeBaseTable`）
    - `credentials.ts` 凭据引用（读 + `resolveAccounts` 账号 id 策略 + `writeAccountsFile` 写口）
  - **目录装配**
    - `directory.ts` **目录层**（扫描 / `loadDirectory` 汇编三个载荷 / 接管白名单 / `vendorFromDirectory` / `collectVendors`）
  - **合成与链路**
    - `providers.ts` 目录 → 可注册 provider（条目展开 + 分层合并 + 基底视图）
    - `builtin.ts` 内置目录交叉校验与 compat 吸收
    - `convention.ts` 未知新 id 的能力惯例兜底（同族继承 + 家族名单）
    - `live.ts` 发现与「wire 答案怎么并进表」的规则（含进程内 `liveSnapshots`/`vanishedByVendor`/`lastErrors`）
  - **编排与报告**
    - `index.ts` 扩展接线（`registerEntry`、`statusOf`、动词分支 `runInit`/`runFiles`/`runSync`/`runRescan`/`runStatus`、钩子）。
    - `status.ts` 每 provider 状态与问题文本
  - `tests/fixtures/models.json` 是测试用的模型表。

**仓库边界（写什么、不写什么）**

- pi 全局的 `models.json` 只读：本扩展把它当覆盖层，从不写回。本扩展只写自己目录里的文件：`provider.json` 与 `accounts.json`（`init`）和 `models.json`（`sync`）。
- 一个 provider = 一个 **vendor**（不是一条线）：SCNet 的两条线注册成一个 `scnet`，第二条线由 `provider.json` 的 `apis."anthropic-messages"` 描述，模型级 `api` 选线；凭据是 provider 级（一条 key）。

**扁平化判据**

- `extensions/custom-providers/` **扁平放置，不在扩展内再分层**（16 文件 / ~2835 行）：**目录是能力单位（一目录一功能）；
  - 文件 = 一个数据单元（它的读/写/词汇）或一段变换**（阶段是顺序，一段可以消费多个单元）。
  - 这条判据已四次落地：编排器拆出四个模块（13 文件）、`<id>/models.json` 的读写从两个文件合并（13→12）、三个载荷各自成文件而目录留作装配（12→15）、`config.ts` 拆出 `apis.ts` 并把端点落法交还端点单元（15→16）。
  - 可机械判定：① 某文件拥有第二个数据单元 ⇒ 拆；
  - ② 某数据单元有两个读者/写者 ⇒ 合；
  - ③ 出现第二个**独立能力** ⇒ 那是同级扩展 `extensions/<name>/index.ts`，不是本目录的子目录。
  - **不用文件数/行数当触发线**（目录不会因为文件多而变成另一种东西）。
- **层序不靠目录承载**：层序的真相是依赖图（`graph-test`）+「分层与接口」那张表。给层开子目录＝同一事实的第二份副本，会和依赖图漂移。触发条件（到那时也优先拆能力）：文件 >20、或某一层自身 ≥5 个文件、或出现第二个能力。
- `tests/` **必须保持扁平**：`run-all.mjs` 是 `readdirSync` 单层扫描（不递归），放进子目录的测试会静默不被执行。`tests/fixtures/` 是数据不是测试（当前唯一的子目录）。
- **排版纪律（文档）**：散文行一行一个意思、≤ 200 字；表格行与代码行按「一条记录 / 一句代码一行」豁免。
  - 多子句的单元格用 `<br>` 断开；换行类改动只允许加空白、行首 `- ` 标记与 `<br>`，验证法 = **去掉所有空白后逐字符相同**。
  - `CHANGELOG.md` 与 `audits/`（含已发布条目）在 2026-10-03 也按此排过一遍（owner 指示），措辞未改。
  - 同日的**结构拆分**（owner 批准；只动「一件记录里塞了多件事」的格：格内留指针，长枚举移到表下列表，文字逐字未改）：
    - 第一批：`attention.md` 工具层一行 → 4 行；`audit-01` 未定名签名一格 6 组 → 6 行；`audit-02` §10 一格 3 组 → 表下 3 条。
    - 第二批（当日稍后，把 `>200` 表格行清零）：`README.md` 的 `init` 旗标一条；`attention.md` 流程表「所有者」整列 + 阶段 3/5 细则 + azure 来源顺序；`audit-01` 结论速览第 3 列 3 条 + 指纹表第 4 列 5 条；`audit-02` §10 的「落地 20 条」；`audit-03` 三行的归因。
    - 动过的存档在文件内留有「拆分（2026-10-03）」注明。

**`.codestable/` 知识布局（v2）**

- `.codestable/` = CodeStable **v2** 形态：项目自己的知识只有 `attention.md`（每次必读）、`lessons/`（一条一文件，`cs-keep` 写入）、`work/`（活动中的跨会话任务，完成即清）、`audits/`（只读历史：证据档 + 已完成的 feat 设计存档）。

**依赖图与本地目录**

- 模块依赖图**无环**且每个模块都能从 `index.ts` 到达，由 `tests/graph-test.mjs` 守护（含 type-only 回边：`util.ts` 是叶子，`JsonObject` 这类共享类型放叶子模块才不会成环）。
- `.agents/`（记忆、会话日志、技能）整体 gitignored，不进仓库、不进 tag。

### 数据流（实测，每项有 `file:function` 锚点）

顺序只有一处可读：`index.ts`（唯一编排者）。模块之间不横向互调，只有同阶段复用（`live.refreshEntry` 调 `providers.synthesizeModels`——注册与刷新必须算出同一张基底表）。

表里列的是每段的**数据/变换**，**所有者（代码路径）在表下逐段列出**；`index.ts` 是唯一编排者，按顺序调用它们，所以每个阶段都有它的调用点（不重复列）。
**一段可以消费多个单元**（阶段 2 = accounts.json 单元 + id 命名空间；阶段 3 = pi 全局层单元 + 装配变换）：判据约束的是**单元的归宿**（一个单元只能有一个文件），不是「一段只能有一个文件」。

| # | 阶段 | 输入 | 变换 / 归宿 |
|---|---|---|---|
| 0 | 环境 | `~/.pi/agent/.env`、`~/.omp/agent/.env` | 只补不覆盖；`$VAR`/`!cmd` 请求时才解析 |
| 1 | 目录层·读 | `<id>/provider.json`/`models.json`/`accounts.json` | 逐文件校验 → `DirectoryVendor`；<br>接管白名单（builtin id 需 `override:true`） |
| 2 | 账号/id 分配 | `accounts` + `default` 指针 + pi 已有 id | `default` 占基 id、其余 `<id>-<name>`；撞车跳过并报告 |
| 3 | 分层合成 | ①`<id>/models.json` ②`provider.json` ③pi 全局 `providers.<id>`（provider 字段；<br>其 `models[]` 不读） ④`modelOverrides` | 逐字段 patch 叠链（细则见下） |
| 4 | 注册 | 合成后的表 + 基底视图 | `pi.registerProvider`——进 pi provider 表的唯一入口 |
| 5 | 实时发现 | `baseUrl + modelsPath` 的 `/models` 答案 + pi 的 `context.stored` | auth 形态与合并细则（四条见下） |
| 6 | 报告 | `statuses` + `globalIssues` | `problemLines` 顺序：错误→校验警告→刷新失败→新 id→消失 id→无实时数据；8 行裁剪 |
| 7 | 写回（三条出口） | 阶段 5 的发现结果 / `init` 的声明与密钥 | `sync`：基底 ⊕ 发现 → diff → 写盘（`.bak`）→ 注册；<br>`init`：写 `provider.json`、`accounts.json`（已有则不动）→ 跑一次 `sync`（写 `models.json`）→ 注册 |

**各阶段的所有者（代码路径，2026-10-03 从表格「数据/变换所有者」列拉出；文字未改）**

- 0 环境：`env.ts loadEnvFile`/`resolveConfigValue`
- 1 目录层·读：`directory.ts scanProviderRoot`→`loadDirectory`(`endpoints.ts readProviderFile`/`model-table.ts readModelsFile`/`credentials.ts readAccountsFile`)→
  `vendorFromDirectory`→`collectVendors`（输入只有目录）
- 2 账号/id 分配：`credentials.ts resolveAccounts` → `directory.ts collectVendors` → `providers.ts collectEntries`
- 3 分层合成：`config.ts readModelsConfig`/`providerLayerFor`/`preflightLayer`（pi 全局层；第 4 层由 pi 应用）→ `providers.ts synthesizeModels`（装配；端点落法调 `endpoints.ts resolveModelEndpoint`）← `builtin.ts absorbCompat`
- 4 注册：`providers.ts baseTableView`（视图变换）+ `index.ts registerEntry`（注册 + `statusOf` 记账）
- 5 实时发现：`live.ts vendorEndpoints`/`discover`/`mergeStoredSnapshot`/`applyLiveModels`/`refreshEntry`
- 6 报告：`status.ts problemLines`/`toastLines`/`apiSplit`（报告文本）；`index.ts` 的命令分支只负责路由与 `notify`
- 7 写回（三条出口）：`model-table.ts writeBaseTable`/`diffBaseTable`/`serializeBaseTable`、`endpoints.ts writeProviderFile`、`credentials.ts writeAccountsFile`（落盘都走 `util.ts writeTextAtomic`）

**阶段 3 的叠链细则**（「逐字段 patch 叠链」之外的四条，同列拉出；文字未改）

- `baseUrl = config.baseUrl ?? model.baseUrl`
- 每模型落端点（默认协议不带 `api`）
- headers 逐层合并后贴到条目
- 内置目录白名单吸收（`providers.ts:128`，注册与刷新两条路径都走）

**阶段 5 的抓取细则**（原「变换 / 归宿」格四条，同列拉出；文字未改）

- auth 形态也照 pi：按协议默认（anthropic 用 `x-api-key`）+ `authHeader` 时补 `Authorization: Bearer`（pi 的 `withConfiguredAuth` 就是这两个头）
- 旧快照当**基底条目**恢复（保参数）
- 只增不删
- 失败只记 `lastErrors`、保旧快照（能力字段走 `convention.ts`）

两条回路：**①自愈**：阶段 5 新 id → pi `publish({persist})` 落 `models-store.json` → 下次作 `context.stored` 回来；**②人**：阶段 6 报「新 id / 消失 id」→ 人跑 `sync [--prune]` → 阶段 1 的 `models.json` 变厚 → 阶段 3 认得。

### 单元归属（一个数据单元一个归宿）

| 文件 | 数据单元 | 方向 |
|---|---|---|
| `util.ts` | JSON 编解码与原子落盘（`readJson`/`serializeJson`/`writeTextAtomic`，图叶子） | — |
| `types.ts` | 内部类型词汇（`Endpoint`/`ProviderDeclaration`/`EndpointChoice` 也在此） | — |
| `apis.ts` | pi 的 api 词汇与模型尺寸默认值（图叶子） | — |
| `convention.ts` | 未知 id 能力惯例（A 同族继承 `reasoning` + `thinkingLevelMap`，与线无关；<br>B 无同族时合成的 `{xhigh,max}` 仅 anthropic 线） | — |
| `config.ts` | pi 全局 `models.json`（第 3 层的读 + 预报告；第 4 层 `modelOverrides` 由 pi 应用） | 读 |
| `env.ts` | `.env` + pi 值表达式 | 读 + 解析 |
| `builtin.ts` | pi 内置目录（读 + 白名单吸收 + drift 比较 + `vendor`/`unanimous` 供给） | 读 |
| `endpoints.ts` | `<id>/provider.json`：端点表（读 + `init` 写） | 读 + 写 |
| `model-table.ts` | `<id>/models.json`：模型基底表（读 + `sync` 的 diff/写） | 读 + 写 |
| `credentials.ts` | `<id>/accounts.json`：凭据**引用**（只读）+ 账号 id 策略 `resolveAccounts` + 凭据选择（`registrationCredential` 给 pi、`discoveryCredential` 给自家探针） | 读 |
| `directory.ts` | **provider 目录本身**：扫描、接管白名单、id 命名空间、三个载荷结果的装配 | 读（装配） |
| `providers.ts` | 装配（vendor → 可注册 provider） | 变换 |
| `live.ts` | 上游 `/models` 答案 + pi 快照 | 读（网络）+ 合并 |
| `status.ts` | 报告文本 | 变换 |
| `index.ts` | **编排**：上表的顺序 + 全部 7 个入口 | — |

已知取舍（不是遗漏）：`<id>/models.json` 只被 `model-table.ts` 解析一次/命令；`runSync` 用本次命令重新扫描得到的 `vendor.models` 作为「磁盘上的基底表」，不再另读一遍。

### 分层与接口（TCP/IP 视角，2026-09-30）

把扩展当一条协议栈读：每层只依赖下一层，层与层之间流动的数据单元（PDU）唯一——这是「为什么这样切文件」的可解释版本，也是 `graph-test` 之外的层序说明。

| 层 | 职责 | 进 / 出（PDU） | 模块 |
|---|---|---|---|
| 词汇与协议 | JSON 编解码与原子落盘、领域类型、pi 的 api 词汇与模型尺寸默认值、`/providers` 动词表与解析 | 文件 → `JsonRead` | `util.ts` `types.ts` `apis.ts` `verbs.ts` |
| 载荷 | 用户文件的读（其中两种可写）：三个目录载荷 + pi 全局 `models.json` | `JsonRead` → 各载荷结构 | `endpoints.ts` `model-table.ts` `credentials.ts` `config.ts` |
| 封装边界（目录） | 一个目录 = 一个 vendor：扫描、接管白名单、id 命名空间、装配三个载荷的结果 | 载荷 → `Vendor` | `directory.ts` |
| 合成 | 4 层补丁链 → pi 可注册的模型 + 基底视图 | `Vendor` → `ProviderEntry` → `ModelEntry` → 注册载荷 | `providers.ts`（+ `builtin.ts`/`convention.ts` 提供能力） |
| 会话 / 链路 | 发现与快照合并；真发 HTTP（`/models`）、auth 形态照 pi（协议默认 + `authHeader`） | `LiveModelRow` → `ModelEntry[]` | `live.ts`（凭据来自 `credentials.ts`） |
| 编排 | 顺序与入口、pi 的注册与刷新钩子 | 全部 | `index.ts` |
| 带外管理 | 不在数据路径上：`status`/`files`/`sync`/`rescan`/`init`（`drift` 计数并入 `status`） | `ProviderStatus[]` → 文本；`BaseTableDiff` → 文件 | `status.ts` + `index.ts` 命令分支 |

**两个对等接口**（同层通信只有这两处）：扩展 ↔ pi（`apis.ts` 的 api 词汇 + `endpoints.ts` 的端点落法 + `index.ts` 的 `registerProvider`/`context.stored`/`publish`）；
扩展 ↔ 上游站（`live.ts` 的 `/models` 请求构造，凭据来自 `credentials.ts`，头来自 `provider.json.headers`）。

**端到端原则的推论**（四条保守性，都写在「引擎行为」里）：① 中间层不固化端的策略——`sync` 只写「基底 ⊕ 发现」，不烘焙 `providers.<id>`/`modelOverrides`；② 状态变更须由端显式发起——`--dry-run` 只预览、`--prune` 才删、`init`/`sync` 是明示动作（写完即应用，见下）；
③ 不可靠输入不破坏端状态——坏文件 `fail-closed`、空答案/失败不清表、消失 id 只报告、`.bak`+temp+rename；④ 不越层写——永不写 pi 全局 `models.json`。

**不适用处（不要硬凑）**：没有逐跳转发/路由表（一次性解析）；没有同层对等通信（provider 之间不交互）；没有重传/序号（靠「只增不删」而不是重传保可靠）；`status.ts` 不是一层，是带外管理面。

**写盘动词自带应用**：「盘变了 → 会话变了」不再由 `rescan` 独占：`init`/`sync` 写完就用 `applyVendors`（`rescan` 的同一个实现）注册自己的结果，`rescan` 退回带外编辑。
`init` 还自带一次发现：写完文件就调 `syncVendor`（同一个 `sync` 实现）抓一次 `/models` 写成 `models.json`，所以它是「一条命令把目录变成可用 provider」，同时把端点/凭据验了一次——探测是 `init` 唯一的网络动作，缺凭据在这里就是 warning。
`sync` 全部端点因**缺凭据**被跳过时以 warning 点名那条解析不出的引用（`credentials.ts unresolvedReference`），并提示重启 pi / `/reload`——未设置的 `$VAR` 在 pi 的语法里是静默 `undefined`。

**Demux 键与端口**：`<id>` → 账号 `<id>-<name>` → 模型 `id`；`apis` 表 = 同一主机（`baseUrl`）上的多个服务 ≡ 端口表（所以 Anthropic 线的 `baseUrl` 要短一截）；`modelsPath` = 服务上的资源路径；报告 8 行裁剪 = 显示层 MTU。

### pi 各协议的 baseUrl 拼接（实测）

pi 把 `model.baseUrl` 原样交给各协议 SDK，拼接规则各不相同 —— 写 `provider.json` 的端点表前先对照这张表（实据在 `pi-ai/dist/api/*.js`）：

| api | 拼法 | 实据 |
|---|---|---|
| `anthropic-messages` | `baseURL = model.baseUrl`，SDK 自拼 `/v1/messages` ⇒ baseUrl **不能带 `/v1`** | `anthropic-messages.js:697,712,733` |
| `openai-completions` | `model.baseUrl` + SDK 拼 `/chat/completions` | `openai-completions.js:575` |
| `openai-responses` | `<baseUrl>/responses` | `openai-responses.js:203` |
| `openai-codex-responses` | 尾 `/codex/responses` 原样；尾 `/codex` → `+/responses`；否则 `+/codex/responses` | `openai-codex-responses.js:455-462` |
| `azure-openai-responses` | Azure 主机且路径为空/`/openai`/`/openai/v1/responses` → **强制改写 `/openai/v1`**（baseUrl 来源顺序见下） | `azure-openai-responses.js:136-181` |
| `google-generative-ai` | `httpOptions.baseUrl = model.baseUrl`（SDK 自拼版本/方法路径） | `google-generative-ai.js:266-267` |
| `google-vertex` | `resolveCustomBaseUrl(model.baseUrl)` + `ResourceScope.COLLECTION`（baseUrl 自带版本段时行为不同） | `google-vertex.js:293-320` |
| `mistral-conversations` | 补尾 `/` 后 `new URL("v1/chat/completions", baseUrl)` ⇒ baseUrl 只到根 | `mistral-conversations.js:159-161` |
| `bedrock-converse-stream` | **不是路径拼接**：`model.baseUrl` 就是 endpoint（`config.endpoint = model.baseUrl`），region 从 hostname 推 | `bedrock-converse-stream.js:52-58,965-985` |
| `pi-messages` | 去尾 `/` 后拼 `/messages` | `pi-messages.js:250` |

`azure-openai-responses` 的 `model.baseUrl` 只是第三来源（`options.azureBaseUrl` > `AZURE_OPENAI_BASE_URL` > `AZURE_OPENAI_RESOURCE_NAME` > model.baseUrl）。

### 环境变量与凭证

- `CMD_API_KEY`（Command Code）、`SCNET_API_KEY`（SCNet 两条线）。

- 凭据是**引用**不是字面量：`accounts.json` 的 `apiKey` 走 pi 的值语法 —— `sk-…`（明文，`$$`/`$!` 转义前导 `$`/`!`）、`$VAR`/`${VAR}`/裸 `UPPER_SNAKE`（环境变量）、`!command`（keyring / 密码管理器：
  `!secret-tool lookup …`、`!kwallet-query …`、`!pass show …`、`!op read …`）。
  - **扩展传递引用、不在自己的路径上把它解析成字面量**（`credentials.ts discoveryCredential` 的解析只用于判断「有没有凭据」、决定要不要发请求），秘密因此不会落进 pi 的 `models-store.json`；
  - 明文只是一种引用，README 已警告 `accounts.json` 要 gitignore + `chmod 600`。

**shell 与值语法**

- 启动时从 `~/.pi/agent/.env` 与 `~/.omp/agent/.env` 补齐，已存在的环境变量不覆盖。
- `!command` 跑在 pi 的 shell 里：非 Windows 是 `sh -c`（Node 的 `execSync` 默认 `shell: true` → `/bin/sh`，Debian/Ubuntu 上即 dash），Windows 是 pi 找到的 Git Bash（`getShellConfig()`；没装 Git Bash 才回落 `cmd.exe`）。
  - 扩展在发现刷新时也要解同一个值（只用它判「有没有凭据」），所以两边必须用**同一个** shell —— `env.ts` 现在直接用 pi 导出的 `getShellConfig()`（同 argv/stdin 传输、同 10s 超时、同 ENOENT 回落）。
  - 推论：命令按 **POSIX sh** 写，`[[`/`<<<` 这类 bash 语法在 dash 上不成立。
  - base64 没有原生的值形式，只能借 `!command`；
  - README 给了 Linux/macOS/Windows 都成立的写法。

- 仓库与 README 不写密钥。
- Command Code 账号受限（2026-09-18 实测）：claude 系列全部 `MODEL_NOT_IN_PLAN`，部分 OpenAI 线模型 `insufficient credits`，所以目录里 claude 的 `reasoning`/`input` 只能在升级计划后实测。

### 端点、协议与请求路径

- **Anthropic 线的 baseUrl 不能带 `/v1`**：pi 把 `model.baseUrl` 原样交给 Anthropic SDK，SDK 自己拼 `/v1/messages`（`anthropic-messages.js` 里 `new Anthropic({ baseURL: model.baseUrl })`，无任何归一化）。
  - Command Code 的 OpenAI 线是 `/provider/v1`、Anthropic 线是 `/provider`，差异写在各 vendor 的 `apis."anthropic-messages".baseUrl`（目录 `provider.json` 的声明），注册时按模型 `api` 贴 `baseUrl`。
  - 实测：`/provider/v1/messages` → 403 `MODEL_NOT_IN_PLAN`（路由存在），`/provider/v1/v1/messages` → 404。
  - pi 自带目录同规律（`opencode`: `/zen/v1` vs `/zen`）。

- **它的 `openai-responses` 线也现场可验（2026-10-02）**：`POST /provider/v1/responses`（= 用户 `provider.json` 声明的 `baseUrl` + pi 自己拼的 `/responses`）200 且流式可用（`resp_01…`、`response.completed`），
  而少一层 `/v1` 的 `/provider/responses` 404 ⇒ 端点表那条 baseUrl 的写法是对的。
  - 同一个 `/models` 的 `supported_endpoints` 虽然给 85 行都列了 `/responses`，发现阶段**从不看它**（`models-test` 断言 “discovery never infers a protocol”），所以表里 0 条用它、全走默认 `/chat/completions`：预期行为，不是缺陷。

- 用真请求验证网关时的坑：**403/40x 与 404 要分开读**——403 `MODEL_NOT_IN_PLAN` 说明路由存在、是账号计划问题；404 + `cause` 里写着具体 URL 才是路径错。选 URL 的代码不要把“非 200”当成“路径不对”，否则后续探针全打在错路径上（本次就踩过）。

- **compat 是「每协议各读自己那份键」，不是发给上游的字段**（2026-10-02 重测）：`compat` 只被 pi 各协议实现的请求构造器读（`pi-ai/dist/api/<id>.js` 及其 import 的 helper），
  运行时 schema 不设成员白名单 —— `ProviderCompatSchema = Union([OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema, AnthropicMessagesCompatSchema])`，
  三个都是开放对象 ⇒ 任何未知键**通过校验、随后被静默丢弃**。
  - 实测读键数（`tests/compat-keys-test.mjs` 逐条核对）：`anthropic-messages` 13、`openai-completions` 27、`openai-responses` 10、
    `openai-codex-responses` 6、`azure-openai-responses` 6、`mistral-conversations` 1、`bedrock-converse-stream` 1、
    `google-generative-ai` 0、`google-vertex` 0、`pi-messages` 0；
  - 被 ≥2 个协议读的键 9 个。
  - ⇒ 判据是「目标 api 的实现读不读它」，**表与读键判据的唯一家在 `apis.ts` 的 `API_COMPAT_KEYS`/`inertCompatKeys`**（从 pi dist 重推），`tests/compat-keys-test.mjs` 用它自己那套扫描复推同一张表并断言相等 —— pi 换版加/删键会红，而不是让报告说谎。
  - 报告点在 `providers.ts synthesizeModels`（聚合到每协议一行，`status` 里显示），覆盖底座表条目、`providers.<id>.models[]` 条目、provider 级 `compat`、以及 pi 最高层 `modelOverrides[M].compat`；
  - 不做拒绝（类型对但协议不对只是没效果）。

- **坑（实现时先被测试拦住）**：把模型移到非默认协议时，必须给它打上该线的 `api`。基底表里的模型本身不带 `api`，只贴 `baseUrl` 会导致 pi 用 provider 级 `api`——**对正确的主机说错协议**（打到 Anthropic 端点发 chat/completions）。规则：非默认协议时同时贴 `api` 与 `baseUrl`。

- **compat 的归属按模型**：provider 级 `compat` 由我们折到该 provider 的模型上；只想给某一条线，就写在 `models.json` 的模型条目里。

### pi 的字段与 schema

**pi 的三张配置 schema（`dist/core/model-config.js`，2026-10-03 复推）**

- `ProviderConfigSchema`（`providers.<id>` 块，10 字段）：`name`、`baseUrl`、`apiKey`、`api`、`oauth`（只能是字面量 `"radius"`）、`headers`、`compat`、`authHeader`、
  `models[]`（= `ModelDefinitionSchema` 的数组）、`modelOverrides`（= `Record<modelId, ModelOverrideSchema>`）。
- `ModelDefinitionSchema`（`models[]` 条目与 `<id>/models.json` 条目，15 字段）：
  `id`（必填）、`name`、`api`、`baseUrl`、`reasoning`、`thinkingLevelMap`、`input`、`inputLimits`、`cost`、`promptCache`、`contextWindow`、`maxTokens`、`samplingParams`、`headers`、`compat`；
  与 `model-table.ts` 的 `MODEL_KEYS` 同集，`pi-surface-test.mjs` 双向对照。
- `ModelOverrideSchema`（12 字段）：上表去掉 `id`/`api`/`baseUrl`（改不了模型身份与端点），`cost` 只收 `input`/`output`/`cacheRead`/`cacheWrite`/`tiers`。
- 子形状：`input` = `("text"|"image")[]`；`cost` = `{input, output, cacheRead, cacheWrite, tiers?: [{inputTokensAbove, input, output, cacheRead, cacheWrite}]}`；
  `promptCache` = `{short?, long?}`（都 > 0）；
  `inputLimits` = `{maxRequestBytes?, images?: {resize?: {maxWidth?, maxHeight?, maxBytes?, jpegQuality?}, maxPerMessage?, maxPerRequest?}}`；
  `thinkingLevelMap` = `{off?, minimal?, low?, medium?, high?, xhigh?, max?}`，值为字符串或 `null`。
- `compat` 是三族开放对象 schema 的并集（`anthropic-messages` 10 键 / `openai-completions` 22 / `openai-responses` 6），未知键一律通过校验；
  三族的键全部落在本包读键表内，读键表另有 schema 未声明但实现会读的键（`thinkingTokenBudgetField`、`zaiToolStream`、`supportsToolSearch` 等）——判据表见「端点、协议与请求路径」。

- pi 的 `calculateCost()` / `provider-composer` 直接读 `model.cost.tiers`，注册模型必须带 `cost`，否则整轮报 `Cannot read properties of undefined (reading 'tiers')`。
  基底表 reader 现在保留 `cost` 里除四个费率外的其它键（`tiers` 等）并按原顺序写回，所以用户的计费分层不会被 `sync` 静默丢掉。

- 实时 `/models` 只用于发现 id/上下文/显示名；已知模型的 `maxTokens`、`reasoning`、`input` 等不得被默认值覆盖。

- pi 内置目录可从扩展读取（loader 把 `@earendil-works/pi-ai` 映射到 compat 入口，导出 `getProviders`/`getModels`）。
  - 只允许吸收**少发参数**类字段：目前仅 `supportsTemperature: false`（仅 Anthropic 线，Opus 4.7+ 拒非默认温度）。
  - 改请求体形状的字段（`thinkingFormat`、`maxTokensField`、`supportsDeveloperRole`、`forceAdaptiveThinking` 等）是按上游域名调好的，套到中转站会 400，**不得吸收**；
  - `reasoning`/`input`/`maxTokens`/`contextWindow` 只报告不覆盖。

- **坑**：pi 只认**模型级** compat。
  - `applyExtension()`（`provider-composer.js`）用扩展给的模型定义重建每个模型，provider 级 `compat` 被丢弃；
  - 而 `models.json` 的 provider 级 `compat` 是在这之前被 `applyModelsJson()` 合并到内置模型表上的，随后也被同一个重建行为覆盖掉。
  - 所以对扩展注册的 provider，`models.json` 里写的 compat / `models[]` 都得我们自己再贴一遍（`providers.ts` 的 `synthesizeModels()`、`endpoints.ts` 的 `resolveModelEndpoint()`）。
  - 不对应的后果是“看起来配了、其实无效”。

- pi **没有 provider 别名机制**：`model-resolver.js` 里的 alias 只是“无日期模型 id 优先”，与 provider 无关；provider 身份就是 id。
  provider 级设置只有 `models.json` 的 `name`/`baseUrl`/`api`/`apiKey`/`headers`/`authHeader`/`compat`/`models[]`/`modelOverrides`/`oauth`，加上扩展侧的 `streamSimple`/`refreshModels`。

- `modelOverrides` 是**最高层且作用在扩展注册的模型之上**（`composeModelProvider` 的 `getModels()` = `applyExtension(...)` 之后再 `applyModelOverride`，
  源码注释自称 “topmost user-config layer … after … extension model replacement”），但 `ModelOverrideSchema` **没有 `api`/`baseUrl`**，`applyModelOverride` 也不处理这两个字段 → pi 原生**不能**按模型换 wire。
  - 它能改的是 `name`/`reasoning`/`thinkingLevelMap`/`input`/`inputLimits`/`cost`/`promptCache`/`contextWindow`/`maxTokens`/`samplingParams`/`headers`/`compat`——这些字段用户可以直接在 `models.json` 覆盖我们的模型，扩展不必自己实现。

- `models.json` 的 schema 校验（`model-config.js` 的 `validateModelsConfig`）：类型错（`apiKey: 123`、`providers: "nope"`）会**整份丢弃**整个文件并报 `Invalid models.json schema`（所有 provider 一起消失），
  但**放行未知键**（塞 `providers.scnet.wire: "anthropic"` 能过校验）→ 扩展自定义的 provider 级开关不需要改 pi 就能读。

- **实测（`ModelRuntime` 真运行时）**：模型条目自带 `api`+`baseUrl`、provider 级什么都不给，注册与 `getModels()` 都正常（provider 级只是 fallback）；
  模型条目上的未知键（例如早先版本用的 `wire`）会被 pi **原样保留**（`{...definition, api, provider, baseUrl, headers: undefined}` 是展开拷贝）；
  `ModelRuntime.create(...)` 返回 **Promise**，忘了 `await` 会得到 `registerProvider is not a function`。

- 模型级 `headers` 在 pi 里**不是从 composed model 上读的**：`extensionModelFromDefinition` 会把它抹成 `undefined`，
  请求路径改从**注册时的原始定义**取（`provider-composer.js` 的 `rawModelHeaders` → `resolveConfiguredModelHeaders`/`resolveCompatibilityRequestConfig`，值再走 pi 的值语法解析）。
  - 所以不能拿 `getModels()` 的返回值去断言 headers，要断言就调 `resolveConfiguredModelHeaders()`（`pi-native-test.mjs` 就是这么钉的）。

- `models.json` 条目的字段表（`model-table.ts` 的 `MODEL_KEYS`）与 pi 的 `ModelDefinitionSchema` 双向对照由 `pi-surface-test.mjs` 守：pi 加一个字段就是一次失败（决定「带过」还是「报告」），本包多一个键也是。
  - `type`（chat/image/classifier）不在这张表里——那是 pi **扩展侧**字段，而 `ModelDefinitionSchema` 没有它，本包只注册 chat 模型。
  - 同一个测试还多钉了本包内部的一个方向：`FIELD_ORDER`（`sync` 的写序）里每个键都必须能在 `MODEL_KEYS` 里读回——只写不读的键会写进基底表、下次读取报 unknown、下次 `sync` 丢掉（注入实测：往 `FIELD_ORDER` 塞一个无读者的键 → 该断言失败）。

### pi 的注册与刷新钩子

- provider 注册支持 pi 的 `refreshModels` 钩子：`pi update --models`、凭据变更、联网启动都会触发；返回值**替换**扩展注册的模型列表（不是合并），并可用 `context.publish({ persist })` 写入 `~/.pi/agent/models-store.json`。
  两条自动刷新路径并存：`session_start` 与这个钩子。

- **坑**：pi 的 `ModelRuntime.registerProvider` 结尾是 `void this.refresh({ allowNetwork: false })`（`model-runtime.js`），所以每次重新注册都会紧跟着跑一轮**离线** `refreshModels`。
  如果实现者在联网刷新后只把 live 结果注册进去而不落盘，这轮离线反射会把值降级回基底表（`live.ts` 用进程内 `liveSnapshots` 顶住，优先级：memo > persisted > 基底表；`tests/pi-native-test.mjs` 就是这个回归测试）。

- `refreshModels` 只有在凭据能解析（`resolveRefreshCredential`）时才会跑联网阶段；没配 key 时不会发网请求。`context.credential` 只在 `type === "api_key"` 时有 `key`。

- **缺凭据不会在注册时抛错**（本机实测）：`composeModelProvider` 里那句 `no authentication method configured` 实际几乎不可达（`composeApiKeyAuth` 在「无 key 且无 oauth」时仍返回对象而非 `undefined`）。
  - 真实后果：该 provider 的模型**不进可用快照**（`configuredProviders` 不含它 → picker 里看不到，实测 `getAvailableSnapshot()` = 0）；
  - 请求时 `authHeader: true` 报 `No API key found for "<id>"`，`authHeader: false` 则**不带 `Authorization` 静默发出**（网关 401）。
  - 所以「无凭据的账号不注册 + 启动时报告」是扩展主动选择，不是 pi 逼的。

### pi 的坑与易错点

- **坑**：omp 的 provider 字段不是 pi 的字段。`disableStrictTools` / `replayUnsignedThinking`（来自 `~/.omp/agent/models.yml`）在整个 pi 包里没有任何读取点，抄进扩展只是死配置；写 provider 选项前先在 `$PI/dist` 里 grep 字段名。

- **坑**：UPPER_SNAKE 的明文值一律当**环境变量名**（变量未设置时不得把变量名本身当密钥发出去）。`apiKeyConfig` 与 `resolveApiKey` 必须保持同一判定。

### 模型快照残留（`models-store.json`）

- `models-store.json` 的脏快照无害：实测扩展注册的模型优先，残留的旧 `baseUrl` 不影响请求路径，下一次 `pi update --models` 会写回正确值（`session_start` 的刷新走 `allowNetwork:false` 的 `registerProvider` 离线轮，不写盘）。
  残留条目（如合并前留下的 `scnet-anthropic`）没有读取方，pi 也不会自动清。


### 上游站实测与验证手段（Command Code / SCNet）

- 验证请求路径的手段：把部署副本的 baseUrl 临时改成本地 mock（`/tmp/mock-gateway.mjs` 模式），`pi -p --no-tools --provider X --model Y` 跑一次，
  mock 会打出手里的真实路径（实测会看到 `POST /provider/v1/messages?beta=true`——`client.beta.messages` 会再加 `?beta=true`）。比读源码猜可靠。

- **发现探针的 auth 形态要现场验证时用 Command Code，不用等 SCNet 配额**（2026-10-01 实测，扩展自己的 `refreshEntry` + 真 fetch 录头）：
  它的 `anthropic-messages` 线（`/provider/v1/models`）在「协议默认 + `Authorization: Bearer`」与「只有协议默认」两种头下都是 200 且返回同一批模型（86 个，`live: true`、无 issue），
  所以 `authHeader: true` 与 anthropic 线的叠加不会把探针打坏；SCNet 两条线配额耗尽时只剩 429/空列表（见上一条），测不了这个分支。

- Command Code 能力页（https://commandcode.ai/docs/reference/cli/models）**自相矛盾且相对实时注册表陈旧**，不要单看渲染出来的表格：
  - 同一次抓取里，内嵌 flight 数据与渲染表格的 `aria-label` 只在 `claude-sonnet-5` 上不一致（flight `vision=false`、表格写 `Text input, Vision, Reasoning`）。
  - 两种视图都还挂着已不在实时注册表的 `gpt-6-astra` 和旧 id `claude-haiku-4-5`；flight 另缺 `deepseek/deepseek-v4-flash`。
  - 因此能力页只能当**弱证据**：以实时注册表/实测为准。

- `claude-sonnet-5` 的 vision 三源冲突：能力页 flight `false`、能力页表格 `true`、上游 Anthropic 目录 `true`。仓库不固化该值；要用就在自己的 `models.json` 里定并实测。

- `commandcode` 的实时注册表在部分网络下首次请求 TLS/http2 失败（实测报 `http2ErrorCode: 2`）：手写探测脚本要退避重试；运行期发现失败只保留上一次快照并报告。

- **SCNet 两条线服务的是同一批 id**（实测重叠 18/19，仅 `MiniMax-M2.5` 是 OpenAI 线独有）。
  - 它们注册成**一个** `scnet`（v4.0 起）不是因为“模型表不同”，而是 pi 的硬约束：一个 provider id 内同 id 只能存在一份（`getModels(provider).find((m) => m.id === id)`，`pi-ai/dist/models.js`），
    而 `model.id` **就是**发给网关的 `model` 字段（`anthropic-messages.js:339`、`openai-completions.js:176` 均为 `model: model.id`），pi 没有独立的 wire-id/slug 字段。
  - 所以同一 id 只能挂在一条线上，**按请求切协议做不到**。

- **合并后的验证手段（已实测）**：把**部署副本**的 `provider.json` 两条 baseUrl 临时指向本地 mock（`/tmp/mock-gateway.mjs`），
  一次运行里就能看到同一个 provider 内不同模型走不同路径——`GLM-5.2`（协议=anthropic）→ `POST /anthropic/v1/messages?beta=true`，`DeepSeek-V4-Flash`（默认线）→ `POST /openai/chat/completions`，且两条线的 `/models` 都被探测。
  改完重新拷贝部署副本即还原。

### 设计取舍（记录在案）

- **设计：同一 vendor 的两条线注册成一个 provider**（`provider.json` 的 `apis` 声明额外端点，键就是 pi 的 `api` 值）。理由：两条线服务同一批 id，一个 provider id 内同名 id 只能有一份；协议按**模型**选（模型表条目的 `api`；
  默认协议来自 `provider.json.api` 或第 3 层 `providers.<id>.api`）。代价：凭据变成 provider 级（一条 key）、**不可能按请求换线**。想保留“一条线一个 provider + 随时切换”就得给第二条线单开一个目录，两种形态只能选一个。


### 接管面（pi 侧，实测）

- **`models.json` 里只有四项还能流进扩展注册的 provider**：`modelOverrides`（最高层，
  pi 自己应用）、`apiKey`（`extension?.apiKey ?? config?.apiKey`）、`headers`（request 时 `{...config.headers, ...extension.headers}`，
  再被 `modelOverrides[M].headers` 与 `config.models[M].headers` 压）、`authHeader`（`extension ?? config ?? false`）。
  - 其余（`baseUrl` / `api` / `name` / `compat` / `models[]`）由本包复刻 —— 判断「用户这样写有没有效」先查这张面。
- **config-only provider 真实存在**：只在 `models.json` 写 `providers.<id>`、没有目录时，pi 自己也会注册它（`providerIds()` 含 `config.getProviderIds()`；
  `recomposeProvider` 在 `base === undefined` 时仍调 `composeModelProvider`）。我们注册同名 id 时它的 `models[]` 被我们的整表替换。

**pi 注册时的校验（用 pi 自己的内置模型表）**

- **pi 在注册时校验用户 `providers.<id>` 块，用的却是它自己的内置模型表**（`registerProvider` → `validateExtensionProvider` → `applyModelsJson(providerId, getAllProviderModels(builtin), config)`；
  测于 2026-10-02）。对本扩展的 provider（pi 侧没有内置基底）实测四条：
  - 空块（`baseUrl`/`headers`/`compat`/`modelOverrides`/`models`/`apiKey`/`oauth` 全无且 `authHeader` 未设）→ `must specify "baseUrl", "headers", "compat", "modelOverrides", or "models"`；
    **只写 `api` 也落在这一条**（`api` 不在清单里）。
  - `models[]` 条目无 `api`（provider 级也无）→ `no "api" specified. Set at provider or model level.`
  - `models[]` 条目有 `api` 但无 `baseUrl`（provider 级也无）→ `"baseUrl" is required when defining custom models.` ⇒ 对本扩展的 provider，`models[]` 是「新建自定义模型」而不是补丁。
  - `modelOverrides[M]` 可用（pi 最后应用，实测 `maxTokens` 生效）⇒ **给本扩展的模型打补丁用第 4 层**。
  `oauth` 另有两态：`oauth` 无 `baseUrl` → `"baseUrl" is required when "oauth" is set`；`oauth` 非字面量 `"radius"` → 类型错 ⇒ pi `readModelsConfig` **整份丢文件**（`Invalid models.json schema…`）。
  本包现在**在调用 pi 之前**复刻这四条并报错（`config.ts` 的 `preflightLayer`，error 级即跳过该 provider），另有 `registerProvider` 的 try/catch 兜底；`config.ts` 还复刻了「schema 错 ⇒ 我们也不读」以免与 pi 分岔。
  `preflight-test.mjs` 每一条都同时断言「pi 自己也会抛」（真 `ModelRuntime`）。
**`models[]`：pi 只校验、不应用（实测 2026-10-03）**

- **pi 对「扩展注册的 id」只校验、不应用用户块里的 `models[]`（实测 2026-10-03，真 `ModelRuntime`）**：
  扩展注册后，该 provider 的模型表**就是扩展给出的那份**——用户 `providers.<id>.models[]` 的条目（即便自带 `api`+`baseUrl` 的合法定义）**不会**出现在模型表里，**扩展到 0 个模型时也一样**；
  - `modelOverrides[M]` 则**会**应用在被注册的模型上（实测 `maxTokens` 被改写、其余保持扩展值）。
  - 对照：同一个块若该 id **无人注册**（config-only），`models[]` 与 `modelOverrides` **都**会应用（实测出现 `m-new` 且 `maxTokens=4242`）。
  - ⇒ 对我们的 provider，「新模型」的正门是 `<id>/models.json`（或 discovery），「给已有模型打补丁」的正门是 `modelOverrides`；模型内容只有一个家，第 3 层不是它的第二个家——pi 自己不会执行这些条目，本包读它就是在替 pi 跑一个 pi 不跑的机制。
  - **本包不读这个数组**：`synthesizeModels` 只吃目录模型表；出现非空 `models[]` 即报告 `is not read for a provider this extension registers`（`discard → warn`），README 与 CHANGELOG 同步。
  - 合法性仍按 pi 的规则预报告（四个实测块：块级 `api`+`baseUrl` 让裸条目合法、只给 `baseUrl` 或都不给 pi 抛；三例钉在 `preflight-test.mjs`）；注册 id 下的合法 `models[]` 补丁从「被应用」变为「不生效」这一处差异见审计 S8。
  - `preflight-test.mjs` 把上面三条钉在真 pi runtime 上。

**`modelOverrides` 与「模型别名」的 schema 事实**

- **`modelOverrides` / 「模型别名」的两条 schema 事实（`dist/core/model-config.js`）**：
  `ModelOverrideSchema` = `{name, reasoning, thinkingLevelMap, input, inputLimits, cost, …}` 的 **byId map**，**没有 `id`** ⇒ 只能改**已注册**的模型（实测 `modelOverrides.<未注册 id>` 被忽略），
  能改**显示名**（`name`，实测生效）。
  - `ModelDefinitionSchema`（`models[]` 条目）= `{id, name, api, baseUrl, reasoning, thinkingLevelMap, input, inputLimits, cost, promptCache, contextWindow, maxTokens, samplingParams, headers, compat}`，
    **没有任何 `aliases` 字段**。
  - pi 里唯一的「模型别名」是 `model-resolver.js` 的**挑选规则**：候选里有「无日期 id」时优先取它（多个则 id 倒序取最高），否则取最新日期版——这是对**已存在 id** 的挑选，不是可配置映射。
  - ⇒ 给我们的 provider 造「同模型第二个名字」的唯一正门是模型表里真有两条 id（`<id>/models.json`）；
  - 想让某模型显示成别的名字用 `modelOverrides.<id>.name`。

**注销与别名 key**

- **扩展可以自己注销 provider**：`pi.unregisterProvider(name)`（`types.d.ts:1328`）在命令处理器里调用**立即生效**（不需要 `/reload`），移除该 provider 的全部模型并恢复被它覆盖的内置模型；不存在的 id 是无操作。
  门面 `loader.ts:370` 传了 `extension.path`，但默认 runtime（`runner.js:323`）只收 name、不做归属校验 ⇒ **调用方必须自控只撤销自己注册过的 id**。

- pi 只按**注册 id** 解析 `providers.<id>` 整块（`baseUrl`/`apiKey`/`headers`/`api`/`models[]`/`modelOverrides`…；`modelOverrides` 是块内字段、键为 model id，应用时机在扩展注册之后，是最高层）。
  - **别名 key 下的块不是本 provider 的配置**：pi 把那个 id 当成另一个 config-only provider 注册。
  - 本包不读别名 key 下的块：`providerLayerFor(id, config)` 只查 `providers[id]`；旧键由用户改名（README 迁移段），不代它兜底。
  - 读不到也要说话：`providers` 里那些既没有目录、（也不是 pi 内置 id 的）key 会被 `config.ts orphanProviderBlocks()` 点名
    （`providers.<key>: no directory for this id and no pi built-in provider; nothing here reads this block`）——它们属于「看起来配了、其实无效」那一类。
  - 判据只用本包能看见的两个集合（我们注册的 id + pi 内置 id），别的扩展注册的 id 在集合外，所以文案只说「这里没有读者」。
  - **pi 内置目录取不到时（`builtin.available === false`，如老 pi 构建没有 `getProviders`）整条检查静默**：分不出内置 id 与孤儿就不下结论，免得把用户给 pi 自带 provider 配的块报成孤儿——与 `drift` 同一口径（`orphan-block-test.mjs` 两个方向都钉住）。

### 引擎行为（多协议引擎 v4.0）

- 四个自有词汇之外全部是 pi 的字段：`apis`(第二协议端点) / `modelsPath`(发现路径) / `override`(接管内置 id) / `accounts.json`。协议用 pi 的 `api` 值，别名（`openai`/`chat`、`anthropic`/`messages`、`responses`）在加载时归一。
- 落端点规则：默认协议上的模型**不带** `api`/`baseUrl`（保住 `providers.<id>.baseUrl` 的重定向能力）；非默认协议两者都带，名字加 ` (协议)`。实现见 `endpoints.ts` 的 `resolveModelEndpoint()`，别在别处再写一套。

- 写盘只有三条且都在明面上：`provider.json`（`init` → `endpoints.ts` 的 `writeProviderFile`）、`accounts.json`（`init` → `credentials.ts` 的 `writeAccountsFile`，
  已有文件则不动、值原样落）与 `<id>/models.json`（`sync` → `model-table.ts` 的 `writeBaseTable`，先留 `.bak`，写基底 ⊕ 发现）。
  - 三条都经 `util.ts` 的 `serializeJson`（一份 JSON 写法：tab 缩进 + 结尾换行）与 `writeTextAtomic`（temp + rename，中断只留旧文件或新文件）；
  - pi 自己的 `models-store.json` 快照由 pi 落盘。
  - 扩展永不写 **pi 全局**的 `models.json`。

**本机 scnet 的凭据**

- **`~/.pi/agent/custom-providers/scnet/accounts.json`** = `{"default":"scnet","scnet":{"apiKey":"$SCNET_API_KEY","authHeader":true}}`（本机实配；
  `authHeader: true` = 除了协议默认头再补 `Authorization: Bearer`；该文件在 `~/.pi` 仓库里被 gitignore）。
  - 实测它确实被厂商接受：同一个 `GET /models`，**错误 key → HTTP 401**，本机 key → **HTTP 200**（两条线都 200 但 `data` 为空 = 账号/配额状态，见 `pi-provider-empty-live-models-trap`）。
  - 据此 `sync scnet --dry-run` 复测：两个端点都判「empty answer (skipped)」、报告点名、**零写盘**（目录指纹不变、无 `.bak`）——空列表没有能力驱动 `vanished`/`--prune`。

**报告与账号 id**

- 报告一律走 `ctx.ui.notify` 并裁剪（8 行 + `(+N more)`）；扩展**不写 stderr**。
- **账号 id 撞车**（`providers.ts collectEntries`）：`<id>-<account>` 若已被另一个 provider 占用（另一目录的 id 或 pi 内置 id），该账号跳过并报告，其余账号与基账号不受影响（`collectEntries` 先占住「pi 已有 id + 所有目录 vendor id」再逐个分配）。
  - 用户 `models.json` 里声明的 `providers.<id>-<name>` **不**算占位——那是该账号自己的配置块（`providerLayerFor(entry.id, …)`），列进去会把多账号覆盖一刀切掉（`tests/accounts-test.mjs` 守两侧）。

**没有出厂知识**

- **没有内置 provider、也没有出厂 vendor 知识**：装配里没有任何 vendor 表，`collectVendors(root, piProviderIds)` 的输入只有目录。
  `/providers init <id> --url <u> --api <a> [--models-path <p>] [--key <v>]`（有 UI 时为向导）写出端点声明；命中 **pi 自带** provider id 仍需 `"override": true`。
- **不带模型表**：目录只有 `provider.json` 时注册 0 个模型；模型来自 `<id>/models.json`（用户表）或实时发现（`sync` 可把发现写回基底）。多数票逻辑只在 `summarizeDrift` 内联使用。
