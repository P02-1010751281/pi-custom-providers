import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadTs, PI, assert } from "./harness.mjs";

/**
 * Catalog invariants.
 *
 * Regression guard: pi's `calculateCost()` dereferences `model.cost.tiers`
 * unconditionally, so any registered model without `cost` crashes the turn with
 * `Cannot read properties of undefined (reading 'tiers')`.
 */
const { CATALOG } = await loadTs("extensions/custom-providers/catalog.ts");
const api = await loadTs("extensions/custom-providers/index.ts");
const { calculateCost } = await import(`${PI}/node_modules/@earendil-works/pi-ai/dist/index.js`);

const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];
let total = 0;

for (const [source, models] of Object.entries(CATALOG)) {
	const ids = new Set();
	for (const model of models) {
		assert(typeof model.id === "string" && model.id.length > 0, `${source}: id`);
		assert(!ids.has(model.id), `${source}: duplicate id ${model.id}`);
		ids.add(model.id);
		assert(typeof model.name === "string" && model.name.length > 0, `${source}/${model.id}: name`);
		assert(typeof model.reasoning === "boolean", `${source}/${model.id}: reasoning`);
		assert(Array.isArray(model.input) && model.input.length > 0, `${source}/${model.id}: input`);
		assert(Number.isInteger(model.contextWindow) && model.contextWindow > 0, `${source}/${model.id}: contextWindow`);
		assert(Number.isInteger(model.maxTokens) && model.maxTokens > 0, `${source}/${model.id}: maxTokens`);
		assert(model.maxTokens < model.contextWindow, `${source}/${model.id}: maxTokens < contextWindow (${model.maxTokens} vs ${model.contextWindow})`);
		for (const field of COST_FIELDS) {
			assert(typeof model.cost?.[field] === "number", `${source}/${model.id}: cost.${field} is a number`);
		}
		if (!model.reasoning) assert(model.thinkingLevelMap === undefined, `${source}/${model.id}: no thinkingLevelMap without reasoning`);

		// The exact pi code path that used to throw.
		const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const priced = calculateCost(model, usage);
		assert(typeof priced.total === "number" && !Number.isNaN(priced.total), `${source}/${model.id}: calculateCost total`);
		total += 1;
	}
	console.log(`${source}: ${models.length} models`);
}

// models.json override wins, cost survives.
const stub = { id: "scnet", aliases: [], api: "openai-completions" };
const overridden = api.mergeCatalogModels(stub, { models: [{ id: "Kimi-K3", maxTokens: 4096, contextWindow: 131072 }] });
const kimi = overridden.find((model) => model.id === "Kimi-K3");
assert(kimi.maxTokens === 4096 && kimi.contextWindow === 131072, "models.json override applied");
assert(typeof kimi.cost?.input === "number", "override keeps cost");
assert(api.mergeCatalogModels(stub, { models: [{ id: "user-added", maxTokens: 100, contextWindow: 200 }] }).some((m) => m.id === "user-added"), "user-added id appended");
assert(JSON.stringify(api.mergeCatalogModels(stub, { models: [{ id: "junk-input", input: ["text", "audio", 7] }] }).find((m) => m.id === "junk-input").input) === '["text"]', "unknown input modalities are dropped, not passed to pi");

// Catalog objects are never handed out by reference.
const first = api.mergeCatalogModels(stub, {})[0];
first.input.push("image");
first.cost.input = 999;
const second = api.mergeCatalogModels(stub, {})[0];
assert(!second.input.includes("image") && second.cost.input === 0, "returned models are copies, not references into CATALOG");

// Live rows refresh context/name and never invent params for unknown ids.
const applied = api.applyLiveModels(api.mergeCatalogModels(stub, {}), [
	{ id: "Kimi-K3", name: "Kimi K3 (live)", context_length: 777777 },
	{ id: "brand-new-model", context_length: 500000 },
], stub);
const liveKimi = applied.models.find((model) => model.id === "Kimi-K3");
assert(liveKimi.contextWindow === 777777 && liveKimi.name === "Kimi K3 (live)", "live refresh updates known model");
const fresh = applied.models.find((model) => model.id === "brand-new-model");
assert(fresh && fresh.cost && fresh.contextWindow === 500000, "unknown live id added with cost");
assert(applied.unknown.includes("brand-new-model"), "unknown live id reported");

console.log(`validated ${total} catalog models`);

// --- models.json layer: missing file, malformed file, sibling inheritance -------
const cfg = await loadTs("extensions/custom-providers/config.ts");
const { SOURCES } = await loadTs("extensions/custom-providers/sources.ts");
const { getAgentDir } = await import(`${PI}/dist/index.js`);
const modelsJson = path.join(getAgentDir(), "models.json");

