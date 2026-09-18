# 设计方案评审 — generic-wire-engine v4.0

- 日期：2026-09-18
- 评审对象：`generic-wire-engine-design.md`（v4.0）
- 结论：**有条件通过** —— 两轮发现全部处置；开工前还差 §5「待验证」里的证据

## 评审安排

| 轮次 | 谁 | 上下文 | 产物 |
|---|---|---|---|
| 第一轮 | 作者自评（ponytail 最小化 + caveman 一行一条） | 全程上下文 | 用户意见 → 设计改动映射（下表）、v3.3 的 🔴 全修 |
| 第二轮 | **独立 reviewer：`pi -p --no-tools --no-session`，新进程、临时 session dir、cwd=/tmp、无工具** | **只有设计全文 + 评审口径，无本会话历史、无仓库访问** | 原文见下；处置表见后 |

第二轮命令（可复现）：

```bash
cd /tmp && pi -p --no-tools --no-session --session-dir /tmp/pi-review-ctx \
  --provider scnet --model GLM-5.3 \
  --system-prompt "你是严格的设计评审员，用中文输出，遵守用户给的口径与格式。" \
  "$(cat /tmp/review-prompt.md)"   # = 评审指令 + 设计全文
```

## 第一轮：用户意见 → 设计改动

| 用户意见 | 处理 |
|---|---|
| `apiKey`/`authHeader` 归因错误，与跨线无关 | 账号只装认证；`provider.json` 出现凭据键即报告。删掉「跨线不同 key = 两个账号各钉一条线」 |
| provider 的 `wire` 名称与语义差别大 | 整块删 `wires`/`wire`，端点改用 pi 原生 `api`+`baseUrl`；自有名词只剩 `apis`（键 = pi 的 api 值） |
| `wire` 实际就是 API 配置 | 是；`apis.<api>` = 该协议的端点，模型选端点 = pi 原生 `models[].api` |
| 订阅与按量应归两个 provider（如 opencode go / zen） | 决策 7：provider 边界 = 产品/计费边界。实证：`pi-ai/dist/providers/opencode*.js` 两个 id、共用 `OPENCODE_API_KEY` |
| 账号里为什么有 `wire`？账号只管认证 | 账号字段收敛为 `apiKey`/`authHeader`/`headers`；模型覆盖交给 pi 全局 `models.json` 的 `providers.<accountId>` |
| 覆盖链层级太多且乱 | L0–L8 → 4 层；每层按字段补丁（与 pi 的 `modelOverrides` 同语义） |
| 模型兼容性应在 models 而不是 provider | `provider.json`/`apis` 删 `compat`（出现即报告）；compat 只写模型条目 |
| api 类型应覆盖 pi 支持的全部 | 接受 `BUILTIN_APIS` 全部 10 种（`pi-ai/dist/compat.js:108`），表外报告 + 跳过 |
| account 的 default 直接是账号 id | `"default": "<账号id>"` 字符串指针；被指向的账号注册为 base id，其余照常注册 |
| 整体乱 / 重新评审且别污染 reviewer 上下文 | 版本变化史压到文末；第二轮用独立无工具进程评（上表） |

## 第二轮：独立 reviewer 原文

