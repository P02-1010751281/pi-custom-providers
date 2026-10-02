# Command Code 中转站：上游路由与能力探测记录

日期：2026-10-01 · 对象：`commandcode` / `commandcode-c02-1010751281` 两个 provider 的 85 个模型
动机：该网关的 `/models` 只返回 `id`/`object`/`created`/`owned_by`/`name`/`context_length`/`supported_endpoints`，**零上游信息、零能力信息**（0/85 行有 thinking/effort/modality 字段），所以「这个模型是谁在服务、支持什么」只能主动探测。

## 0. 结论速览

| 通道 | 判定强度 | 服务这些模型（本表实测） |
|---|---|---|
| **OpenRouter** | 直证（响应+文档+公开 API） | `stealth/space-bunny-alpha`（上游供应商 **Stealth**）、`google/gemini-3.7-flash`、`inclusionai/ling-3.0-flash-sante:free`、`MiniMaxAI/MiniMax-M2.7`、`thinkingmachines/inkling`、`thinkingmachines/inkling-small` |
| **Vercel AI Gateway** | 强指纹推断 | `gen_` 成功：`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-luna`、`xai/grok-4.5/4.6/4.7`、`Qwen/Qwen3.8-27B`、`moonshotai/Kimi-K2.6`、`Kimi-K2.7-Code-Highspeed`、`stepfun/Step-3.7-Flash`、`stepfun/Step-5-Preview`、`zai-org/GLM-5.2-Fast`；同签名：`deepseek/deepseek-v4.1-flash-fast`、`deepseek/deepseek-v4-pro`、`deepseek/deepseek-v4-flash-vision-exp` |
| **Novita AI** | 直证（URL 泄漏 + 官方文档） | `deepseek/deepseek-v4.1-flash`、`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-flash-fast`、`moonshotai/Kimi-K3`、`zai-org/GLM-5.3`、`z-ai/glm-5.3-flash`、`inclusionai/ling-3.1-flash:free`、`tencent/hy3-paid` |
| **阿里 DashScope / 百炼** | 强指纹 | `Qwen/Qwen3.6-Plus`、`Qwen/Qwen3.6-Max-Preview`、`3.7-Flash/Max/Plus`、`3.8-Flash/Max/Max-0902/Omni-Flash`、`moonshotai/Kimi-K2.7-Code`、`zai-org/GLM-5.2` |
| **Anthropic 原生** | 直证（id 形状 + usage 形状） | `claude-*`（只走 `/messages`；其中多数被计划门挡住） |
| **Gemini 原生** | 直证（报错文案） | `google/gemini-3.8-flash` |
| 未定名签名 | — | `xiaomi/mimo-*`（"Param Incorrect"）、`nvidia/nemotron-3-ultra-550b-a55b`/`poolside/laguna-s-2.1-free`/`stepfun/Step-3.5-Flash`/`zai-org/GLM-5.1`（"Input should be less than or equal to …"）、`MiniMaxAI/MiniMax-M2.5`/`moonshotai/Kimi-K2.5`/`zai-org/GLM-5`（"exceeds the model limit of …"）、`MiniMaxAI/MiniMax-M3`（"…does not support max tokens > 524288 (2013)"）、`meituan/LongCat-2.0`（中文"参数校验失败"）、`tencent/hy4-preview`（成功，id 为带横线 UUID） |

## 1. 探测方法与坑

```bash
K=$(printenv CMD_API_KEY)

# (a) 目录：上游自报的资源清单（信息很少）
curl -s https://api.commandcode.ai/provider/v1/models -H "Authorization: Bearer $K"

# (b) 超限探针：故意要 1 亿输出 token，让上游/网关把「真实上限」写进错误文案
curl -s -X POST https://api.commandcode.ai/provider/v1/chat/completions \
  -H "Authorization: Bearer $K" -H "Content-Type: application/json" \
  -d '{"model":"<id>","max_tokens":99999999,"messages":[{"role":"user","content":"hi"}]}'

# (c) Anthropic 线（claude-* 只在此线可用）
curl -s -X POST https://api.commandcode.ai/provider/v1/messages \
  -H "x-api-key: $K" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5-5","max_tokens":99999999,"messages":[{"role":"user","content":"hi"}]}'

# (d) 能力探针：必须用「真图」，不能用 1×1 占位图（见第 6 节）
```