assert(cfg.readModelsConfig().issue === undefined, "a missing models.json is not an issue (all settings can come from the environment)");
writeFileSync(modelsJson, "{ not json");
assert(typeof cfg.readModelsConfig().issue === "string", "malformed models.json is reported");
writeFileSync(modelsJson, JSON.stringify({ providers: { "scnet-anthropic": { apiKey: "ANTHROPIC_KEY" } } }));
assert(JSON.stringify(cfg.readModelsConfig().config) === JSON.stringify({ providers: { "scnet-anthropic": { apiKey: "ANTHROPIC_KEY" } } }), "valid models.json parses");

writeFileSync(modelsJson, JSON.stringify({
	providers: {
		scnet: {
			apiKey: "SCNET_API_KEY",
			authHeader: true,
			baseUrl: "https://wrong.example/v1",
			api: "anthropic-messages",
			compat: { requiresReasoningContentOnAssistantMessages: true, supportsStore: false },
			models: [
				{ id: "test-only-model", maxTokens: 4096, contextWindow: 65536, baseUrl: "https://user.example/v1", compat: { supportsStore: true, requiresThinkingAsText: true } },
				{ id: "wire-only-model", maxTokens: 2048, contextWindow: 32768 },
			],
			// One provider id holds a given model id only once, so the wire is chosen per model.
			wire: { models: { "wire-only-model": "anthropic" } },
		},
		"scnet-anthropic": { apiKey: "ANTHROPIC_KEY" },
	},
}));
const { config, issue } = cfg.readModelsConfig();
assert(issue === undefined, "valid models.json parses without an issue");

const anthropicSource = SOURCES.find((source) => source.id === "scnet-anthropic");
const inherited = cfg.sourceConfigFor(anthropicSource, config);
assert(inherited.apiKey === "ANTHROPIC_KEY", "the wire's own models.json entry wins over its sibling's");
assert(inherited.authHeader === true, "sibling credentials settings are inherited");
assert(inherited.compat === undefined, "wire-specific compat is NOT inherited from the sibling wire");
assert(inherited.models === undefined, "the sibling's model list is NOT inherited (OpenAI-only ids would fail on the Anthropic wire)");
assert(inherited.baseUrl === undefined && inherited.api === undefined, "the sibling's endpoint and wire are NOT inherited");

// --- compat reaches the models pi actually composes ----------------------------
const providers = new Map();
await api.default({
	on: () => {},
	registerCommand: () => {},
	registerProvider: (id, providerConfig) => providers.set(id, providerConfig),
	registerFlag: () => {},
	registerShortcut: () => {},
	registerTool: () => {},
	getFlag: () => undefined,
});
const scnet = providers.get("scnet");
assert(
	scnet.models.filter((model) => model.api !== "anthropic-messages").every((model) => model.compat?.requiresReasoningContentOnAssistantMessages === true),
	"provider-level compat lands on every model of that wire (pi drops it at the provider level)",
);
assert(!("compat" in scnet), "no provider-level compat is passed to pi");
const synthetic = scnet.models.find((model) => model.id === "test-only-model");
assert(synthetic?.maxTokens === 4096, "models.json model entries override the catalog");
assert(synthetic.baseUrl === "https://user.example/v1", "a models.json per-model baseUrl is carried through (it would otherwise be dropped, and the wire rule would overwrite the user's choice)");
assert(synthetic.compat?.requiresThinkingAsText === true, "a model-level compat is kept");
assert(synthetic.compat?.supportsStore === false, "the provider-level compat wins over the model-level one, as in pi");
assert(providers.get("scnet").models.length === CATALOG.scnet.length + 2, "the merged provider holds the union of both wires plus the models.json-only ids");
const wired = scnet.models.find((model) => model.id === "wire-only-model");
assert(wired?.api === "anthropic-messages", "a per-model `wire` moves that model to the Anthropic wire");
assert(wired.baseUrl === anthropicSource.baseUrl, `the chosen wire's own base URL is stamped on the model (got ${wired?.baseUrl})`);
assert(wired.name.endsWith("(Anthropic)"), `a merged provider labels the wire in the display name (got ${wired?.name})`);
assert(wired.compat?.requiresReasoningContentOnAssistantMessages === undefined, "a wire's provider-level compat does not follow a model onto the sibling wire");
assert(scnet.models.every((model) => model.id === "wire-only-model" || model.api !== "anthropic-messages"), "only the selected model moves: the wire is per model, not provider-wide");
assert(!providers.has("scnet-anthropic"), "the sibling wire is not a second provider entry");
assert(providers.get("codecommand").models.length === CATALOG.codecommand.length, "a models.json entry for one provider does not affect the others");

console.log("OK");
