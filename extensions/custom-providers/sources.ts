/**
 * The built-in vendor table — the single source of truth for base URLs, protocols and API
 * key variables. `scripts/refresh-catalog.mjs` imports this file, so a URL can no longer
 * drift between what the extension registers and what the generator probes.
 *
 * One entry = one *vendor*: one pi provider id, one default endpoint (`api` + `baseUrl`)
 * and any additional protocol endpoints under `apis` (key = pi's api id). The vocabulary is
 * pi's own; the only additions are `apis` (pi has no word for "second protocol endpoint")
 * and `modelsPath` (pi has no discovery-path concept).
 *
 * A vendor is a *product/billing* boundary, not a protocol one. SCNet's OpenAI and
 * Anthropic endpoints serve the same 18 ids out of 19 (only `MiniMax-M2.5` is OpenAI-only)
 * and share one API key, so they are one provider whose models each name their protocol —
 * pi allows per-model `api`/`baseUrl` (`ModelDefinitionSchema`) and one provider id holds a
 * given model id only once (`model.id` is the `model` value sent to the gateway), so a
 * per-request protocol switch is impossible in either shape. A *different product* with its
 * own billing (pi's own `opencode` vs `opencode-go`) would be a second entry here.
 */
import type { Account } from "./types.ts";
import type { ProviderDeclaration } from "./config.ts";

export interface BuiltinVendor {
	/** The pi provider id. */
	id: string;
	name: string;
	/** Other `models.json` provider keys that configure this vendor (its own id first). */
	aliases: readonly string[];
	declaration: ProviderDeclaration;
	/** Used when no `accounts.json` covers this vendor (and as the `/login` fallback). */
	builtinAccount: Account & { envVar: string };
}

export const SOURCES: readonly BuiltinVendor[] = [
	{
		// id = the domain, not the product nickname: `ai` in the old id was ours, and the
		// `commandcode` spelling keeps reading the existing `providers.codecommand` block.
		id: "commandcode",
		name: "Command Code (GOAT)",
		aliases: ["codecommand", "codegoat"],
		declaration: {
			/**
			 * The two protocols live under different roots here: the OpenAI endpoint under
			 * `/provider/v1` (so `/chat/completions` and `/models` resolve), the Anthropic one
			 * under `/provider`, with the SDK adding `/v1` itself. Measured 2026-09-18: the
			 * Anthropic route answers 403 MODEL_NOT_IN_PLAN (route exists) while
			 * `/provider/v1/v1/messages` answers 404.
			 */
			api: "openai-completions",
			baseUrl: "https://api.commandcode.ai/provider/v1",
			modelsPath: "/models",
			apis: {
				"anthropic-messages": {
					baseUrl: "https://api.commandcode.ai/provider",
					modelsPath: "/v1/models",
				},
			},
		},
		builtinAccount: { id: "commandcode", envVar: "CMD_API_KEY", authHeader: true },
	},
	{
		id: "scnet",
		name: "SCNet",
		aliases: ["scnet"],
		declaration: {
			api: "openai-completions",
			baseUrl: "https://api.scnet.cn/api/llm/v1",
			// The OpenAI endpoint's own list path; the Anthropic one is under a different root.
			modelsPath: "/models",
			apis: {
				"anthropic-messages": {
					baseUrl: "https://api.scnet.cn/api/llm/anthropic",
					modelsPath: "/v1/models",
				},
			},
		},
		builtinAccount: { id: "scnet", envVar: "SCNET_API_KEY", authHeader: true },
	},
];
