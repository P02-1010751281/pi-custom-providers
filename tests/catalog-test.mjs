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

// The engines' patch semantics and api selection live in tests/apis-test.mjs; this file
// guards the raw catalog data and the two pure helpers pi's own model list depends on.
const cfg = await loadTs("extensions/custom-providers/config.ts");
const { getAgentDir } = await import(`${PI}/dist/index.js`);
const modelsJson = path.join(getAgentDir(), "models.json");

// --- applyLiveModels: discovery only ever adds ids/names/context windows --------
const base = [
	{ id: "Kimi-K3", name: "Kimi-K3", reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
];
const applied = api.applyLiveModels(base, [
	{ id: "Kimi-K3", name: "Kimi K3 (live)", context_length: 777777, supported_endpoints: ["/messages"] },
	{ id: "brand-new-model", context_length: 500000 },
]);
const liveKimi = applied.models.find((model) => model.id === "Kimi-K3");
assert(liveKimi.contextWindow === 777777 && liveKimi.name === "Kimi K3 (live)", "live refresh updates a known model's context window and display name");
assert(liveKimi.api === undefined, "discovery never infers a protocol (supported_endpoints is reported, not applied)");
const fresh = applied.models.find((model) => model.id === "brand-new-model");
assert(fresh && fresh.cost && typeof fresh.cost.input === "number" && fresh.contextWindow === 500000, "an unknown live id is added with cost");
assert(fresh.maxTokens === 16384, "an unknown live id gets a conservative maxTokens, never a guess from the registry");
assert(applied.unknown.join(",") === "brand-new-model", "an unknown live id is reported");
base[0].input.push("image");
assert(!applied.models.find((model) => model.id === "Kimi-K3").input.includes("image"), "applyLiveModels returns copies, not the caller's objects");

// --- models.json: absent vs broken ---------------------------------------------
assert(cfg.readModelsConfig().issue === undefined, "a missing models.json is not an issue (settings can come from the environment)");
writeFileSync(modelsJson, "{ not json");
assert(typeof cfg.readModelsConfig().issue === "string", "malformed models.json is reported");
writeFileSync(modelsJson, JSON.stringify({ providers: { scnet: { apiKey: "$SCNET_API_KEY" } } }));
const parsed = cfg.readModelsConfig();
assert(parsed.issue === undefined, "a valid models.json parses without an issue");
assert(cfg.providerLayerFor("scnet", [], parsed.config).apiKey === "$SCNET_API_KEY", "providerLayerFor reads the provider's block");
assert(cfg.providerLayerFor("commandcode", ["codecommand"], { providers: { codecommand: { authHeader: true } } }).authHeader === true, "providerLayerFor falls back to an alias key");
assert(JSON.stringify(cfg.applyModelPatch({ id: "m", contextWindow: 1000, cost: { input: 1 } }, { maxTokens: 5 }).contextWindow) === "1000", "a models.json entry patches fields instead of replacing the entry");

console.log(`validated ${total} catalog models`);
console.log("OK");
