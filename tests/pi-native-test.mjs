import { loadTs, PI, assert, seedDefaultProviders } from "./harness.mjs";

/**
 * End-to-end checks of the pi-native path, using pi's own ModelRuntime (not a stub):
 *
 *     registerProvider(config) -> runtime.refresh({allowNetwork:true})
 *         -> config.refreshModels(context) -> context.publish({persist})
 *         -> models-store entry + runtime.getModels()
 *
 * Everything runs offline: `fetch` is stubbed and the models store is in-memory, so
 * nothing is written to `~/.pi`. This is the path `pi update --models` exercises, and
 * it is the regression test for the refreshModels migration.
 */
const { ModelRuntime } = await import(`${PI}/dist/core/model-runtime.js`);
const { InMemoryCodingAgentModelsStore } = await import(`${PI}/dist/core/models-store.js`);

const factory = (await loadTs("extensions/custom-providers/index.ts")).default;
const providers = new Map();
await seedDefaultProviders("commandcode", "scnet");
await factory({
	on: () => {},
	registerCommand: () => {},
	registerProvider: (id, config) => providers.set(id, config),
	registerFlag: () => {},
	registerShortcut: () => {},
	registerTool: () => {},
	getFlag: () => undefined,
});
const config = providers.get("commandcode");

// The refresh phase only runs when a credential resolves, so give the env-based
// apiKey (`$CMD_API_KEY` in the provider config) something to resolve.
process.env.CMD_API_KEY ??= "test-key";

const CATALOG_OPUS5_CONTEXT = config.models.find((model) => model.id === "claude-opus-5").contextWindow;
const create = (modelsStore) => ModelRuntime.create({ modelsPath: null, modelsStore, allowModelNetwork: false, refreshOnCreate: false });

// --- a previous session's snapshot is restored before any network access -------
const seededStore = new InMemoryCodingAgentModelsStore();
await seededStore.write("commandcode", {
	checkedAt: Date.now(),
	models: [
		{
			id: "claude-opus-5",
			name: "Seeded Opus 5",
			api: "anthropic-messages",
			provider: "commandcode",
			baseUrl: "https://api.commandcode.ai/provider/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 424_242,
			maxTokens: 1000,
		},
	],
});
const seeded = await create(seededStore);
seeded.registerProvider("commandcode", config);
await seeded.refresh({ allowNetwork: false, providers: ["commandcode"] });
const seededOpus = seeded.getModels("commandcode").find((model) => model.id === "claude-opus-5");
assert(seededOpus?.contextWindow === 424_242, `offline phase restores the persisted snapshot (got ${seededOpus?.contextWindow})`);
assert(seeded.getModels("commandcode").length === config.models.length, "the restored snapshot is merged over the full catalog, not used alone");

// --- pi's refresh phase persists the refreshed catalog -------------------------
const store = new InMemoryCodingAgentModelsStore();
const runtime = await create(store);
runtime.registerProvider("commandcode", config);
const before = runtime.getModels("commandcode");
assert(before.length === config.models.length, `runtime exposes the registered catalog (got ${before.length})`);
assert(before.find((model) => model.id === "claude-opus-5")?.compat?.supportsTemperature === false, "absorbed compat reaches the composed model");
assert(!(await store.read("commandcode")), "nothing persisted before a network refresh");

const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({
	ok: true,
	json: async () => ({ data: [{ id: "claude-opus-5", name: "Opus 5 (pi native)", context_length: 777_777 }] }),
});
try {
	const result = await runtime.refresh({ allowNetwork: true, force: true, providers: ["commandcode"] });
	assert(result.errors.size === 0, `refresh reported no errors (${[...result.errors.keys()].join(", ")})`);

	const opus = runtime.getModels("commandcode").find((model) => model.id === "claude-opus-5");
	assert(opus?.contextWindow === 777_777, `runtime picked up the refreshed context window (got ${opus?.contextWindow})`);
	assert(opus?.name === "Opus 5 (pi native)", "runtime picked up the refreshed display name");
	assert(opus?.compat?.supportsTemperature === false, "absorbed compat survives pi's refresh phase");
	assert(runtime.getModels("commandcode").every((model) => model.cost && typeof model.cost.input === "number"), "every refreshed model carries cost");

	const persisted = await store.read("commandcode");
	assert(typeof persisted?.checkedAt === "number", "persisted entry carries checkedAt");
	assert(persisted.models.find((model) => model.id === "claude-opus-5")?.provider === "commandcode", "persisted models are provider-stamped");
	// The persisted snapshot is read back by pi, so a wrong baseUrl here is a wrong URL
	// on every later session. pi's Anthropic client appends `/v1/messages` itself.
	const persistedAnthropic = persisted.models.find((model) => model.id === "claude-opus-5");
	assert(persistedAnthropic?.api === "anthropic-messages", "the persisted Anthropic model keeps its wire");
	assert(!/\/v1$/.test(persistedAnthropic?.baseUrl ?? ""), `persisted Anthropic models must not carry a /v1 baseURL (got ${persistedAnthropic?.baseUrl})`);
	assert(persisted.models.find((model) => model.id === "claude-opus-5")?.contextWindow === 777_777, "persisted models carry the refreshed values");
} finally {
	globalThis.fetch = realFetch;
}

// --- a cache-only phase must not downgrade live values to the catalog ----------
// pi ends every `registerProvider` with `void this.refresh({allowNetwork:false})`, and the
// extension re-registers from its own `session_start` refresh — a live result that was not
// (yet) persisted exists only in this process. A second runtime with an empty store
// reproduces exactly that cache-only phase: the in-process live snapshot must win over the
// committed catalog, otherwise the refresh would be undone a moment after it ran.
const coldStore = new InMemoryCodingAgentModelsStore();
const cold = await create(coldStore);
cold.registerProvider("commandcode", config);
await cold.refresh({ allowNetwork: false, providers: ["commandcode"] });
const coldOpus = cold.getModels("commandcode").find((model) => model.id === "claude-opus-5");
assert(CATALOG_OPUS5_CONTEXT !== 777_777, "test premise: the live value differs from the catalog value");
assert(
	coldOpus?.contextWindow === 777_777,
	`a cache-only phase keeps this process's live value (got ${coldOpus?.contextWindow}, catalog is ${CATALOG_OPUS5_CONTEXT})`,
);
assert(!(await coldStore.read("commandcode")), "the cache-only phase does not persist anything");

// The persisted snapshot also survives a re-registration, so the catalog value never leaks back.
runtime.registerProvider("commandcode", config);
await new Promise((resolve) => setTimeout(resolve, 50));
const afterReregister = runtime.getModels("commandcode").find((model) => model.id === "claude-opus-5");
assert(afterReregister?.contextWindow === 777_777, `live values survive a re-registration (got ${afterReregister?.contextWindow})`);
assert((await store.read("commandcode")).models.find((model) => model.id === "claude-opus-5")?.contextWindow === 777_777, "the cache-only phase does not persist the catalog over the snapshot");

console.log(`runtime models: ${before.length}; catalog claude-opus-5 contextWindow=${CATALOG_OPUS5_CONTEXT}`);
console.log(`persisted models: ${(await store.read("commandcode")).models.length}`);
console.log("OK");
