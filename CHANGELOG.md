# 更新日志

版本规则见 `.codestable/attention.md`：新增 feature 与破坏性变更升 MINOR（0.x 阶段），fix / 文档 / chore 升 PATCH。每个版本对应一个 annotated tag，tag 说明与本文同源。安装/升级：`pi install ssh://forgejo@git.lentech.site/C02-1010751281/pi-custom-providers.git@vX.Y.Z`。

## v0.4.0 — 2026-10-01

**破坏性：仓库不再出厂任何模型表。**

### 破坏性

- **去掉出厂模型表**（`b5d8e4c`）：`extensions/custom-providers/` 里不再带 vendor 的模型目录。provider 的模型基底表 = 你自己的 `~/.pi/agent/custom-providers/<id>/models.json`；目录里只有 `provider.json` 时该 provider 注册 **0 个模型**，等实时发现（`/refresh-custom-models`、`sync --write`）或你补表。升级见 README「从 v0.3.0 升级」。

### 修复

- **发现探针的凭据与请求头现在与 pi 完全一致**（`feef5a5`）：以前探针在 `live.ts` 里自己按协议挑凭据、自己定 auth 形态，而 pi 是按 provider 的 `authHeader` 决定是否追加 `Authorization: Bearer` —— 两者会分岔（anthropic 线少发 Bearer）。现在选择归 `credentials.ts`（`registrationCredential` / `discoveryCredential`）：探针发的头 = 协议默认（`anthropic-messages` → `x-api-key` + `anthropic-version`，其余 → `Bearer`）∪（`authHeader` 为真时补 `Bearer`），等同 pi 的 `withConfiguredAuth`。`credential-test` 守：bearer 规则对着 pi 的 `composeModelProvider` 断言、协议默认头对着 Anthropic SDK 的真请求头断言；Command Code 线上实测两种头都 200、同一批 86 个模型。
- **模型字段全量往返**（`4c5ef7d`）：`samplingParams` / `inputLimits` / `promptCache` / `cost.tiers` 以前能被 `models.json` 接受却静默丢掉，现在读写完整往返。
- **`!command` 用 pi 的 shell**（`06aa386`）：Windows 上 pi 用 Git Bash，扩展以前用平台默认 shell，会误报「无 API key」。现在直接用 pi 的 `getShellConfig()`，时间预算也一致。
- **`provider.json` 里写 `models` / `modelOverrides` 会点名去哪**（`11631a6`）：以前只是一句通用 unknown key 提示；现在说明它属于本目录的 `models.json`（模型表只有这一个家，pi 全局 `models.json` 的第 3/4 层是补丁层）。
- **`accounts.json` 的键就是凭据那份清单**（`2dd7127`）、**用 pi 自己的 reader 读 pi 全局 `models.json`**（`8de3205`）、**同一个问题只报一遍**（`ae7478a`）、**账号与 provider 撞 id 跳过并报告**（`52d2a05`）、**协议翻转时 layer 的 baseUrl 也算真实端点**（`24b9be3` `c069d48`）。

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