坑：
- **Cloudflare 拦非 curl UA**：python-urllib 直接 `403 error code: 1010`，所有请求必须走 curl。
- `/provider/v1/models/<id>` 是 404，没有单模型元数据端点。
- 上游主机名只在个别错误的**内层字符串化 JSON**里出现（`error.message` 里再嵌一层 `{"...","param":{"url":"https://api.novita.ai/..."}}`），要递归/正则挖，别只看外层。
- 超限探针**不会**真的生成 token（除 Vercel 通道会静默夹取），代价约等于一次 400。

## 2. 五条通道的指纹（这是判定品牌的核心依据）

| 通道 | 响应 id 形状 | usage 指纹 | 错误信封 / 校验行为 |
|---|---|---|---|
| OpenRouter | `gen-<unix>-<rand>` | `prompt_tokens_details{cached_tokens, cache_write_tokens, audio_tokens, video_tokens}` | `"This endpoint's maximum context length is … use the context-compression plugin"`；`"No available providers match the 'only' filter: …, Available providers are: …"`；响应体带 `provider`、`native_finish_reason` |
| Vercel AI Gateway | `gen_<ULID>` | `prompt_tokens_details{audio_tokens, cached_tokens, video_tokens}` + 顶层 `cache_creation_input_tokens` | **网关自己**拦参数：`"Too big: expected number to be <=2"`（temperature），`"Invalid max_tokens value, the valid range of max_tokens is [1, N]"`；超限 `max_tokens` 时**不报错而是夹取** |
| Novita AI | 32 位 hex（`hex32`） | 全套字段（含 `cache_write_tokens`、`image_tokens`、`cache_read_input_tokens`）⇒ 与 OpenRouter 那一栏重叠，**不可作判据** | `{"code":400,"reason":"INVALID_REQUEST_BODY","message":"max_tokens (current value: N) must be between 0 and M ","metadata":{}}`（**M 后有尾空格**）；`"model features vision not support"` |
| 阿里 DashScope | `chatcmpl-<uuid>` + `request_id` | 标准 OpenAI 形状 | `{"error":{"message":"<400> InternalError.Algo.InvalidParameter: Temperature should be in [0.0, 2.0)","code":"invalid_parameter_error"}}` |
| Anthropic 原生 | `msg_01…` | `input_tokens/output_tokens/cache_creation_input_tokens/cache_read_input_tokens` | Anthropic 标准错误；`max_tokens` 超限文案给出该模型自身上限 |

**判据说明（2026-10-01 补充）**：只有 **id 形状**与**错误信封**是可靠判据；`usage` 指纹**不作判据**——反例：Novita 通道的 `deepseek/deepseek-v4.1-flash` 的 `prompt_tokens_details` 同时含 `cache_write_tokens`（原以为 OpenRouter 专属）与 `image_tokens/text_tokens/cache_read_input_tokens`，是各家字段的并集；`Vercel` 通道也不是每个响应都带 `system_fingerprint`。

品牌判定所依据的**外部**证据：
- **OpenRouter**：`GET https://openrouter.ai/api/v1/models` 是公开目录，`stealth/space-bunny-alpha` 在列（模态 `[text,image,video]`，ctx 1000000）；`GET https://openrouter.ai/api/v1/models/stealth/space-bunny-alpha/endpoints` 直供 `provider_name: "Stealth"`。运行期响应也带 `provider:"Stealth"`。
- **Novita**：`https://docs.novita.ai/guides/llm-api` 的官方示例即 `base_url="https://api.novita.ai/openai"`、`model="deepseek/deepseek-v4.1-flash"`；`https://docs.novita.ai/api-reference/basic-error-code` 的错误名表里有 `INVALID_REQUEST_BODY`；`tencent/hy3-paid` 的错误体直接漏出 `url: https://api.novita.ai/...`。
- **Vercel**：`https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway` 写明 AI Gateway 的 generation id 格式是 **`gen_`**（`getGenerationInfo(id)`）；本网关同通道模型的 id 正是 `gen_<ULID>`，且错误类名为 Vercel AI SDK 的 `AI_APICallError`。
- **OpenAI 原厂文案**：`"You have uploaded an unsupported image. Please make sure your image is valid and has one of the following formats: webp, png, jpeg, and gif."` 见 community.openai.com 与 Portkey 错误库 —— 是「图无效」而非「模型不支持图」。

## 3. 逐模型分桶（按错误/成功签名，85/85 全覆盖）

