# 更新日志

版本规则见 `.codestable/attention.md`：新增 feature 与破坏性变更升 MINOR（0.x 阶段），fix / 文档 / chore 升 PATCH。每个版本对应一个 annotated tag，tag 说明与本文同源。
安装/升级：`pi install ssh://forgejo@git.lentech.site/C02-1010751281/pi-custom-providers.git@vX.Y.Z`。历史例外：`v0.2.4`（2026-09-22）的破坏性变更走的是 PATCH——早于本规则生效日，保留原样。
排版：散文一行一个意思、≤ 200 字（表格行与代码行按一条记录 / 一句代码一行豁免）。**已发布条目措辞冻结**：2026-10-03 只对它们做过换行规整（去空白后逐字相同、未增删一个字），所以条目字节可能与 tag 里的不同——tag 的原始字节在 git 历史里，措辞以本文为准。

## v0.5.2 — 2026-10-03

纯文档 + 测试的 PATCH（`extensions/` 零改动）。把最后一批「一格塞了多件事」的表格行清掉，并把文档写出的 compat 读键数钉进测试。

### 文档
- **`>200` 表格行清零（17 → 0）**：长格从单元格移到表下清单，格内留指针。
  - `README.md` 的 `init` 旗标；`.codestable/attention.md` 流程表的「数据/变换所有者」整列、阶段 3/5 两格的细则、azure 一行的 baseUrl 来源顺序。
  - `audits/2026-10-01-…` 的通道服务模型与错误信封；`audits/2026-10-02-…` §10 的「落地 20 条」；`audits/2026-10-03-…` 的三条归因。
  - 三篇存档都在原位注明「拆分（2026-10-03）…文字未改」；被移动的字符串逐条比对通过（attention 17 处、audit-01 7 处、audit-02 1 处、audit-03 3 处）。
  - 现在全套 tracked 文档只剩一条超 200 字的行——差分 runner 的代码行（围栏内，规则豁免）。
- **attention 的读键计数每协议一条**（原用 `各 6`/共用 `0` 分组），机器可逐条核对；纪律条里「结构拆分…三处」的过期计数改为两批。
- **补回 README 安装段缺失的闭合围栏**（v0.5.1 引入）：第一个代码块没有闭合，紧随其后的两段说明（GitHub 镜像、只能选一种安装方式）会被渲染成代码。

### 测试
- **`compat-keys-test` 兼钉文档写出的计数**：解析 `README.md` 与 `attention.md`，把每个写出的数（13/27/10/6/6/1/1/0/0/0、被 ≥2 个协议读的 9 个、README 的 google 不读）与现推读键集比对，句子必须在。
  - 注入证明 7 条：删表里一个键、README 13→14、清单少一条、9→8、`providers.ts` 不再收集无作用键、删两句中的任一句——各自让套件变红。
- 24 个套件全绿；`graph-test` 16 个扁平模块无环。

## v0.5.1 — 2026-10-03

纯文档 + 测试的 PATCH（`extensions/` 零改动）。把 v0.5.0 之后的事实与表达收口。

### 文档
- **README 重写成白话入口**：定位、两种安装方式（并警告只留一个）、快速开始、迁移、配置与优先级、命令、密钥解析、模型能力与模型表、故障排查表、`## 许可`。
- **attention 加索引与主题分节**：历史叙事全部移出到 `.codestable/audits/2026-10-03-history-and-closures.md`（存档逐字保留）；同一决定只说一遍，重复叙述删到一份。
- **新增 pi 三张配置 schema 的事实块**：`ProviderConfigSchema` 10 字段、`ModelDefinitionSchema` 15、`ModelOverrideSchema` 12（含子形状与三族 compat 键）；README 同步字段形状。
- **排版规整**：全部 tracked 文档的散文行 ≤ 200 字，表格行与代码行按「一条记录 / 一句代码一行」豁免。
  - 已发布条目与 `audits/` 也在内，**措辞冻结**：去空白后逐字符相同、未增删一个字（条目字节与 tag 的差异见头部说明）。
  - 三处「一格塞了多件事」拆开：attention 工具层一行 → 4 行、`audits/2026-10-01…` 未定名签名一格 → 6 行、`audits/2026-10-02…` §10 一格 → 表下 3 条。

### 测试
- **新增 `tests/schema-doc-test.mjs`**：从 pi dist 复推三张 schema 的字段、子形状与字段数，并要求它们在文档里以独立词元出现；注入法证明敏感（改名或写错字段数即红）。
- 该测试的字段数断言改为**抗换行**（`块，10 字段` 折成两行不再误红）。
- 24 个套件全绿；`graph-test` 16 个扁平模块无环、`tests/` 保持扁平。

## v0.5.0 — 2026-10-03

### 命令面（破坏性）

