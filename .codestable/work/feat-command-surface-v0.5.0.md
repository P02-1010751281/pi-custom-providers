# feat-command-surface-v0.5.0 — 命令面收口（v0.5.0）

创建：2026-10-02 ｜ 类型：feat ｜ 状态：设计已定，未开工

## 目标

1. 命令面收成一条 **`/providers`**：动词 + 旗标两张表驱动解析，任何不匹配都报 `Usage:`（不再静默）；旧 `/custom-providers`、`/refresh-custom-models` 消失。
2. **`sync` 是一条完整流程**：`fetch`（联网 `/models`）→ `apply`（合成基底表 + 落盘 + publish）→ **提示生效命令**（不在会话内重扫/重注册）。`--dry-run` 只预览；`--prune` 删掉发现不再返回的 id；抓取按端点跳过（详见下）。`--offline` 已删除。省略 id = 刷新全部 vendor。
3. **删出厂两厂**：`sources.ts` / `DEFAULTS` / `defaultAccount` / `envVar` 兜底 —— 装配里不再有 vendor 知识。
4. **`init` 改向导**（`ctx.hasUI` 分级，非交互退回参数路径）：问端点、**直接收 key**（明文允许但警告）→ 原样落 `provider.json` + `accounts.json`。
5. `probe` **不单立动词**（被「向导结尾」+「`sync` 的 fetch 步」覆盖）。
6. 版本 **v0.5.0**（MINOR；含破坏性：命令改名、动词收缩、删除出厂层）。发版须 owner 点头。

## 命令面草案（2026-10-02，待 owner 过一遍；动词表 + 每动词旗标表驱动）

一条命令 `/providers`（旧 `custom-providers` / `refresh-custom-models` 消失）。第一个 token 命中动词表才是动词，否则当 `<id>` 或默认动词 `status`。

| 动词 | 位置参数 | 旗标 | 作用 | 写盘 |
|---|---|---|---|---|
| `status`（默认，可省略） | `[<id>]` | — | 总览 / 单 provider 详情 | 否 |
| `drift` | — | — | 已注册模型 vs pi 内置目录的差异（只报不改） | 否 |
| `files` | — | — | 重扫目录：逐 vendor 的 id/来源/模型数/账号数、被忽略的目录、校验问题 | 否 |
| `init` | `<id>` | `--url <u>` `--api <a>` `--models-path <p>` `--key <v>` `--force` | 向导（`ctx.hasUI`）/ 参数路径；写 `provider.json` +（收到 key 且文件不存在时）`accounts.json` | `provider.json`、`accounts.json` |
| `sync` | `[<id>]`（省略 = **全部** vendor） | `--dry-run` / `--prune`（`--prune` 必须给 id） | fetch → apply（落盘 + publish），结尾提示生效命令 | `<id>/models.json` |
| `rescan` | `[<id>]` | `--dry-run` | 重扫目录 + 用新快照重新注册 / 撤销消失的（拾取用户/外部的手动改动） | 否（改会话状态，不改盘） |

