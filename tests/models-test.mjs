import { writeFileSync } from "node:fs";
import path from "node:path";
import { FIXTURE_MODELS, loadTs, PI, assert, testModel } from "./harness.mjs";

/**
 * The one repo-side model table — `tests/fixtures/models.json`, seeded into vendor
 * directories by the harness — plus the pure helpers pi's own model list depends on.
 *
 * Regression guard: pi's `calculateCost()` dereferences `model.cost.tiers`
 * unconditionally, so any registered model without `cost` crashes the turn with
 * `Cannot read properties of undefined (reading 'tiers')`.
 */
const api = await loadTs("extensions/custom-providers/live.ts");
const { calculateCost } = await import(`${PI}/node_modules/@earendil-works/pi-ai/dist/index.js`);

const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];
let total = 0;

for (const [source, models] of Object.entries(FIXTURE_MODELS)) {
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
	console.log(`${source}: ${models.length} fixture models`);
}

// The engines' patch semantics and api selection live in tests/apis-test.mjs; this file
// guards the only repo-side model data and the pure helpers pi's own model list depends on.
assert(total > 0, "the fixture table must not be empty (an emptied fixture would pass vacuously)");
const cfg = await loadTs("extensions/custom-providers/config.ts");
const { getAgentDir } = await import(`${PI}/dist/index.js`);
const modelsJson = path.join(getAgentDir(), "models.json");

// --- applyLiveModels: discovery only ever adds ids/names/context windows --------
const base = [testModel("Kimi-K3", { reasoning: true })];
const applied = api.applyLiveModels(base, [
	{ id: "Kimi-K3", name: "Kimi K3 (live)", context_length: 777777, supported_endpoints: ["/messages"] },
	{ id: "brand-new-model", context_length: 500000 },
]);
const liveKimi = applied.models.find((model) => model.id === "Kimi-K3");
assert(liveKimi.contextWindow === 777777 && liveKimi.name === "Kimi K3 (live)", "live refresh updates a known model's context window and display name");
assert(liveKimi.api === undefined, "discovery never infers a protocol");
const fresh = applied.models.find((model) => model.id === "brand-new-model");
assert(fresh && fresh.cost && typeof fresh.cost.input === "number" && fresh.contextWindow === 500000, "an unknown live id is added with cost");
assert(fresh.maxTokens === 16384, "without a catalog an unknown live id gets the conservative maxTokens (the fill rule is below)");
assert(applied.unknown.join(",") === "brand-new-model", "an unknown live id is reported");
base[0].input.push("image");
assert(!applied.models.find((model) => model.id === "Kimi-K3").input.includes("image"), "applyLiveModels returns copies, not the caller's objects");

// --- the persisted snapshot restores full definitions, not convention defaults ---------
// The store holds what we registered last time, so an id the base table has never seen must
// come back whole; a known id still takes only the snapshot's live name and context window.
const curated = () => testModel("GLM-5.2", { reasoning: true, maxTokens: 131072, thinkingLevelMap: { max: "max" } });
const restored = api.mergeStoredSnapshot([curated()], [
	{ id: "GLM-5.2", name: "GLM-5.2", api: "openai-completions", contextWindow: 999999 },
	testModel("MiniMax-M2.5", { api: "openai-completions", provider: "scnet", baseUrl: "https://api.scnet.cn/api/llm/v1", reasoning: true, contextWindow: 200000, maxTokens: 131072 }),
]);
assert(restored.length === 2, "a stored row the base table lacks is restored");
const restoredKnown = restored.find((model) => model.id === "GLM-5.2");
assert(restoredKnown.contextWindow === 999999 && restoredKnown.maxTokens === 131072 && restoredKnown.thinkingLevelMap?.max === "max", "a restored known id takes the live context window and keeps its curated parameters");
const restoredNew = restored.find((model) => model.id === "MiniMax-M2.5");
assert(restoredNew.reasoning === true && restoredNew.maxTokens === 131072 && restoredNew.input.includes("text"), "a restored unseen id keeps the definition we registered, not convention defaults");
assert(restoredNew.api === undefined && restoredNew.baseUrl === undefined && restoredNew.provider === undefined, "a restored id the base table lacks keeps no derived api/baseUrl/provider, so a later redirect can still move it");
const moved = api.mergeStoredSnapshot([], [{ id: "moved", api: "anthropic-messages", baseUrl: "https://a.example/anthropic" }])[0];
assert(moved.api === undefined && moved.baseUrl === undefined, "a restored id the base table lacks loses its stored api/baseUrl even when they name a second protocol (a later providers.<id>.api flip must still move it)");
const repaired = api.mergeStoredSnapshot([], [{ id: "bare" }]);
assert(repaired[0].cost && typeof repaired[0].cost.input === "number" && repaired[0].contextWindow === 128000 && repaired[0].maxTokens === 16384, "a restored row missing required fields still gets safe defaults");