- **计划外 `MODEL_NOT_IN_PLAN`（23）**：`claude-sonnet-5`、`claude-sonnet-4-6`、`claude-fable-5`、`claude-fable-5-1`、`claude-haiku-4-5-20251001`、`claude-opus-5`、`claude-opus-5-5`、`claude-opus-4-8`、`claude-opus-4-7`、`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-sol`、`gpt-5.6-terra`、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、`gpt-5.3-codex`、`google/gemini-3.6-flash`、`google/gemini-3.5-flash`、`google/gemini-3.5-flash-lite`、`google/gemini-3.1-flash-lite`、`sakana/fugu-ultra`、`meta/muse-spark-1.1`
  （403 `permission_error`，与上游无关，是当前 API key 的套餐不含这些模型）
- **Vercel 通道（15）**：`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-luna`、`xai/grok-4.5`、`xai/grok-4.6`、`xai/grok-4.7`、`Qwen/Qwen3.8-27B`、`moonshotai/Kimi-K2.6`、`moonshotai/Kimi-K2.7-Code-Highspeed`、`stepfun/Step-3.7-Flash`、`stepfun/Step-5-Preview`、`zai-org/GLM-5.2-Fast`、`deepseek/deepseek-v4.1-flash-fast`、`deepseek/deepseek-v4-pro`、`deepseek/deepseek-v4-flash-vision-exp`
- **Novita（8）**：`deepseek/deepseek-v4.1-flash`、`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-flash-fast`、`moonshotai/Kimi-K3`、`zai-org/GLM-5.3`、`z-ai/glm-5.3-flash`、`inclusionai/ling-3.1-flash:free`、`tencent/hy3-paid`
- **OpenRouter（6）**：`stealth/space-bunny-alpha`、`google/gemini-3.7-flash`、`inclusionai/ling-3.0-flash-sante:free`、`MiniMaxAI/MiniMax-M2.7`（候选池 gmicloud/minimax/novita）、`thinkingmachines/inkling`（deepinfra/modal/thinkingmachines/togetherai）、`thinkingmachines/inkling-small`（deepinfra/thinkingmachines）
- **DashScope（11）**：`Qwen/Qwen3.6-Plus`、`Qwen/Qwen3.6-Max-Preview`、`Qwen/Qwen3.7-Flash`、`Qwen/Qwen3.7-Max`、`Qwen/Qwen3.7-Plus`、`Qwen/Qwen3.8-Flash`、`Qwen/Qwen3.8-Max`、`Qwen/Qwen3.8-Max-0902`、`Qwen/Qwen3.8-Omni-Flash`、`moonshotai/Kimi-K2.7-Code`、`zai-org/GLM-5.2`
- **Anthropic 原生（1 可验）**：`claude-sonnet-5-5`
- **Gemini 原生（1）**：`google/gemini-3.8-flash`
- **未定名签名（17）**：`xiaomi/mimo-v2.5`、`mimo-v2.5-pro`、`mimo-v2.6-flash`、`mimo-v2.6-pro`、`mimo-v2.6-pro-ultraspeed`（"Param Incorrect"）；`nvidia/nemotron-3-ultra-550b-a55b`、`poolside/laguna-s-2.1-free`、`stepfun/Step-3.5-Flash`、`zai-org/GLM-5.1`（"Input should be less than or equal to 10000000"）；`MiniMaxAI/MiniMax-M2.5`、`moonshotai/Kimi-K2.5`、`zai-org/GLM-5`（"exceeds the model limit of N"）；`MiniMaxAI/MiniMax-M3`、`z-ai/glm-5.3-flashx`、`meituan/LongCat-2.0`、`meta/muse-spark-1.3-contributor`、`tencent/hy4-preview`
- **网关级"上游暂时不可用"（3）**：`meta/muse-spark-1.2`、`meta/muse-spark-1.2-contributor`、`meta/muse-spark-1.3`

## 4. 输出上限实测（超限探针）

| 模型 | 上游自报上限 | 表内 `maxTokens` | 判定 |
|---|---|---|---|
| `claude-sonnet-5-5` | 128000 | 128000 | ✓ 正好 |
| `deepseek/deepseek-v4.1-flash` | 393216 | 384000 | ✓ |
| `deepseek/deepseek-v4-pro` | 393216 | 384000 | ✓ |
| `deepseek/deepseek-v4.1-flash-fast` | 393216 | 384000 | ✓ |
| `zai-org/GLM-5.3` | 131072 | 131072 | ✓ 正好 |
| `Qwen/Qwen3.8-Max` | 131072 | 131072 | ✓ 正好 |
| `moonshotai/Kimi-K3` | 1048576 | 131072 | ✓ 保守 |
| `MiniMaxAI/MiniMax-M3` | 524288 | 128000 | ✓ 保守 |
| `moonshotai/Kimi-K2.5` | 262144 | 65536 | ✓ |
| `zai-org/GLM-5` | 202752 | 131072 | ✓ |
| `MiniMaxAI/MiniMax-M2.5` | 196608 | 131072 | ✓ |
| `google/gemini-3.8-flash` | 65537（开区间） | 65536 | ✓ 正好卡住 |
| `inclusionai/ling-3.1-flash:free` | **32768** | ~~65536~~ → **32768** | ✗→✓ **本次修正** |
| Vercel 通道（`gpt-6-luna` 等） | 无法测：超限被静默夹取，不报错 | — | — |