> # 设计评审：通用多线 Provider 引擎 v4.0
>
> ## 一、结论
>
> **有条件通过** —— pi 契约考古扎实、概念收敛方向正确，但「账号边界 vs 多账号」「非目标 vs 别名」「裸大写糖 vs 原样透传」三处自相矛盾会直接决定实现行为，另有十余个未定义交集，修完才能开工。
>
> ## 二、发现
>
> ### 🔴
>
> §3.3+§6 vs §2.4: 🔴 「全大写 SNAKE＝环境变量名」是自造解析规则，而 apiKey 值按 §2.4 原样交 pi、pi 只认 `$VAR`/`!command` 等五种——发现请求拿得到 key，正式请求把变量名当字面 token 发出去（401）. 删糖，或注册前规范化为 `$VAR` 再交 pi.
> §7+§16(7) vs §3.3: 🔴 「不同 key＝不同 provider（不同目录）」与 accounts.json 多账号（一个目录多把 key → N 个 provider id）正面互斥；opencode/opencode-go 共用同一把 key，只支撑计费边界、支撑不了 key 边界. 边界改成纯计费/产品边界并明写账号的存在理由，或砍多账号.
> §1 vs §8+§11+§10(18): 🔴 非目标白纸黑字「不做 provider 别名」，§8 却实现 `aliases` 且半生效（baseUrl/models[]/compat 走别名、modelOverrides inert 还要专门报错）. 砍别名（id 不改名），或删该非目标并把 alias 语义写全.
>
> ### 🟡
>
> §3.1+§16(3) vs §10(4): 🟡 `api`/`baseUrl` 都标必填，#4 却写「无 baseUrl 且 apis 也空」才跳过；「缺 `api`」没有任何错误条目与失败路径. 两者必填、#4 收窄、补 `"api" is required`.
> §4: 🟡 同节打架：「写了的字段赢」vs「models[].baseUrl 只对未自带 baseUrl 的模型生效」；「自带」含不含 apis 自动填充未定义，非默认端点的第 3 层重定向谁赢无答案. 定死合并顺序：L1+L2 先合成、再整体套 L3 补丁、逐字段高者胜.
> §5.2+§4: 🟡 「api 指向未声明协议→回落默认」会把第 3 层/基底自带的合法 api+baseUrl（协议在 BUILTIN_APIS）一并吞掉，违反自家「api/baseUrl 可由第 3 层决定」. api∈BUILTIN_APIS 且 baseUrl 可解析即放行，仅 baseUrl 无法解析才回落.
> §4+§5.1: 🟡 用户第 3 层只改 `providers.<id>.api` 不改 baseUrl：协议翻了、端点还是旧协议的，请求必错，无兜底规则. 翻转默认协议时 baseUrl 取 `apis.<新协议>.baseUrl`，取不到就报错拒绝.
> §8 vs §10(11): 🟡 「内置 vendor + 用户 accounts.json 无 default」交集未定义——按 #11 字面，给 scnet 加个 work 账号忘了写 default 会顺手注销内置 base id. 无 default 时回落内置基底账号，并写进 #11.
> §8(③) vs §13: 🟡 ③「命中全局 models.json 已声明必须 override」会误伤主用例——用户 `providers.scnet` 本该无 override 与第 3 层共存（§13 零迁移承诺）；「已声明」判定范围没写. ③ 限定为 pi 内置目录.
> §6: 🟡 发现按端点不按账号：用哪个账号的 key/headers 没写，结果却共享给全部账号；账号权限不同时模型集合归属不明. 按账号×端点探测，或明写「default 账号探测、结果全账号共享」.
> §6 vs §2.4: 🟡 发现凭据顺序把第 3 层 apiKey 排在账号 apiKey 之前，请求侧是扩展(账号)>models.json——同一凭据两套优先级，探活与真实请求可不一致. 对齐 §2.4 顺序.
> §2.5+§6: 🟡 refreshModels 返回值「替换」注册表，第 3 层复刻是否在替换后重放没写——不重放，一次刷新就洗掉用户覆盖. 明写「发现输出再过一遍 L2/L3 合成」.
> §5.2 vs §11+§13: 🟡 内置 catalog 条目直写 api+baseUrl 与「默认协议不写 baseUrl」冲突——若 baking 保留到注册，§13「providers.scnet 的 baseUrl 继续生效」是空话（折叠只对无 baseUrl 的模型生效）. 写明 catalog 只是存储形态、加载时统一过 §5.2 改写.
> §3.3 vs §6: 🟡 authHeader 默认 false，而 §6 对非 anthropic 端点发现一律 Bearer——注册侧默认不带 Authorization、发现侧默认带，同一端点两副面孔；示例 work 账号没写 authHeader，按 §3.3 语义发不出 Bearer. 按协议族给默认（openai 系 true），示例补齐.
> §9+§16(13) vs §3: 🟡 `export` 无任何使用场景，还是第二条默认写盘路径（§3 却说「唯一例外 sync --write」）. 砍掉，或写明场景并统一三处写盘口径.
> §12: 🟡 测试计划没碰 §6（吸收白名单/失败保留/memo 优先级）与 §8（override/别名/内置接管），错误 #17/#18 无测试. 补两组，否则证据链断在两块核心功能上.
>
> ### 🔵
>
> §10(6)(6b): 🔵 错误表残留 `apis.<n>` 数字键写法（wire 时代残留），正文全是 `apis.<api>`. 统一符号.
> §3.1: 🔵 自称「端点没有第三处写法」，下一条就允许模型条目写 `baseUrl`（第三处）. 删这句话.
> §3.3: 🔵 `envVar` ≡ `apiKey: "$VAR"`，一个语义两种写法、两套校验与文档. 二选一.
> §6: 🔵 「同 baseUrl 去重」应按 (baseUrl, modelsPath)，同址不同路径的探针会被吞. 改去重键.
> §3+§10: 🔵 「不产出半配置」过头——#6/#8/#10/#12/#13 全是条目级跳过. 收紧为「文件级 fail-closed」.
> §10: 🔵 字段类型错（headers 非对象、override 非布尔、default 非字符串）无错误条目，校验只覆盖 JSON 解析. 补类型校验行.
> §8+§3.1: 🔵 别名归一化的作用域没写全（apis 键、models[].api、6b 碰撞判定按归一后还是字面）. 一句定死「加载时全部归一」.
> §5.3: 🔵 「未显式声明 api」按基底条目还是合成后判定没写，直接影响 provider 级 compat 贴不贴. 定为合成后.
> §7+§4: 🔵 账号后缀 `(<name>)` 与协议后缀 `(协议)` 叠加时的顺序/格式没写. 一句话定死.
> §4: 🔵 「4 层」只是模型字段的链——compat（§5.3 自有三级）、headers（§3.1 自有三级）各有平行链，modelsPath 混进第 2 层但不参与合成. 注明各字段族各自成链，别拿 4 层当全局口径.
> 附: 🔵 「自有词汇只剩 4 个」漏了 `default` 指针与内置 `aliases`. 改计数口径.
> §2.2 vs §2.3: 🔵 「无鉴权方式即抛」与「无凭据不抛」并列而不点破分界（无配置 vs 有配置无值）. 加半句分界.
>
> ## 三、最站不住的 3 个设计决定
>
> 1. **accounts.json 多账号机制（§3.3/§7/决策 5–7）**：决策 7 作废了它的原始存在理由（跨线不同 key 各钉一线），又没给新理由——现在它只剩下「省一次目录复制」，却背着账号展开、显示名规则、账号级第 3 层、#10–#13 四条错误和一整组测试；若把边界改回纯计费，多账号是「同计费多凭据」，否则 accounts.json 应退化为单凭据文件、default 指针一并消失。
> 2. **commandcode 改名 + aliases（§8/决策 14）**：收益只有 id 贴合域名拼写，代价是别名机制、半生效语义（#18 专门替 alias 下的 modelOverrides 报丧）、外加与 §1 非目标正面冲突——不改名是零成本零机制，没人盯着 id 核对域名。
> 3. **`apis`（§3.1/决策 3）**：省的是手写 N 个 baseUrl，买的是「默认/非默认」二元性 + #6b + 有效默认协议 + 回落 + 后缀 + §5 整章规则——重复劳动本该由生成器/sync 消化（用户跑一次 sync 就拿到全展开的表），运行时规则量不该为手写省行数买单。
>
> ## 四、不确定、需要证据
>
> - `resolve-config-value.js` 是否解析裸大写变量名（决定 🔴 第一条是 bug 还是无害糖）。
> - `types.d.ts` compat 四族键数（26/9/11/32）与 google/vertex/mistral/pi-messages `compat: never` 的原文摘录。
> - `applyExtension` 重建后，config 侧 authHeader/headers/oauth 哪些仍会流入扩展注册的 provider（决定 §4 复刻清单边界、§8「oauth 报告+忽略」是砍用户功能还是无害）。
> - 全局 models.json 已声明的 provider 是否被 pi 独立注册（决定 §8③/#17 的触发面是否会扫到 providers.scnet 这类主用例）。
> - `registerProvider` 尾随的离线 refresh 降级行为、内存 memo 能否跨重注册存活（§2.5 坑的实测证据）。
> - authHeader 在 pi 的真实语义与各协议默认值（openai 系不写是否必 401）。
> - azure/codex/bedrock 的 baseUrl 拼接行为（§2.4 只实测了 anthropic 与 openai-responses）。
> - §2.3「无凭据不进快照」是否对全部 10 种 api 成立（还是只测了本机那一两种）。