- **`/custom-providers` + `/refresh-custom-models` → 单一 `/providers`**：动词表 + 每动词旗标表驱动解析（新模块 `verbs.ts`），任何不匹配都回 `Usage:`（文案由表生成，带诊断行）。动词：`status [<id>]`（默认；
  `drift` 的计数并入其中）、`files`、`init`、`sync [<id>]`、`rescan [<id>]`。首 token 不命中动词表就当 `<id>`（所以 `drift` 现在是「未知 provider」+ `Usage:`）。
- **`sync` 是一条完整流程**（`--write` / `--offline` 消失）：默认联网逐端点抓 `/models` → 只把**答了的端点**并进基底表 → 落盘（先留 `.bak`）；省略 id = 全部 vendor；`--dry-run` 只预览；`--prune` 必须带 id，且仍只在「该 vendor 本轮完整一轮」时删。
  失败或空答的端点跳过并在报告里点名，全部失败则不写盘。结尾提示 `run /providers rescan [<id>]`——盘变了不等于会话变了。
- **新增 `rescan`（唯一零写盘动词）**：重扫目录 + 用**新快照**重新注册，拾取手改的 `provider.json`/`models.json`/`accounts.json` 与新目录；删掉的目录会被真正撤销（`pi.unregisterProvider`，实测存在且立即生效）。`--dry-run` 只报会变什么。
- **`drift` 动词删除**：计数进 `status` 概览行（`, drift N`），明细进 `status <id>`。

### 配置与写口

- **`init` 改为向导 + 参数路径**：有 UI 时问缺的部分（id / baseUrl / api / modelsPath / key），无 UI 时 `init <id> --url … --api …` 缺项即 `Usage:`。
  新增第三个写口 `accounts.json`（`credentials.ts` 的 `writeAccountsFile`）：只在给了 key 且文件不存在时写、值原样落、绝不回显；字面量 key 落盘时会警告明文。
- **删除出厂层**：`sources.ts` / `DEFAULTS` / `defaultAccount` / `envVar` 兜底 / `Vendor.aliases` 与目录撞名守卫全部删除，`collectVendors(root, piProviderIds)` 的输入只有目录。
  代价写在这里：`$CMD_API_KEY` / `$SCNET_API_KEY` 这类出厂密钥变量不再被隐含引用，旧目录需要自己写 `accounts.json`（或 `/login`）。
- **#18 别名漂移修正**：`providerLayerFor(id, config)` 只查 `providers[id]`（`aliases` 参数删除）。
- **#22/#23/#24**：`config.ts` 复刻 pi 的「schema 错 ⇒ 整份文件丢弃」；
  用户 `providers.<id>` 块里 pi 会在注册时抛错的四种形态（空块 / 只写 `api` / `models[]` 缺 `api` / `models[]` 缺 `baseUrl`）改为**调用 pi 之前预报告**（error 级即跳过该 provider），并给 `registerProvider` 加 try/catch 兜底，
  一个坏块不再连带带走后面的 provider。`oauth` 的两态（缺 `baseUrl` 抛错、非 `"radius"` 使 pi 整份丢文件）同样报出。

### 测试

- 23 个用例全绿；`graph-test` 16 模块、无环、全可达。新增 `command-test`、`init-test`、`preflight-test`、`rescan-test`、`compat-keys-test`、`orphan-block-test`。关键路径用注入法证明敏感：静默忽略外来旗标 → `command-test` 红；
  去掉 `unregisterProvider` → `rescan-test` 红；去掉 accounts 文件保护 → `init-test` 红。

### 报告

- **第 3 层不再提供模型内容（破坏性，2026-10-03）**：模型只有一个家 = `<id>/models.json`（`sync`/发现写它）。`providers.<id>.models[]` 过去被本包当补丁读（条目覆盖同名模型、新 id 建模型），现在**不读**并在命令里报告（pi 对扩展注册的 id 也只校验不应用这个数组）；
  补丁改走第 4 层 `modelOverrides[M]`，新模型写进模型表。`config.ts` 的 `applyModelPatch` 随之删除（本包不再有第二个 override applier）。
- **§10 #18 的报告半边：`providers` 里没有目录、也不是 pi 内置 id 的 key 会被点名**（`config.ts orphanProviderBlocks`）：那些块是 config-only id，pi 自己注册、本扩展永不读取，别名旧 key 与打错的 id 都落在这一类。
  以前静默无效，现在 `providers.<key>: no directory for this id … nothing here reads this block`。新测试 `orphan-block-test.mjs`（注册 id / 账号 id / pi 内置 id 三种不报，旧 key 与错字两种报；注入法证明敏感）。
  取不到 pi 内置目录（老 pi 构建）时**不下结论、保持静默**，同 `drift` 口径。