规则：
- 动词不认识 / 旗标不属于该动词 / 多余位置参数 / 缺必填位置参数 → 一律 `Usage: …`（警告级），文案**由两张表生成**（单一事实）。
- `sync` 的 `--write`、`--fetch`、`--offline` **都不存在**：落盘与联网都已是默认行为（`--dry-run` 拒写）；“只用本进程已有数据、不联网”这个模式也删了（它字面像“整机离线”，实际只是跳过 fetch；要只看差异用 `--dry-run`）。
- `drift` / `files` **保持独立动词**（原「降为 `status` 旗标」的方案作废：它们不是 `status` 的修饰语，也不能与 `<id>` 组合——`status scnet --files` 没意义；当动词读起来自然，且与旧命令名一致，迁移只是换前缀）。
- 动词表优先：provider 若叫 `drift`/`files`/`sync` 等同名，一律需用 `status <id>` 访问（与今天 `head === "drift"` 的行为一致）。
- `rescan` 是唯一的**零写盘**动词，用途 = 用户或外部工具手动改了 `provider.json`/`models.json`/`accounts.json`、或新建/删了目录，把它拉进当前会话；`--dry-run` 只报“会变什么”。名额取 `rescan` 而非 `reload`（不与 pi 内置 `/reload` 同词；2026-10-02 owner 提议、agent 同意）。与 `files` 的分工：**同一次扫描的两个用法——`files` 是只读视图（看盘长什么样），`rescan` 是用扫描结果改会话状态（做）**；`files` 永不动注册，`rescan` 永不写盘。
- **pi 有 `pi.unregisterProvider(name)`**（2026-10-02 实测 `types.d.ts:1328`；命令处理器里调用**立即生效**，移除该 provider 的全部模型并恢复被它覆盖的内置模型）⇒ 目录消失可以在会话内**真正撤销**，先前设的“删目录必须靠 pi 的 `/reload`”这条硬边界作废；剩下唯一必须走 pi `/reload` 的是“改了扩展模块代码”。安全线：只撤销**本包自己上一份快照里**的 id（`loader.ts:370` 传 `extension.path`，但默认 runtime 不做归属校验 —— `runner.js:323` 只收 name）。
- `sync` 省略 id = **刷新全部 vendor**（owner 2026-10-02，取代今天 `/refresh-custom-models` 的位置）：逐 vendor 逐端点，失败/空答的跳过并在报告里点名；**全部 vendor 都没新数据 ⇒ 不写盘**；`--prune` 仍只在「该 vendor 的一轮完整」时生效（逐 vendor 判定，不是全局开关）。
- **待认：`drift` 的存废/口径**（owner 2026-10-02 问「drift 到底有啥用」）。实测（本机 commandcode 85 + scnet 19 个模型，pi 内置目录 770 个 id）：全部对照上、113 条差异；**5% 容差后仍有 62 条真差异**（我们更大 21 / 更小 41），≤5% 的写法差 47（`10^6` vs `2^20`）。最大一类 = claude-* 的 `maxTokens` 64000 vs 128000（上游自身上限不同），唯一量级差 = `gpt-6.1-sol`/`gpt-6-astra` 的 ctx 1.05M vs 272k。⇒ 它的价值只在“能力值抄大了导致 pi 放超上下文”这个坑（`/models` 端点不给能力，能力值只能来自表），但现状输出是 113 条对账清单、且判不出谁对。选项：**(a) 收窄保留**（只报“我们 > 内置 ×1.5”与布尔差 reasoning/vision，103 条→约 6 条）；**(b) 删动词**，`status` 里留一行“与内置目录有 N 条差异”。**建议 (a)**。

## 现场（本轮已核实）

**命令面（`extensions/custom-providers/index.ts`）**
- 注册：`refresh-custom-models` `:234`、`custom-providers` `:369`；处理函数 `runInit:248` / `runDrift:259` / `runFiles:281` / `runSync:295` / `runStatus:342`。
- 旗标全集只有三处：`:249 --force`、`:319 --prune`、`:329 --write`，全部 `rest.includes(...)`。
- 解析缺陷四处：`sync` 的 `Usage:` 漏 `--prune`（`:300`）；未知动词落 `runStatus`（`:374-378`）→ `/custom-providers drfit` 答 `Unknown provider "drfit"`（`:346`）；错字旗标静默（`sync x --writ` 当 dry-run）；多余参数被丢弃（`:372` 只取 `head`/`rest[0]`）。

**两条半程命令**
- `refresh-custom-models`：**联网**（`:238` `allowNetwork:true`）→ 填本进程 memo + 重注册。
- `sync`：**不联网**（`:310` 注释 "never a fresh network call"）→ 读磁盘 `<id>/models.json` → 叠加 memo（`:313` `applyLiveModels`）→ 默认 dry-run；`--write` 才 `writeBaseTable`（`:336`）；`--prune` 才删 `vanished`（`:322-326`）。
- ⇒ 名字错位在 `sync`：它不同步远端，只把已到手的结果写本地。

