import { loadTs, loader, assert } from "./harness.mjs";

/**
 * Loader parity guard: pi aliases `@earendil-works/pi-ai` to the compat entry, which
exports getModels/getModel/getProviders on top of dist/index.js. Built-in catalog
readers depend on it, so the test alias map must keep matching pi's own loader.
 */
const compat = await (await loader()).import("@earendil-works/pi-ai");
assert(typeof compat.getProviders === "function", "aliased @earendil-works/pi-ai exposes getProviders");
assert(typeof compat.getModels === "function", "aliased @earendil-works/pi-ai exposes getModels");
assert(typeof compat.calculateCost === "function", "aliased @earendil-works/pi-ai keeps calculateCost");

/** Smoke test: load the extension through pi's own jiti loader and check it registers. */
const mod = await loadTs("extensions/custom-providers/index.ts");
const factory = mod.default;
assert(typeof factory === "function", "default export is a factory function");

const providers = new Map();
const handlers = [];
const commands = [];
const pi = {
	on: (event) => handlers.push(event),
	registerCommand: (name) => commands.push(name),
	registerProvider: (id, config) => providers.set(id, config),
	registerFlag: () => {},
	registerShortcut: () => {},
	registerTool: () => {},
	getFlag: () => undefined,
};
await factory(pi);

for (const id of ["commandcode", "scnet"]) {
	assert(providers.has(id), `registered provider ${id}`);
	const config = providers.get(id);
	const models = config.models;
	assert(Array.isArray(models) && models.length > 0, `${id} has models`);
	for (const model of models) {
		assert(model.cost && typeof model.cost.input === "number", `${id}/${model.id} has cost`);
		assert(model.contextWindow > 0, `${id}/${model.id} has contextWindow`);
		assert(model.maxTokens > 0, `${id}/${model.id} has maxTokens`);
		// pi hands `model.baseUrl` straight to the Anthropic SDK, which appends
		// `/v1/messages` itself. A base that already ends in `/v1` therefore sends every
		// request to a doubled path (`/provider/v1/v1/messages` -> 404, measured).
		if (model.api === "anthropic-messages") {
			const base = model.baseUrl ?? config.baseUrl;
			assert(!/\/v1$/.test(base), `${id}/${model.id}: anthropic baseUrl must not end in /v1 (got ${base})`);
		}
	}
}
// SCNet's two wires register as ONE provider: same vendor, one picker entry, and the wire is
// selected per model in models.json (the selection itself is covered by tests/wire-test.mjs).
assert(providers.size === 2, `one provider per vendor (got ${[...providers.keys()].join(", ")})`);
assert(!providers.has("scnet-anthropic"), "the Anthropic wire is not a provider of its own");
assert(providers.get("scnet").models.length === 19, `the merged provider holds the union of both wires (got ${providers.get("scnet").models.length})`);
assert(providers.get("scnet").models.every((model) => model.api !== "anthropic-messages"), "without configuration every SCNet model keeps the OpenAI wire");
assert(
	providers.get("commandcode").models.find((model) => model.id === "claude-sonnet-5").baseUrl === "https://api.commandcode.ai/provider",
	"codecommand's Anthropic models are pointed at the route prefix without /v1",
);

console.log(`providers: ${[...providers.keys()].join(", ")}`);
console.log(`model counts: ${[...providers].map(([id, c]) => `${id}=${c.models.length}`).join(", ")}`);
console.log(`on: ${handlers.join(", ")}`);
console.log(`cmd: ${commands.join(", ")}`);
assert(handlers.includes("session_start"), "session_start handler registered");
assert(commands.includes("refresh-custom-models"), "refresh command registered");
assert(commands.includes("custom-providers"), "status command registered");
console.log("OK");