## 5. 能力（模态）实测

- `deepseek/deepseek-v4.1-flash-fast`：**收图**（PNG 与 JPEG 都能准确描述内容）—— 曾被 1×1 占位图误判为 text-only。
- `inclusionai/ling-3.1-flash:free`：**不收图**，`{"code":400,"reason":"INVALID_REQUEST_BODY","message":"model features vision not support"}` → 表内 `input:["text"]` 正确。
- `stealth/space-bunny-alpha`：**收图**（描述正确）；OpenRouter 目录标注模态 `[text,image,video]`，但 pi 的 `input` 只支持 text/image。
- 反例记录：**1×1 PNG 会被 OpenAI 系通道以"图片无效"拒收**，不能拿它当"不支持图"的证据。
- `deepseek/deepseek-v4-flash`（表里 `[text]`）：**收图**（准确答出「红色方形边框、蓝色圆形、黑色数字"7"」；同提示无图 →「未收到图片，无法判断」）⇒ 表里**少报**。
- `deepseek/deepseek-v4-flash-fast`（表 `[text]`，hex32/Novita 通道）：**该通道拿不到图**（「我无法看到您提到的图片」，无图同答）⇒ `[text]` 正确。
- `deepseek/deepseek-v4-pro`（表 `[text]`，`gen_`/Vercel 通道）：**该通道拿不到图**（「图片未成功加载」）⇒ `[text]` 正确。
- 旁证：pi 自带目录里 `deepseek-v4-flash` 在 opencode/openrouter/qwen/vercel 四处均为 `[text]`，`deepseek-v4.1-flash` 四处均为 `[text,image]` —— 上一条实测是对「v4 无视觉」的现场反例。

## 6. 与扩展代码的关系（为什么这不是扩展 bug）

用户最初的现象：`deepseek/deepseek-v4.1-flash-fast` 的思考档位只到 `high`，没有 `max`。三层原因，**都不在扩展逻辑错误**：

1. **pi 的档位是 opt-in**：`getSupportedThinkingLevels`（`pi-ai/dist/models.js`）里 `xhigh`/`max` 只有当 `thinkingLevelMap` 显式声明该键时才提供。
2. **该 id 不在用户表里**：上游 `/models` 有 85 条，用户手工表 76 条，9 条是运行时新发现的；`live.ts` 为新 id 生成的条目**不带** `thinkingLevelMap`。
3. **发现路径拿不到 map，也不该猜**：上游行**没有**任何 thinking/effort 字段（0/85），所以实时发现原理上无法得出档位；`convention.ts` 只在 `api === "anthropic-messages"` 时补 `{xhigh,max}`（第 70/104/109 行），OpenAI 形状的线上网网关各异，硬抄一份等于猜。
4. 附带：新发现 id 的 `maxTokens` 走 `FALLBACK_MAX_TOKENS = 16_384`（镜像 pi `provider-composer.js:98` 的 `?? 16384`），所以还伴随一个偏保守的输出上限。

⇒ 修法只能是**在用户表里手写**（本次已写 9 条），而不是改扩展：扩展能拿到的事实里确实没有这些信息。已验证写入后网关接受 `reasoning_effort: "max"`（`deepseek-v4.1-flash-fast`、`gpt-6-luna` 均 200）。

## 7. 局限

- 分桶覆盖 85/85，但**通道→品牌**只在第 2 节列的那几处有直证；`plan`/`success` 之外的桶是签名归纳。

- **Vercel AI Gateway 是强指纹推断**（`gen_` 格式 + 多厂商共用 + `AI_APICallError`），没有直接的 URL 泄漏作证；其余四个通道有直证或近直证。
- 上游主机名绝大多数情况下不泄漏（只有 `tencent/hy3-paid` 一次）；本记录的"通道→品牌"是从**签名**归纳，不是逐模型直证。
- Vercel 通道的超限 `max_tokens` 被静默夹取，故其上限无法用本法测定。
- 命令结果与套餐有关：`MODEL_NOT_IN_PLAN` 是当前 key 的状态，换 key/换套餐会变。