**生效链缺口（本轮新发现）**
- `entries` 是**加载期快照**（`:200-229` 一次 `collectVendors`）；`:237` 与 `:387` 的重注册都用这份旧快照，不重扫目录。
- `runSync` 自己重扫了一次（`:298`），但 `--write` 落盘后**不重注册**（`:336-340` 只有 notify）。
- ⇒ 写盘 ≠ 生效：改 `compat`/`thinkingLevelMap`/`contextWindow` 或 `--prune` 后，须 `/reload` 才可见；重跑 `refresh-custom-models` 也没用（重注册旧快照）。

**出厂两厂的引用面（删除清单）**
- 代码：`sources.ts:35 DEFAULTS`；`index.ts:61`（import）、`:187-193`（defaults→collectVendors）、`:248-257`（runInit）、`:374`（分派）；`endpoints.ts:141-145`（`writeProviderFile` + `pass --force` 文案）；`credentials.ts:34/144`（`defaultAccount`/`envVar` 来源）；`types.ts:53`、`directory.ts:136`（注释）。
- 测试：`apis-test.mjs:15-20`（fixture 直接取自 `DEFAULTS`）、`harness.mjs:143-145`（init 复刻）、`no-builtin-test.mjs`（整条）。
- 文档：`README.md:55/149`、`attention.md:63/97/118/170/174/188`（含 mock-gateway 实测配方，靠改部署副本 `sources.ts` 的 baseUrl）。

**凭据（本轮已核实）**
- 读侧**本来就接受明文**：`credentials.ts:5-10` 把 `sk-…` 列为首个合法形态；🚫 禁用措辞只活在未跟踪的 `.agents/memory/MEMORY.md:19`（编译摘要），tracked 文档无此禁令。
- 解析器 `resolveConfigValue`（`env.ts:85-99`）四形态：`$VAR` / `${VAR}` / 裸 `UPPER_SNAKE` / `!cmd`；`$$` / `$!` 是转义（解析出字面量）。
- 真约束：**永不把引用解析成字面量落盘**（`credentials.ts:9-11`）。
- 裸 `UPPER_SNAKE` 一律当**环境变量名**（`attention.md:159` 的 401 坑）。
- `~/.pi/.gitignore:5` 已忽略 `agent/custom-providers/*/accounts.json`；会话 JSONL 只有 `message` 一类条目（对话框输入不入日志）。

**写盘与 UI 面**
- `writeTextAtomic`（`util.ts:58`）是两个写口共用的原语；出口 = `writeProviderFile`（`endpoints.ts:129`）+ `writeBaseTable`（`model-table.ts:173`）。
- `attention.md:88/185` 的「写盘唯二出口」本轮被改写为**三条**（+ `accounts.json`）。
- pi 扩展 UI 有 `input`/`select`/`confirm`/`custom`；JSON/print 无 UI、RPC 只转发部分 dialog ⇒ 一切交互 `ctx.hasUI` 守卫（pi `docs/extensions.md:240-247`）。

## 边界

**必须改**
- `index.ts`：命令注册合并为 `/providers`；解析改为「动词表 + 每动词旗标表」，`Usage:` 文案由表生成。
- `index.ts` 三处注册调用点（`:225` 启动、`:237` 刷新命令、`:387` `session_start`）**加 try/catch**（owner 2026-10-02 批准）：单 provider 注册失败只计入 `globalIssues`/`statuses`，不中止循环；同时补 v1 §10 #22/#23 的**预先报告**（空 `providers.<id>` 块、`models[]` 缺 `api`）——在打给 pi 之前报，别等它抛。注意 `registerEntry` 的返回是 `{ refresh }` 或 `undefined`（被拒），catch 不得把「被拒」与「抛错」混为一谈，也不得丢掉能用的 `refresh`。
- `runSync`：两步 + 一句提示（fetch / apply = 合成表 + 落盘 + publish），旗标 `--dry-run`、`--prune`；**不再重扫目录、不调 `registerEntry`**（生效统一靠 `/reload`）。抓取按端点进行：失败/空答的端点跳过并在报告里点名，全部失败则不写盘。
- `init`：向导（`ctx.hasUI`）+ 参数路径 `init <id> --url … --api … [--force]`；新增**结构化 accounts 写口**（住 `credentials.ts` 旁，spec 从 `ACCOUNT_ID_RE`/`ACCOUNT_KEYS` 派生，值原样落）。
- 删除 `sources.ts` 及其全部引用与测试 fixture；`apis-test.mjs` fixture 改字面量；`no-builtin-test.mjs` 重写为「零出厂 vendor」。
- `attention.md:88/185`（写口 2→3）、`README.md:55/144-150`（命令表）、`CHANGELOG.md` 新增 v0.5.0 条目。