- **§10 #15：报「对 `<api>` 无作用的 compat 键」**（`apis.ts` 的 `API_COMPAT_KEYS`/`inertCompatKeys`）：pi 的 `compat` 只被各协议实现的请求构造器读，而它的运行时 schema 是三个开放对象 schema 的并集，未知键一律通过校验、随后静默丢弃。
  现在按 pi 的读键表点名这类键（`compat key "X" has no effect on <api>`，聚合到每协议一行），覆盖底座表条目、provider 级 `compat` 与 `modelOverrides[M].compat`；
  实测读键数 `anthropic-messages` 13 / `openai-completions` 27 / `google-*` 0。新测试 `compat-keys-test.mjs` 从安装的 pi dist 复推同一张表并断言相等（三个方向的注入法都证明敏感）。

### 差分（v0.4.1 → v0.5.0，模型合成）

对「目录 + 基底表 + 端点 + 第 3/4 层」8 个场景，注册结果 5 处差异，逐条可归因（配方与 runner 见 `.codestable/audits/2026-10-03-v0.4.1-v0.5.0-model-synthesis-differential.md`）：
出厂默认账号消失（`scnet`/`commandcode` 无 `accounts.json` ⇒ `authHeader`/`envVar` 不再隐含，**升级动作：给这些目录写 `accounts.json`**）、旧 key 别名块不再生效（#18 B′）、pi 会拒的 `models[]` 补丁块改为报错并跳过该 provider（#22/#23；
旧版是桩掩盖了 pi 的抛错）、第 3 层 `models[]` 补丁不再生效（场景 S8：
注册 id 下的**合法** `models[]` 条目过去被本包当补丁应用，现在条目留在表外并报警告）、其余（协议 stamping / 端点解析 / 基底合成 / provider 级 compat 折算 / 多账号 / `modelOverrides`）完全一致。

## v0.4.1 — 2026-10-02

### 修复

- **惯例继承不再看协议线**（`00193f0`）：
  `convention.ts` 的 A 步（同族继承）以前只在 `api === "anthropic-messages"` 时才把同族条目的 `thinkingLevelMap` 一并继承，于是本网关 OpenAI 线上新发现的同族 id 永远拿不到 `xhigh` / `max`，顶多到 `high` 且**不报错**。现在任何协议线上都继承。
  B 步（`CONVENTION_FAMILIES` 合成 `{xhigh,max}`）仍只给 anthropic 线，因为那是推断而不是继承；无同族可继承时仍是 `reasoning: false`。差分：对 v0.4.0 的 9 个场景只有 2 个变化，均落在该分支上。

### 文档

- **Command Code 上游路由与能力审计入库**（`720fd73`，`f554654` 去掉账号目录名）：85 个 id 按上游签名分桶（含 21 个被计划门挡住的）、逐模型输出上限实测、§5 模态实测、§1 各条探针配方。
- **`/responses` 线现场验证**（`78824ef`）：`POST <baseUrl>/responses` 在该网关上 200 且流式可用（`resp_01…`），少一层 `/v1` 的路径 404 ⇒ 端点表里 `openai-responses` 的 baseUrl 写法正确；发现阶段仍不据 wire 推协议（`models-test` 守）。
- README 的安装行与 `.codestable/attention.md` 的发版状态行更新到 v0.4.1。

### 测试

- 17 个用例全绿。`convention-test` 新增「同族继承在 OpenAI 形线上同样发生」与 `applyLiveModels` 的接线断言（注入法证明敏感）。

## v0.4.0 — 2026-10-01

**破坏性：仓库不再出厂任何模型表。**

### 破坏性

- **去掉出厂模型表**（`b5d8e4c`）：`extensions/custom-providers/` 里不再带 vendor 的模型目录。provider 的模型基底表 = 你自己的 `~/.pi/agent/custom-providers/<id>/models.json`；
  目录里只有 `provider.json` 时该 provider 注册 **0 个模型**，等实时发现（`/refresh-custom-models`、`sync --write`）或你补表。升级见 README「从 v0.3.0 升级」。

### 修复

- **发现探针的凭据与请求头现在与 pi 完全一致**（`feef5a5`）：以前探针在 `live.ts` 里自己按协议挑凭据、自己定 auth 形态，而 pi 是按 provider 的 `authHeader` 决定是否追加 `Authorization: Bearer` —— 两者会分岔（anthropic 线少发 Bearer）。
  现在选择归 `credentials.ts`（`registrationCredential` / `discoveryCredential`）：
  探针发的头 = 协议默认（`anthropic-messages` → `x-api-key` + `anthropic-version`，其余 → `Bearer`）∪（`authHeader` 为真时补 `Bearer`），等同 pi 的 `withConfiguredAuth`。`credential-test` 守：
  bearer 规则对着 pi 的 `composeModelProvider` 断言、协议默认头对着 Anthropic SDK 的真请求头断言；Command Code 线上实测两种头都 200、同一批 86 个模型。