## 第三轮：code → design 对表（codegraph，2026-09-18）

没有 `codegraph` 可执行文件（本机无此命令），改为手工建图：对 `extensions/custom-providers/{index,config,builtin,env,sources,catalog,types}.ts` + `scripts/refresh-catalog.mjs` + `tests/*` 做 import/符号/调用点表，再与设计逐点对表。共找到 13 个没写死或没注意的点，**其中 1 个是设计的判断题错**：

| # | 发现 | 实据 | 处置 |
|---|---|---|---|
| 1 | **「无凭据不注册」是错的** —— `/login` 候选只来自 `modelRuntime.getProviders()`（已注册者），不注册就拝死 stored 凭据 / `--api-key` / `/login` 这条正道 | `interactive-mode.js getLoginProviderOptions()`；`provider-composer.js:190-249`（无凭据时 pi 自造“输入 API key”login） | 设计改为「**无凭据也注册**（只报告 + 不进快照 + 提示 `/login`）」；§2.3/§3.3/§10 #27/§12；当前代码本来就总是注册（改回一致） |
| 2 | `.env` 来源没写：启动时 `loadEnvFile` 读 `~/.pi/agent/.env` + `~/.omp/agent/.env` 进 `process.env`（已存在的不覆盖） | `index.ts:543-544`、`env.ts` | §6.2 值解析/环境来源行补「环境来源」（也解释了 pi 请求时为何能解 `$VAR`） |
| 3 | `sync --write` 写什么没定义（基底？还是含用户第 3 层？） | 无代码对应（新功能） | §9 定死：写 **基底 ⊕ 发现**，不含 L3/L4；消失的 id 保留 + 报告 |
| 4 | `apis.<api>.modelsPath` 缺省行为 | `sources.ts` 每端点自带 `modelsPath` | §6.1 `modelsPath` 缺省行：继承 `provider.json.modelsPath`；两处都缺 → 该端点无发现（不猜 `/models`） |
| 5 | URL 拼接未规范（baseUrl 尾 `/` + modelsPath 前导 `/`） | `index.ts:173` 现有拼接 | §6.1 URL/头行写死规范化 |
| 6 | 空模型表（0 条）策略未定 | `applyExtension`：`models: []` 不抛，auth-only provider 可注册 | 归入 #1 的新规则（无凭据/空表都注册） |
| 7 | `refreshModels` 返回值 pi 会在 `publish` 前重校并抛 | `provider-composer.js:335-350`（publish update 里再跑 `applyExtension` 校验） | §6.4 新增「返回值自校验」行 + 错误 #26 |
| 8 | 命令输出必须裁剪（toast 放不下 100+ 行） | `index.ts:625-640`（drift 只取 8 行 + `(+N more)`） | §9 输出约束行 |
| 9 | 目录名撞 alias（`commandcode/` vs `codecommand/`）未定义 | `config.ts sourceConfigFor` 的 alias 读取 | 错误 #25：跳过 + 报告 |
| 10 | §13「唯一写盘 sync --write」与 §6 的 `publish({persist})` 措辞矛盾 | `index.ts:501`（确实 persist） | §6.4/§13 统一：我们的写盘只有 `sync --write`，`models-store.json` 是 **pi 自己**的缓存 |
| 11 | `authHeader: true` 的精确语义没写清（追加 `Authorization: Bearer`，且要求 key 可解析，否则请求期抛） | `provider-composer.js:162-168,198,238-254`；`model-registry.js:35-53` | §2.3 补精确语义 |
| 12 | drift 的 id 匹配规则（去命名空间/日期尾/分隔符 + 小写）未写 | `builtin.ts normalizeModelId` | §9 drift 行 |
| 13 | `publish({persist})` 的持久化形状（需补 `api`/`provider`/`baseUrl`）未写 | `index.ts toPersistableModels` | §6.4 写盘行 |
| 14 | 端点/vendor/账号 `headers` 怎么落到请求上未写（有串端点的风险） | `index.ts entryFor`（现在根本不管 headers）；`provider-composer.js:274-283,378-386` | §3.1 新增「headers 怎么落地」：逐条贴模型级，**不**放 provider 级；并校正 §3.3 的「最高一层」说法 |
| 15 | 内置目录读不到时 drift 的行为 | `builtin.ts available` 标志 | §9 drift 行：静默跳过 |
| 16 | `authHeader` 与账号 `headers` 的次序未明确 | `provider-composer.js:198,238-254` | §3.3 改为「最高一层厂商/端点头」，低于用户 `modelOverrides[M]`/`config.models[M]` 头 |

