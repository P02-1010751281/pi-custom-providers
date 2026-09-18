/**
 * The endpoint table — the single source of truth for base URLs, wires and API key
 * variables. `scripts/refresh-catalog.mjs` imports this file, so a URL can no longer
 * drift between what the extension registers and what the generator probes.
 *
 * One entry = one (endpoint x wire) pair. That is the unit the catalog, the live `/models`
 * refresh and the status report work in.
 *
 * It is not necessarily one pi provider: `providerId` groups the wires of one vendor under a
 * single provider id. SCNet's wires serve the same 18 ids out of 19 (only `MiniMax-M2.5` is
 * OpenAI-only) and one provider id can hold a given model id only once
 * (`getModels(provider).find((m) => m.id === id)`, `pi-ai/dist/models.js`, while `model.id`
 * *is* the `model` value sent to the gateway), so registering them separately put the same
 * vendor in the picker twice with no way to tell the entries apart. Both now register as
 * `scnet`: every model carries its own wire and the wire is picked per model in `models.json`
 * (`providers.scnet.wire`), with `scnet` itself the default wire and the endpoint source.
 * A per-request wire switch is impossible in either shape — `model.id` is sent as `model`.
 */
import type { Source } from "./types.ts";

export const SOURCES: readonly Source[] = [
	{
		id: "codecommand",
		name: "CodeCommand (GOAT)",
		aliases: ["codecommand", "codegoat"],
		/**
		 * The two wires live under different roots here: the OpenAI wire under
		 * `/provider/v1` (so `/chat/completions` and `/models` resolve), the Anthropic wire
		 * under `/provider`, with the SDK adding `/v1` itself. Measured 2026-09-18: the
		 * Anthropic route answers 403 MODEL_NOT_IN_PLAN (route exists) while
		 * `/provider/v1/v1/messages` answers 404.
		 */
		anthropicBaseUrl: "https://api.commandcode.ai/provider",
		baseUrl: "https://api.commandcode.ai/provider/v1",
		api: "openai-completions",
		envVar: "CMD_API_KEY",
		authHeader: true,
	},
	{
		id: "scnet",
		name: "SCNet",
		aliases: ["scnet", "scnet-openai"],
		baseUrl: "https://api.scnet.cn/api/llm/v1",
		api: "openai-completions",
		envVar: "SCNET_API_KEY",
		authHeader: true,
	},
	{
		// Same provider id as the OpenAI line above: one `scnet` entry in the picker, whose
		// models each carry the wire selected for them.
		id: "scnet-anthropic",
		providerId: "scnet",
		name: "SCNet (Anthropic)",
		aliases: ["scnet-anthropic"],
		baseUrl: "https://api.scnet.cn/api/llm/anthropic",
		modelsPath: "/v1/models",
		api: "anthropic-messages",
		envVar: "SCNET_API_KEY",
		authHeader: true,
		siblingId: "scnet",
	},
];