- **模型字段全量往返**（`4c5ef7d`）：`samplingParams` / `inputLimits` / `promptCache` / `cost.tiers` 以前能被 `models.json` 接受却静默丢掉，现在读写完整往返。
- **`!command` 用 pi 的 shell**（`06aa386`）：Windows 上 pi 用 Git Bash，扩展以前用平台默认 shell，会误报「无 API key」。现在直接用 pi 的 `getShellConfig()`，时间预算也一致。
- **`provider.json` 里写 `models` / `modelOverrides` 会点名去哪**（`11631a6`）：以前只是一句通用 unknown key 提示；现在说明它属于本目录的 `models.json`（模型表只有这一个家，pi 全局 `models.json` 的第 3/4 层是补丁层）。
- **`accounts.json` 的键就是凭据那份清单**（`2dd7127`）、**用 pi 自己的 reader 读 pi 全局 `models.json`**（`8de3205`）、**同一个问题只报一遍**（`ae7478a`）、**账号与 provider 撞 id 跳过并报告**（`52d2a05`）、
  **协议翻转时 layer 的 baseUrl 也算真实端点**（`24b9be3` `c069d48`）。

### 重构

- **一个数据单元一个文件**（`f1bfcc0` `d10b467`）：三份 payload —— `provider.json` → `endpoints.ts`、`models.json` → `model-table.ts`、`accounts.json` → `credentials.ts`（读写同处一文件）。
- **`index.ts` 只做编排**（`011d69a`）：命令分支与 `provider.json` 写入各有其家；`config.ts` 拆出 `apis.ts`（`4626ff7`）。
- **一个 codec**（`bae9dee`）：JSON 读写收敛到 `util.ts`（一个 tab 缩进 + 结尾换行；写盘 temp + rename，基底表留 `.bak`）。
- **导入图无环且可达**（`986f31e`）：16 个扁平模块，`graph-test` 守图（含 type-only 回边）；`util.ts` 是叶子。
- **本扩展自己的刷新轮次不落盘**（`c2ad27e`）：`publish` 变成可选，扩展的刷新不再持久化（pi 自己的刷新照旧）。

### 测试（17 个用例，`node tests/run-all.mjs`）

- `pi-native-test`：跑 pi 真的 `ModelRuntime` + store，是扩展 ↔ pi 契约的唯一 pin（本包无 `tsconfig` / tsc）。
- `credential-test`（凭据顺序与 auth 形态）、`pi-surface-test`（`models.json` 字段表对着 pi 的 schema）、`env-test`（值语法对照 pi 的解析器）、`graph-test`（导入图）、`apis-test`（协议表对照 pi 的注册表）。
- 脚手架合并到 `harness.mjs`（一个 stub pi + 一个模型工厂），`PI_CODING_AGENT_DIR` 指向临时目录，不写 `~/.pi`。

### 文档

- README 重写安装/升级/配置/4 层优先级/密钥解析/测试各节。
- `.codestable/attention.md`：分层与接口、引擎数据流（每项带 `file:function` 锚点）、单元归属表、技术债（F1–F12 全闭）。

## v0.3.0 — 2026-09-30

- 新发现的 id 走 convention 兜底（同族继承 → 已知可推理家族名单），并在启动报告里点名，不静默写盘。
- 消失的 id 有报告（失败/空答案时抑制），`sync --prune` 才真删。
- `init` 写盘是唯一有意保留的例外，文档写明。

## v0.2.4 — 2026-09-22

- **破坏性**：provider 只来自目录，不再有内置 id；旧安装用 `/custom-providers init` 补目录。

## v0.2.3 — 2026-09-22

- 同名目录覆盖我们自己的内置 vendor 不再告警（接管 pi 内置仍需 `override: true`）。
- 刷新 commandcode 目录（+7 -1：glm-5.3-flashx、mimo-v2.6 ×3、LongCat-2.0、Step-5-Preview、grok-4.7；LongCat-2.0:free 改名）；scnet 因配额耗尽（200 + 空列表）保留原块。

## v0.2.2 — 2026-09-20

- 清理改名前的措辞。

## v0.2.1 — 2026-09-19

- README 写明凭据供给路径与「永不提交密钥」规则。

## v0.2.0 — 2026-09-18

- **破坏性**：通用多协议引擎（v4.0）—— `providers.<id>.wire` 没了，改按模型的 `api` 选协议；provider id 统一为 `commandcode`。

## v0.1.0 — 2026-09-18

- 首个版本：`custom-providers` 扩展（把 SCNet 合并进模型表）。