表内按主题分四组：**凭据与注册**（#1/#2/#11/#16）、**发现**（#3/#4/#5/#6/#7/#15）、**命令与写盘**（#8/#10/#13）、**配置与请求侧**（#9/#12/#14）。


⇒ 全部逐条落实（共 16 点，后三点是补记的边角）；无被否决项。§6 已按「探针 / 凭据 / 吸收 / 失败与持久化」四块重排，便于对照实现。仍然未决的只有用户的两个问题（实施 v4.0 / 第 0 步授权）。

## 第四轮：能力元数据权威（用户裁决，2026-09-18）

用户裁决：**能力元数据以官方 / pi 内置为准**。据此改了生成器（`scripts/refresh-catalog.mjs`）：

| 项 | 之前 | 现在 |
|---|---|---|
| `reasoning` / `input` 的来源序 | 能力页 embedded → 旧值（rendered 只用于报自相矛盾） | **pi 内置目录多数票 → 能力页 embedded → 旧值**（`normalizeModelId` 复用 `builtin.ts`，不重写；jiti 加 `@earendil-works/pi-ai` alias 才能 import `builtin.ts`） |
| 页面与内置不一致 | 页面说了算 | **内置说了算**，并把「页面 vs 内置」逐条报告 |
| 影响面 | — | 23 条（`reasoning` 22 条 false→true；`claude-sonnet-5` `input` text→image）；`maxTokens`/`contextWindow`/`cost`/`thinkingLevelMap` **不在此列**（仍代理权威、只报不改） |
| 实证 | — | 三条中转线 `/models` 全不发能力字段；能力页自相矛盾（sonnet-5 embedded vision=false / rendered true）；pi 内置对同一 id 跨 provider 一致（`claude-sonnet-5` 6 家全 `R+IMG`；`glm-5.1`/`minimax-m2.7`/`glm-5` 全 `R` 无图）⇒ 多数票可压掉孤立异议（如 `mimo-v2.5` 的 huggingface `R---` vs 官方 xiaomi `RIMG`） |
| 验证 | — | 写盘后 `--dry-run` 全 `+0 -0 ~0`（幂等）；`node tests/run-all.mjs` 6/6 |