**需要验证**
- 全量 `node tests/run-all.mjs` + `graph-test`；新增用例：typo 动词/旗标、向导三态（打桩 `fetch`）、原样落值、写回读对偶（`readAccountsFile` 零 issue）、值不回显；`reload` 三条（手改 `models.json` 后 reload 可见、删目录后 reload 撤销注册、`--dry-run` 既不改注册也不写盘）；`sync --prune` 无 id → `Usage:`。
- 与 `v0.4.1` 差分：预期变化只应在命令面与删除项；模型合成不变。
- 生效验证：`sync` 写盘后**同一进程内** `/providers <id>` 能看到新表。

**仍待调查**
- 无。（SCNet 现场复测按 owner 决定去掉。）

## 验收

1. 错字动词/错字旗标/多余参数一律报 `Usage:`，且 `sync` 的 Usage 含 `--prune`。
2. `sync <id>` 默认联网 → 落盘 + publish → 结尾提示 `/reload`；`--dry-run` 不写盘；`--prune` 删 vanished；抓取失败的端点被跳过且报告点名，全部端点失败/空答则不写盘。
3. `init` 在 `hasUI` 下走问答、非交互走参数路径；明文 key 落盘并有警告；`accounts.json` 写出的文件 `readAccountsFile` 读回零 issue。
4. `sources.ts` 不复存在，仓库内 `DEFAULTS` 零引用。
5. `reload`：手改 `<id>/models.json` 后同会话可见；删掉目录后同会话从选择器消失（撤销）；`--dry-run` 只报不改。
6. 全量测试 + graph-test 绿；差分证据齐全。

## 状态与未决

**已定**（owner，2026-10-02）
- `sync` 取**乙（修订版，2026-10-02 owner）**：默认 fetch + apply/落盘 + publish，**不再在会话内重扫/重注册**，结尾明确提示「跑 `/reload` 生效」（`/reload` 是唯一重解析目录的机制；`init` 与 `sync` 规则由此统一为「改盘 → `/reload`」）；`--dry-run` 预览、`--prune` 保留、**无 `--offline`**（该模式删除，无替代旗标）。代价（要写 CHANGELOG）：比今天的 `refresh-custom-models` 多一步 `/reload`（今天靠重注册 + 内存 memo 当场可见）。
- **抓取失败粒度（owner 2026-10-02「跳过有问题的」）**：逐端点抓；失败或空答的端点**跳过**（沿用 `live.ts:240` 现有守卫——`vanished` 只在「所有可发现端点都答了且非空」的完整一轮里产生，所以 `--prune` 天然不碰它们）；成功的照写；报告点名被跳过的端点。**全部端点都失败/空答 ⇒ 不写盘**（没有新数据可 apply，重写同一份字节无意义）。`sync <id>` 本就是单个 provider，爆炸半径 = 一个 vendor。
- ✅ **已认（owner 2026-10-02）**：向导允许 `--key` 直接收明文（非值表达式时警告、不阻断）；`drift`/`files` **保持独立动词**（owner：「status 后面两个旗标怪怪的」→ 回到动词）。
- ✅ **`sync` 省略 id = 刷新全部**（owner 2026-10-02；与 `status` 的“无 id = 全部”一致，也接替今天 `/refresh-custom-models` 的位置）；`--prune` 必须给 id（全量 prune 不许一键）。`init` 无 id 时：有 UI 走向导问 id，无 UI 报 `Usage:`。
- ✅ **`rescan [<id>] [--dry-run]`**（owner：为了用户/外部手动改了文件或目录；名字 `rescan` 取代 `reload`，避开 pi 的 `/reload`），已入动词表。
- **`probe` 不立动词**；`init` 向导 + 参数路径都做；向导直接收 key（明文允许，发现非值表达式时警告，不阻断）；SCNet 不测。
- **#22/#23 并入 v0.5.0**：补预先报告 + 三处注册调用点加 try/catch（2026-10-02 owner 批准；要求逐步测试先行、注意 `registerEntry` 的返回值语义）。

