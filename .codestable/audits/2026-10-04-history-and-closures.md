# 从 attention.md 搬出的历史叙事与闭合记录

> **归档**（2026-10-04，owner 指示）：历史叙事归 `CHANGELOG.md` 与 `audits/`，`attention.md` 只写当前事实。
> 这里是从 `attention.md` 原文搬出的段落，逐字保留以便查证；正文里对应位置已改为「当前规则」。
> 已发版条目的用户可见部分在 `CHANGELOG.md`（v0.5.0 起逐条对照）。

## F1–F12 闭合（2026-10-01，第二轮审计）

- **已闭合（2026-10-01，第二轮审计 F1–F12）**：① `samplingParams`/`inputLimits`/`promptCache`/`cost.tiers` 只被接受、不被读（现全部读写往返）；
  - ② `envVar` 被三处说成用户键却无处可写（v0.5.0 起只属 `accounts.json`；`envVar` 不再出现在任何合法位置）；
  - ③ `config.ts` 手抄第二份 JSON 读（现走 `util.readJson`，为此加了 `label`）；
  - ④ 同一问题报两遍（读侧改相对名 + `problemLines` 去重）；
  - ⑤ `!command` 用平台 shell，而 pi 在 Windows 用 Git Bash（现直接用 pi 的 `getShellConfig()`）；
  - ⑥ `publish` 桩（现可选）；
  - ⑦ `config.ts` 三合一（拆出 `apis.ts`，端点落法交还 `endpoints.ts`，类型交还 `types.ts`）；
  - ⑧ 模型字段表与值语法无 pin（现由 `pi-surface-test`/`env-test` 对着 pi 自己的 schema 与解析器断言）；
  - ⑨ **F12**：发现探针的凭据优先级写在 `live.ts`、auth 形态按协议自定，而 pi 按 provider 的 `authHeader` 定 → 两者可能分岔（现一并收进 `credentials.ts` 的 `discoveryCredential`，探针发 pi 会发的头：
    协议默认 + `authHeader` 补 `Authorization: Bearer`；`credential-test.mjs` 守；形态对着 pi 的 `composeModelProvider` 与 Anthropic SDK 的真请求头断言）；
  - ⑩ `provider.json` 里写 pi 的 `models`/`modelOverrides` 只得一句通用 unknown（现点名指向本目录的 `models.json`——模型表只有这一个家，pi 全局 `models.json` 的第 3/4 层是补丁层）。

## 更早的闭合与层序约束（2026-09-30）

- **已闭合（2026-09-30）**：`<id>/models.json` 曾被两个文件拥有（`provider-files.ts` 校验读、`sync-models.ts` 裸读/diff/写），`sync` 一条命令解析两次、两套规则。
  现在读写同处 `model-table.ts`（`d10b467` 合并、`f1bfcc0` 按载荷拆开），`runSync` 用本次命令重扫得到的 `vendor.models` 当磁盘基底表，一条命令只解析一次；`readBaseTable` 已删除。
- **层序约束（2026-09-30）**：模块只 import 同层或更低层，`graph-test` 守无环与可达（层表见「分层与接口」）。

## CodeStable v1 分发机制与空壳目录（2026-10-03 迁移时删除）

- v1 的分发机制（`reference/`、`gates/`、`runtime-manifest.json`）与只放 `.gitkeep` 的空壳目录（`roadmap/`/`features/`/`issues/`/`refactors/`/`goals/`/`compound/`/`brainstorms/`/`feedback/`/
  `requirements/`）**已删除**（含 547 行的 v1 泛化引擎设计，git 历史可查）；

## 已删机制：provider 级 models[] 的跨协议线合并

- **（已删机制，仅存档）** provider 级 `models[]` 里声明的模型曾必须并入该 provider 的**每一条**协议线（否则用户选了另一条线也挪不过去）。v0.5.0 起本包**不读**这个数组（模型只来自 `<id>/models.json`），这条规则随读取层一起消失。

## 从条目里摘出的零散历史句（同行其余事实保留在 attention）

- `tests/harness.mjs` 曾因未隔离而把 scnet 的 `compat` 覆盖进测试（69）。
- 测试曾出现「同一测试三次跑两样」（75）。
- `sync` 在 2026-09-30 合并前会把 models.json 解析两次、跑两套规则（189）。
- 已发版状态里的历史：上一版 v0.4.1 = 惯例继承不再看协议线（26）。
- semver 历史例外：`v0.2.4`（2026-09-22）的破坏性变更走 PATCH，早于规则生效日（22）。
- 「按线分 provider」在 v4.0 起不存在（271）。
- `config.ts` 的 `applyModelPatch()` 在 v0.5.0 前还在，已删（287）。
- `resolveApiKey` 旧实现变量未设置时会 `return value`，把变量名当密钥发出去（表现为莫名 401）（323）。
- 「缺凭据不会在注册时抛错」这一条修正的是早先的推断（314）。
- 本包曾把别名块当第 3 层读（漂移），v0.5.0 已删（404）；差分会看见注册 id 下合法 `models[]` 补丁从「被应用」变为「不生效」（388）。
- v0.5.0 删掉了「目录名撞出厂 `aliases`」那条守卫（出厂层已不存在，`aliases` 字段随之删除）（旧 §引擎行为）。
- `builtin.ts` 的 `capabilityAuthority`/`builtinLevelMap` 随模型目录生成器一起删除（旧 §引擎行为）。
- 迁移前 `session_start` 是唯一的自动刷新路径；`refreshModels` 钩子加入后两者共存（旧 §引擎行为）。