新增**决策 18**（能力权威 + 与 `maxTokens`/`contextWindow` 的分界）；§6.3 加了一句澄清（实时 `/models` 不能改能力，静态能力由生成期定）；§9 `drift` 行说明「`reasoning`/`input` 还报差异 = catalog 过期」。

## 第四轮补充：`thinkingLevelMap`（用户追加裁决「按 pi 的来」）

裁决后先测量影响面，结果否掉了「机械按内置」：以「同 `api` 的内置条目多数票」为口径会命中 **75 行**，但其中
① 约 40 行的内置多数是「无映射」（套用 = 删掉我们的映射，而 pi 沉默不等于「无档位」）；
② 多数行只有**单一第三方托管点**一票（openrouter / vercel），与 `mimo-v2.5` 的孤立异议同类；
③ OpenAI 形线上同一 id 在 9 个托管点有 9 种映射（`off:"none"` / `minimal:null` / `high:null` …），effort 词表是**网关自定义**，照搬会发出端点不认的值。

能站住的唯一口径：**只取 anthropic 协议线的内置映射**（Anthropic adaptive-effort 档位 = 模型事实，官方 `anthropic` 条目在每次多数票里都在场）。

| 项 | 结论 |
|---|---|
| 落地范围 | 6 行：`claude-sonnet-5` → `{xhigh,max}`、`claude-sonnet-4-6` → `{max}`、`claude-fable-5`/`fable-5-1` → `{off:null,xhigh,max}`、`claude-opus-4-8`/`opus-4-7` → `{xhigh,max}` |
| 平票 | `claude-opus-5` 内置 4 种映射平票 → 保留我们的值 + 报告（不猜） |
| 其余 | 80 行保留自身映射（计数报告，不静默） |
| 实现 | 权威逻辑收进 `builtin.ts`（`capabilityAuthority` / `builtinLevelMap` / `votes` / `levelMaps`），生成器与运行期 `drift` **共用一份**，两边不可能再各说一套 |
| 验证 | 写盘后 `--dry-run` 三条线全 `+0 -0 ~0`；`summarizeDrift` 实测 codecommand/scnet/scnet-anthropic 的 `reasoning 0 / input 0`（只剩代理权威的 `maxTokens`/`contextWindow`）；`tests/run-all.mjs` 6/6 |