**未落地项的处置（逐条，2026-10-02 核对 §10）**
- ✅ **#22/#23 并入 v0.5.0**（owner 批准）：补预先报告 + 三处注册调用点（`:225/:237/:387`）加 try/catch，逐步测试先行；catch 不得混淆 `registerEntry` 的两种「没成功」（返回 `undefined` = 被拒；抛错 = pi 拒绝），也不得丢掉能用的 `refresh`。
- 🔁 **#15 需重开**（2026-10-02）：前提“上游会忽略它”**不成立** —— `compat` 不是发给上游的字段，而是 **pi 请求构造器的开关**（每个协议实现只读自己认识的键，实测表：`anthropic-messages` 读 13 个、`openai-completions` 读 27 个，被 ≥2 个协议读的键有 9 个：`supportsStrictMode`/`supportsMidConvoSystemMessages`/`supportsLongCacheRetention`/`supportsDeveloperRole`/`supportsOpenAIGrammarTools`/`supportsAdditionalTools`/`supportsToolSearch`/`sendSessionAffinityHeaders`/`sessionAffinityFormat`）。判据应改成“**该键是否被目标 api 的实现读**”：不被读 ⇒ 永不上线（零影响）；被读（含跨族但落在交集里的）⇒ 它真改请求体，可能上游 400。三个选项：(a) 不报（现状）；(b) **报「对 <api> 无作用的 compat 键」**（用 pi 的实现表当判据，`pi-surface-test` 同法钉住，零误报）；(c) 报“跨族”（要自造族表，交集处会误报）。→ **建议 (b)**。
- 📝 **#24 的正确说法**（原表里写得不全，实测源码）：`models.json` 的 schema 里 `oauth` **只能是字面量 `"radius"`**（`model-config.js`：`Type.Optional(Type.Literal("radius"))`）。① 不装 oauth 方法（`composeOAuthAuth` 只看 extension/base）—— 只有这一半是「inert」；② `config.oauth && !config.baseUrl` → **pi 抛** `"baseUrl" is required when "oauth" is set`（会打到我们的注册循环，同 #22/#23 一路）；③ 它会**满足** pi 的「非空块」检查（空块才抛）；④ `oauth: "radius"` 时 `applyModelsJson` 把 baseUrl 优先级翻成 `model.baseUrl`（对我们无可见影响：用户层的 baseUrl 已被我们写进 provider 级 `baseUrl` 并落到模型上）；⑤ 其它取值 = 类型错 → pi **整份丢弃** `models.json`（§10 #21 的行为，比 inert 严重）。⇒ 待定：这四条报告到底补不补（#14/#18 建议补，#24 按上式写清）。
- 📝 **#14 的建议**：老体系的「默认接线 + 选线优先级（含 messages/responses 偏好）」就是 v4.0 删掉的 7 级链（`wireSelectionFor`/`siblingId`/`anthropicBaseUrl`，v1 doc:224「没有优先级链、没有 tie-break」），所以旧 `wire` **无法机械映射**成新 `api`（链已不存在）。本机实测无 `wire` 键、无用户 ⇒ 建议不进命令报告，只在 README 的迁移段写一行。
- 📝 **#18 的处理选项**（待定）：(A) 只报告「别名下的 `modelOverrides` 不生效，改写到 `<id>` 下」——判据仅“`providers.<alias>.modelOverrides` 存在”；(B) 我们代它应用——等于复刻 pi 的 `applyModelOverride` 语义（第二份实现，本仓库最忌），且要定义与 pi canonical 层的顺序；(C) 别名只用于读、README 明写哪些字段生效。→ **建议 (A)**。
- 📝 **#24 的处理选项**（待定）：把 `oauth` 当成 config 层的「不适用键」，与 README:94 已有的 `provider.json` 不适用键清单同形；报告文案要盖住四点（唯一合法值 `radius` / 对我们不装 oauth / 缺 `baseUrl` 则 pi 抛 / 其它值整份丢文件）。与 #22/#23 一起构成 config 层检查的两块（pi 会抛的预报告；对我们不生效的报告）。→ **建议做**。
- 📝 **`--offline` 命名被推（owner）**：字面像“整机离线”，实际只是“跳过 fetch 用本进程 memo”。三个选项：(A) 改名 `--no-fetch`；(B) **删掉该模式**——`sync` 默认联网，**任一可发现端点抓取失败就不写盘只报错**（不静默降级），这样“冷 memo 假阴性”与“把抖动写进表”一起没了，也不再需要旗标；(C) 回到先前的 `sync --fetch`（默认本地）。→ **建议 (B)**（更少旗标，且“不影响”原则一致：扩不了就别改表）。
- 📝 **#18**：见命令面回答（别名下的 `modelOverrides` 是唯一在别名 key 下失效的字段；其余 `baseUrl`/`apiKey`/`headers`/`api`/`models[]` 都生效）。