const hardened = api.applyLiveModels([{ id: "no-input", name: "n", reasoning: false, contextWindow: 1000, maxTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], []);
assert(Array.isArray(hardened.models[0].input), "a base entry without an input array still yields one (the raw sync re-read can produce such a row)");

// --- an unseen id: the model maker's own entry first, the wire as a ceiling -------
// A hand-made catalog keeps this hermetic: what is under test is the precedence, not pi's
// current model list (builtin-test.mjs derives the real one).
const fakeCatalog = (vendor, unanimous) => ({ byId: new Map(), vendor, votes: new Map(), unanimous, rejectsTemperature: new Set(), providers: new Set(), available: true });
const makerRow = (provider, contextWindow, maxTokens, input) => ({ provider, id: "x", reasoning: false, input, contextWindow, maxTokens });
const vendorFacts = new Map([["vendormodel", makerRow("maker", 4242, 999, ["text", "image"])]]);
const agreedFacts = new Map([
	["vendormodel", { contextWindow: 111, maxTokens: 22, input: ["text"] }],
	["agreedmodel", { contextWindow: 1234, maxTokens: 77, input: ["text", "image"] }],
]);
const withCatalog = api.applyLiveModels([], [{ id: "Vendor-Model" }, { id: "Agreed-Model" }, { id: "unknown-model" }], "openai-completions", fakeCatalog(vendorFacts, agreedFacts));
const vendorModel = withCatalog.models.find((model) => model.id === "Vendor-Model");
assert(vendorModel.contextWindow === 4242 && vendorModel.maxTokens === 999 && vendorModel.input.includes("image"), "the model maker's own entry beats the all-providers-agree map");
const agreedModel = withCatalog.models.find((model) => model.id === "Agreed-Model");
assert(agreedModel.contextWindow === 1234 && agreedModel.maxTokens === 77, "a family with no vendor entry falls back to the all-agree values");
const unknownModel = withCatalog.models.find((model) => model.id === "unknown-model");
assert(unknownModel.maxTokens === 16384 && unknownModel.contextWindow === 128000, "neither source leaves the conservative fallback");
assert(withCatalog.filled.join(", ") === "Vendor-Model (vendor maker), Agreed-Model (every provider agrees)", `the round names each id and its source (got ${withCatalog.filled.join(", ")})`);
const capped = api.applyLiveModels([], [{ id: "Vendor-Model", context_length: 555 }], "openai-completions", fakeCatalog(vendorFacts, agreedFacts));
assert(capped.models[0].contextWindow === 555, "the wire's window caps the vendor's spec (a gateway's budget is harder)");
assert(capped.models[0].maxTokens === 555, "and the output cap is clamped into the window that survived");
const specWins = api.applyLiveModels([], [{ id: "Vendor-Model", context_length: 9999999 }], "openai-completions", fakeCatalog(vendorFacts, agreedFacts));
assert(specWins.models[0].contextWindow === 4242, "a larger wire window does not raise the model's spec");
const noCatalog = api.applyLiveModels([], [{ id: "Vendor-Model" }], "openai-completions");
assert(noCatalog.models[0].maxTokens === 16384 && noCatalog.filled.length === 0, "without a catalog nothing is filled");

// --- models.json: absent vs broken ---------------------------------------------
assert(cfg.readModelsConfig().issue === undefined, "a missing models.json is not an issue (settings can come from the environment)");
writeFileSync(modelsJson, "{ not json");
assert(typeof cfg.readModelsConfig().issue === "string", "malformed models.json is reported");
writeFileSync(modelsJson, JSON.stringify({ providers: { scnet: { apiKey: "$SCNET_API_KEY" } } }));
const parsed = cfg.readModelsConfig();
assert(parsed.issue === undefined, "a valid models.json parses without an issue");
assert(cfg.providerLayerFor("scnet", parsed.config).apiKey === "$SCNET_API_KEY", "providerLayerFor reads the provider's block");
assert(
	JSON.stringify(cfg.providerLayerFor("commandcode", { providers: { codecommand: { authHeader: true } } })) === "{}",
	"an alias key is not a config layer: pi resolves `providers.<id>` by the registered id only",
);
assert(cfg.applyModelPatch === undefined, "the config layer has no model patcher: pi applies its own modelOverrides, we never re-implement it");

console.log(`validated ${total} fixture models`);
console.log("OK");