## 处置表

| 发现 | 判定 | 落在哪 |
|---|---|---|
| 🔴 裸大写 SNAKE 会被当 token 发 | **接受** | §2.4：裸 `UPPER_SNAKE` 一律规范化为 `$VAR` 再交 pi |
| 🔴 账号边界与「不同 key = 不同 provider」互斥 | **接受** | 决策 7 + §7 + §3.3：边界改为**产品/计费/端点集合**；同一产品多把 key = 多账号 |
| 🔴 非目标「不做别名」与 `aliases` 冲突 | **接受**（改措辞，保留机制） | §1：非目标改为「**pi 级** provider 别名」；`aliases` 明确定义为「读哪些 models.json 键」；决策 14 同步 |
| 🟡 `api`/`baseUrl` 必填 vs 错误表 #4/#5 | 接受 | §10 #4 收窄为「无 `baseUrl`」；#5 覆盖「`api` 缺失或不在表里」 |
| 🟡 §4 补丁语义 vs `baseUrl` 特例 | 接受（写明例外，不改成全局「高层胜」） | §4：`baseUrl` 遵循 pi 原义 `config.baseUrl ?? model.baseUrl`，其余字段无例外 |
| 🟡 「api 未声明→回落」会吞掉合法端点 | 接受 | §5.2：只要 `baseUrl` 可解析就放行，仅 `baseUrl` 无处可取才回落 |
| 🟡 第 3 层翻默认协议不带 baseUrl | 接受 | §4：取 `apis.<新协议>.baseUrl`，取不到 → 报告 + 拒绝 |
| 🟡 内置 vendor + 无 default 指针 | 接受 | §8 + §10 #11：内置回落内置基底账号（#11 只管目录 vendor） |
| 🟡 #17 误伤 `providers.scnet` 主用例 | 接受 | §8 ③ + §10 #17：只认 **pi 内置目录**的 id；全局 models.json 声明不算接管 |
| 🟡 发现用哪个账号的凭据未定 | 接受 | §6 新增行：base id 账号探一次，结果全账号共享；账号权限差异报告 |
| 🟡 发现凭据顺序与 §2.4 不一致 | 接受 | §6 凭据顺序行对齐 stored → 账号 → 第 3 层 → 内置 |
| 🟡 refreshModels 替换后未重放第 3 层 | 接受 | §4 新增「合成时点」：每次产出模型表都跑完整链 |
| 🟡 catalog 烘焙 api/baseUrl 与 §5.2 冲突 | 接受 | §11 生成器行：catalog 不烘焙 `api`/`baseUrl`，落端点加载时算 |
| 🟡 authHeader 默认与发现 Bearer 两副面孔 | 接受（部分：不改默认值，改文档） | §6：发现鉴权由协议定，与账号 `authHeader` 无关 |
| 🟡 `export` 无场景 + 写盘口径矛盾 | **接受（砍掉）** | §9/§15/决策 13：删 `export`，写盘只剩 `sync --write` |
| 🟡 测试没覆盖 §6/§8 | 接受 | §12 新增「发现与接管补测」行 + `pi-native-test` 加重放断言 |
| 🔵 错误表 `apis.<n>` 数字键 | 接受 | §10 全部改 `apis.<api>` |
| 🔵 §3.1「没有第三处写法」自指 | 接受 | 改为「模型条目/第 3 层仍可改 baseUrl，与 `apis` 不冲突」 |
| 🔵 `envVar` 双写法 | **接受（砍掉 `envVar`）** | §3.3/§10 #10/§7/决策 6 |
| 🔵 去重键应含 modelsPath | 接受 | §6：按 `(baseUrl, modelsPath)` 去重 |
| 🔵「不产出半配置」过头 | 接受 | §3 + 决策 11：文件级 fail-closed，条目级只跳条目 |
| 🔵 字段类型错无错误条目 | 接受 | §10 新增 #6c |
| 🔵 别名归一化作用域 | 接受 | §3.1：加载时对 `provider.json.api`/`apis` 键/`models[].api` 统一归一 |
| 🔵 §5.3「未显式声明 api」判定时机 | 接受 | §5.3：按**合成后**模型表判 |
| 🔵 两种后缀叠加顺序 | 接受 | §4：`Name (work) (anthropic-messages)` |
| 🔵「4 层」被当成全局口径 | 接受 | §4 末：4 层只管模型字段，headers/compat/modelsPath 各自成链 |
| 🔵「自有词汇 4 个」漏数 | 接受 | 附录：补 `default` 指针与 `aliases` 说明 |
| 🔵 §2.2/§2.3 分界 | 接受 | §2.2 末加半句：配置不全 vs 主动不注册 |
| 🔵 `apis` YAGNI（站不住的决定 3） | **部分拒绝** | 保留 `apis`：它同时承载**每端点 `modelsPath`**（发现必需，SCNet 是 `/v1/models`）；逐模型 `baseUrl` 只解决去重，解决不了探针路径 |
| 🟡 accounts.json 存在理由（站不住的决定 1） | **拒绝判死，改理由** | 见决策 7 与 §3.3「多账号的存在理由」：同产品多凭据，不再是「跨线不同 key」 |
| 🔵 commandcode 改名（站不住的决定 2） | **拒绝** | 项目已改名 `custom-providers`，provider id 对齐域名是既定决定（决策 14）；代价只是读旧键 + 一条报告 |