**定案（owner 2026-10-02，覆盖上面各条的建议）**
- **#15**：改口径为「报『**对 `<api>` 无作用**』的 compat 键」——判据 = pi 各协议实现实际读了哪些键（开工时落成常量，并用 pi dist 重推的测试钉住，`pi-surface-test` 同法）。
- **#18**：取 **(B′) 漂移修正**（不是 A 的只报告）：别名 key **不再是配置层**——`providerLayerFor(id, config)` 只查 `providers[id]`。**已实现（2026-10-02）**：`config.ts` 去掉 `aliases` 参数、`index.ts:220` 两处调用随之更新；`tests/models-test.mjs` 与 `tests/apis-test.mjs` 改为钉「别名 key 不读 + 注册 id 仍读」（测试先行：改前红/改后绿）；差分 2/7 例（都只在「块只写在别名 key 下」时变）→ 全量 17/17 + `graph-test` 16 modules 绿。
  - 附带事实：`aliases` 字段在删掉出厂两厂后只剩 `directory.ts:149` 的「目录撞名守卫」一个读者 ⇒ 那一步要同时决定：删掉这个字段，还是明写它只服务撞名守卫（不能留无读者的词汇）。
- **#24**：做，当 config 层「不适用键」，文案盖四点（`radius` 唯一合法值／不装 oauth／缺 `baseUrl` 会被 pi 抛／其它值整份丢文件）。
- **#14**：不进命令报告，只在 README 迁移段一行。
- **`--offline`**：删（无替代旗标）；「只看差异」= `--dry-run`，「不写坏表」= 失败端点跳过 + 全失败不写。

**未决**
- 无设计级未决项。开工与发版各须 owner 点头。

**迁移（v1 → v2）**
- 老 v1 doc：`.codestable/features/2026-09-18-generic-wire-engine/`（547 行，v2 规矩下只读）。
- 口径：老 doc 只留历史；**live 事实按归属搬进 v2**（`attention.md` / `README.md`），老目录不删（git 留痕）。
- **已执行（2026-10-02）**：
  - 搬 `attention.md` 新节 **「pi 各协议的 baseUrl 拼接（实测）」**（v1 §2.4 的 10 行协议表 —— 此前 attention 只有 anthropic 一条）。
  - 搬 `attention.md` 新节 **「接管面（pi 侧，实测）」**（v1 §2.1/§8：`models.json` 只剩四项流入；config-only provider 也会被 pi 注册；别名下的 `modelOverrides` 失效）。
- census 结论（逐节对过 `attention.md` 190 行）：