## 待验证 → 已全部实证（2026-09-18，读源码 + 实测）

| # | 问题 | 结论 | 实据 | 对设计的影响 |
|---|---|---|---|---|
| 1 | `resolve-config-value.js` 是否解析裸大写变量名 | **不解析**。`parseConfigValueTemplate` 里只有 `$…` 才生成 env part，其余进 literal ⇒ 裸 `UPPER_SNAKE` 会被当 token 发出 | `pi-coding-agent/dist/core/resolve-config-value.js:17,46-80,96` | 确认 🔴1 是**真 bug 而非无害糖**；§2.4 保留「规范化到 `$VAR`」为硬要求 |
| 2 | 能否直接 import pi 的解析器（省一份自实现） | **不能**。`package.json` 的 `exports` 只有 `.` / `./rpc-entry` / `./client` / `./experimental/plugin`；裸深路径实测 `ERR_PACKAGE_PATH_NOT_EXPORTED`；`resolveConfigValue`/`getConfigValueEnvVarNames`/`resolveHeaders` 均为内部导出 | 同上 + `package.json` exports | §6「自实现值解析」是唯一路，不是懒；“将来 pi 导出可换”记入 §2.4 |
| 3 | 全局 `models.json` 已声明的 provider 是否被 pi 独立注册 | **会**。`providerIds()` 包含 `config.getProviderIds()`；`recomposeProvider` 在 `base === undefined` 时仍组合；`applyModelsJson(…, [])` + `applyExtension(…, undefined)` 直接以 `config.models[]` 为表，每条 `modelFromJson` 取 `definition.api ?? config.api ?? defaults.api` 与同名 `baseUrl`。**且** `models[]` 缺 `api`/`baseUrl`、或 provider 块为空 → `registerProvider` 阶段抛 | `model-runtime.js:126-149`、`provider-composer.js:48-78,85-101,284-300` | §8③ 的「只认 pi 内置目录」保住了；新增错误 #22/#23（必须预校验，不能甩给 pi） |
| 4 | `applyExtension` 重建后 config 侧哪些字段仍流入 | 只剩 **`modelOverrides`（最顶层）/ `apiKey`（扩展胜、config 兵底）/ `headers`（request 时合并，`modelOverrides[M].headers` 与 `config.models[M].headers` 在最上）/ `authHeader`（`extension ?? config ?? false`）**；`baseUrl`/`api`/`name`/`compat`/`models[]`/条目级字段均被我们的整表取代；config 侧 `oauth` **不流入**（`oauth === "radius"` 走 `configureRadiusProviders()` 特例） | `provider-composer.js:171-176,258-283,291-312,378-401` | §4「复刻」与 §8 新增「接管后谁来做什么」精确表；新增错误 #24（config `oauth` 对我们的 provider 无效） |
| 5 | `azure-openai-responses` / `openai-codex-responses` / `bedrock-converse-stream` 的 baseUrl 拼接 | 见设计 §2.4 表（10 种全覆盖）。两处意外：① **azure 的 `model.baseUrl` 只是第三来源**，`options.azureBaseUrl` / `AZURE_OPENAI_BASE_URL` / `AZURE_OPENAI_RESOURCE_NAME` 均优先于它；Azure 主机路径会被**强制改写为 `/openai/v1`**（下游 SDK 再拼 `/deployments/…`）；② **bedrock 不是路径拼接**，`model.baseUrl` 就是显式 endpoint（`config.endpoint = model.baseUrl`） | `pi-ai/dist/api/*.js`（行号见设计 §2.4） | §2.4 由「两个例子」升级为逐协议表；发现侧只做 HTTP 类端点，azure/bedrock 归入「无发现」的理由更明确 |
| 6 | §2.3「无凭据不进快照」是否对全部 10 种 api 成立 | **成立且与协议无关**。`ModelRuntime.updateModelSnapshot()` 用 `snapshot.configuredProviders`（provider id 集合）过滤；该集合由 `runAvailabilityRefresh()` 逐 provider `checkAuth` / `configuredRequestAuthStatus()` 算出 | `model-runtime.js:171,187,229-252`、`provider-composer.js:388-401` | §2.3 三条后果不需按协议限定，文字改为实证 |
| 7 | compat 四族键数与「其余四类 `never`」 | `openai-completions` **26**（`:468-532`）/ `openai-responses` **9**（`:534-553`，覆盖 azure + codex）/ `anthropic-messages` **11**（`:555-617`）/ `bedrock-converse-stream` **1**（`:619-622`，仅 `supportsStrictMode`）；条件类型 `:736` 对 google-generative-ai / google-vertex / mistral-conversations / pi-messages 给出 `never` | `pi-ai/dist/types.d.ts` | **修正设计原写「bedrock 32 键」为 1 键**；其余不变 |

⇒ 本轮之前列的 6 条「待实证」全部清零；新增 2 条实证发现（#2 解析器不可 import、#3 config-only provider 会被 pi 自己注册）与 1 条数字修正（BedrockCompat 1 键）已回填设计。