| 老 doc | 现状 canonical 家 | 处置 |
|---|---|---|
| §2 pi 侧契约（源码核实）、§8「接管后谁做什么」表 | 大部分已在 attention（`modelOverrides` 最高层、provider 级 compat 被丢、无凭据也注册、离线刷新坑、裸 `UPPER_SNAKE`、fail-closed） | **两块已搬**（见上）；其余不搬 |
| §附：与 pi 原生词汇的对照 | README + attention（「四个自有词汇」） | 不搬 |
| §5.1/§5.2 端点选择与字段改写、§5.3 compat 族键数 | README / attention | 不搬 |
| §6.3 吸收白名单、§6.4 失败与持久化 | attention | 不搬 |
| §7 多账号、§8 `override` 白名单 | README / attention | 不搬 |
| §9 命令表 | README + 代码 | 命令表本轮被 v0.5.0 改写 |
| §10 校验与错误表（27 条） | 代码消息是家 | **逐条对过**（2026-10-02）：落地 20 条（含 #26，`live.ts:209-229` 的 try/catch 保证 `refreshModels` 不抛，`synthesizeModels` 补 `cost`/`api`/`baseUrl` 替代「剔除该条」）；**未落地 6 条**：#14 旧 `wire` 键不报、#15 compat 跨族不报（**已定：不报，原样转上游**）、#18 别名下的 `modelOverrides` 不报（静默无效）、#24 config 侧 `oauth` 不报（且口径不止一个，见下方处置）、#22/#23 不预报告（**已定：补**）、#27 只做到「无凭据仍注册」未做警告。命令面收口改写 §9；未落地项见下方待决 |
| §11–§14（改动清单/测试计划/部署/风险）、§15、§18 | 历史 | 不搬（git 留痕） |
| §16 已定决策 1–18 | 逐条对过：1–17 已在 README/attention/代码；#17（provider 级 compat 只贴**有效默认协议**上的模型，刻意偏离 pi）在 README；#18 的能力权威随 v0.4.0 删生成器后只剩 `convention.ts`/`builtin.ts` 在跑 | 不搬 |

- 老 doc 里已失效的历史事实（不要引用）：`catalog.ts` 生成器与出厂模型表（v0.4.0 删）、`siblingId`/`anthropicBaseUrl`/`wires`（v4.0 删）、`providers.<id>.wire`（v4.0 删）。

- 本轮新建的 `.codestable/work/` 会被 git 跟踪（`.codestable/.gitignore` 只挡 pycache 与 feedback 运行期文件）。

## 实现进度（2026-10-02，本会话）

**已落地**（21 用例全绿 + graph-test 17 模块）：
- 命令面：`/providers` 唯一命令 + `verbs.ts` 动词/旗标表 + `Usage:` 生成；`drift` 并入 `status`（概览计数 + 单 provider 明细）。
- `sync` 新流程（默认联网、逐端点跳过、省略 id = 全部、`--dry-run`、`--prune` 需 id）+ `rescan`（重扫 + 新快照重注册 + `unregisterProvider` 撤销消失目录）。
- `init` 向导 + 参数路径；`accounts.json` 第三写口（`credentials.ts writeAccountsFile`）。
- 删出厂层：`sources.ts`/`DEFAULTS`/`defaultAccount`/`envVar`/`aliases` 与目录撞名守卫。
- #18 B′（别名不再当配置层）；#22/#23/#24（预报告 + try/catch + 复刻 pi 的整份丢文件校验）。

**本会话新测得的 pi 事实（写进 `attention.md` 接管面）**：
- 用户 `providers.<id>` 块由 pi 用它**自己的内置模型表**在注册时校验：空块 / 只写 `api` → `must specify …`；`models[]` 缺 `api` → `no "api" specified`；`models[]` 有 `api` 缺 `baseUrl` → `"baseUrl" is required when defining custom models`。⇒ 对本扩展的 provider，`models[]` 是「新建模型」而非补丁，**补丁要用 `modelOverrides`**。
- `pi.unregisterProvider(name)` 存在且立即生效（撤销 provider 并恢复被覆盖的内置模型）。

**待办（下一轮）**：
- §10 #15：报「对 `<api>` 无作用的 compat 键」（需 per-api 读键表 + pin）。
- 待 owner 定：`providers.<id>.models[]` 在本扩展里仍作为第 3 层补丁被读（pi 侧会拒这种块，除非条目自带宽 `api`+`baseUrl`）——是保留这条自造层，还是把模型补丁的文档口子只留 `modelOverrides`。
- `v0.4.1` 差分对照（模型合成部分预期不变）未跑；`this round` 其余项已由 21 用例覆盖。
