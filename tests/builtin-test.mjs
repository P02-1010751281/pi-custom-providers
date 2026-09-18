import { loadTs, assert } from "./harness.mjs";

const { loadBuiltinCatalog, absorbCompat, normalizeModelId, summarizeDrift } = await loadTs("extensions/custom-providers/builtin.ts");

// --- pi's built-in catalog is readable through the loader alias ---------------
// pi maps `@earendil-works/pi-ai` to its compat entry; dist/index.js has no
// getProviders/getModels, so this also guards the alias in tests/harness.mjs.
const builtin = await loadBuiltinCatalog();
assert(builtin.available, "pi built-in catalog is readable from an extension");
assert(builtin.byId.size > 100, `built-in catalog is populated (got ${builtin.byId.size} ids)`);
assert(normalizeModelId("zai-org/GLM-5.1") === normalizeModelId("glm-5.1"), "namespaced ids normalize to built-in ids");
assert(normalizeModelId("claude-haiku-4-5-20251001") === normalizeModelId("claude-haiku-4-5"), "dated ids normalize to built-in ids");

// --- absorption is a whitelist, limited to the Anthropic wire -----------------
assert(absorbCompat({ id: "claude-opus-5", api: "anthropic-messages" }, builtin)?.supportsTemperature === false, "Opus 5 absorbs supportsTemperature: false");
assert(absorbCompat({ id: "claude-opus-5", api: "openai-completions" }, builtin) === undefined, "nothing is absorbed on the OpenAI wire");
assert(absorbCompat({ id: "claude-opus-4-5", api: "anthropic-messages" }, builtin) === undefined, "nothing is absorbed when pi does not mark the model");

// --- the extension registers the absorbed flag, and only that flag -----------
const factory = (await loadTs("extensions/custom-providers/index.ts")).default;
const providers = new Map();
const handlers = new Map();
const events = new Map();
const pi = {
	on: (event, handler) => events.set(event, handler),
	registerCommand: (name, options) => handlers.set(name, options),
	registerProvider: (id, config) => providers.set(id, config),
	registerFlag: () => {},
	registerShortcut: () => {},
	registerTool: () => {},
	getFlag: () => undefined,
};
await factory(pi);

for (const id of ["commandcode", "scnet"]) {
	const config = providers.get(id);
	assert(config, `registered provider ${id}`);
	assert(typeof config.refreshModels === "function", `${id} exposes pi's refreshModels hook`);
	assert(Array.isArray(config.models) && config.models.length > 0, `${id} has models`);
	// pi drops provider-level compat and ignores unknown options: forwarding them
	// would look like configuration while doing nothing.
	assert(!("compat" in config), `${id}: compat is per model, never provider-level`);
	assert(!("disableStrictTools" in config), `${id}: no inert non-pi provider options`);
}

const commandcode = providers.get("commandcode");
const opus5 = commandcode.models.find((model) => model.id === "claude-opus-5");
assert(opus5?.api === "anthropic-messages", "claude-opus-5 is on the Anthropic wire");
assert(opus5.compat?.supportsTemperature === false, "claude-opus-5 rejects non-default temperature (absorbed)");
for (const [id, config] of providers) {
	for (const model of config.models) {
		for (const key of Object.keys(model.compat ?? {})) {
			assert(key === "supportsTemperature", `only the whitelisted compat field is absorbed (saw ${key} on ${id}/${model.id})`);
		}
	}
}

const drift = summarizeDrift(commandcode.models, builtin);
assert(drift.matched > 0, `catalog models match built-in ids (got ${drift.matched})`);

// --- refreshModels: cached snapshot (no network) ------------------------------
let offlinePublished = false;
const offline = await commandcode.refreshModels({
	allowNetwork: false,
	signal: new AbortController().signal,
	stored: { models: [{ id: "brand-new-model", name: "Brand New", contextWindow: 123_456, provider: "commandcode" }] },
	publish: async () => {
		offlinePublished = true;
		return true;
	},
});
const restored = offline.find((model) => model.id === "brand-new-model");
assert(restored, "a persisted snapshot restores an id the catalog does not have");
assert(restored.cost && typeof restored.cost.input === "number", "restored models still carry cost (tiers-crash guard)");
assert(restored.contextWindow === 123_456, "restored context window is applied");
assert(offlinePublished === false, "no persistence when no network fetch happened");

// --- refreshModels: network path (stubbed fetch) ------------------------------
const realFetch = globalThis.fetch;
let publication;
globalThis.fetch = async () => ({
	ok: true,
	json: async () => ({ data: [{ id: "claude-opus-5", name: "Opus 5 (live)", context_length: 999_999 }] }),
});
try {
	const online = await commandcode.refreshModels({
		allowNetwork: true,
		credential: { type: "api_key", key: "test-key" },
		signal: new AbortController().signal,
		publish: async (value) => {
			publication = value;
			return true;
		},
	});
	const live = online.find((model) => model.id === "claude-opus-5");
	assert(live.contextWindow === 999_999, "live context window is applied");
	assert(live.name === "Opus 5 (live)", "live display name is applied");
	assert(live.compat?.supportsTemperature === false, "absorbed compat survives the live layer");
	assert(live.maxTokens === opus5.maxTokens, "maxTokens stays catalog-owned (never invented by the wire)");
	const persisted = publication?.persist?.models ?? [];
	const entry = persisted.find((model) => model.id === "claude-opus-5");
	assert(entry, "persist publication carries the refreshed models");
	assert(entry.provider === "commandcode" && entry.api === "anthropic-messages" && entry.baseUrl.startsWith("https://api.commandcode.ai"), "persisted entries are Model-shaped (provider/api/baseUrl)");
	assert(typeof publication.persist.checkedAt === "number", "persisted entry carries checkedAt");
	assert(persisted.every((model) => model.cost), "every persisted model carries cost");
} finally {
	globalThis.fetch = realFetch;
}

// --- refreshModels: a failing wire keeps the catalog --------------------------
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
try {
	const failed = await commandcode.refreshModels({
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async () => true,
	});
	assert(failed.length === commandcode.models.length || failed.length > 0, "a failed fetch still returns the catalog models");
	assert(failed.some((model) => model.id === "claude-opus-5"), "catalog models survive a failed fetch");
	assert(failed.every((model) => model.cost), "models survive a failed fetch with cost intact");
} finally {
	globalThis.fetch = realFetch;
}

// --- a missing credential fails by name, and the failure is still reported -------
// The extension memoizes live data, so a later failure must not be mistaken for a
// success: it is recorded as `error` while `live` stays true.
const savedKey = process.env.CMD_API_KEY;
delete process.env.CMD_API_KEY;
let fetchCalls = 0;
globalThis.fetch = async () => {
	fetchCalls += 1;
	return { ok: false, status: 401, json: async () => ({}) };
};
try {
	const keyless = await commandcode.refreshModels({ allowNetwork: true, signal: new AbortController().signal, publish: async () => true });
	assert(fetchCalls === 0, "no request is sent without a credential");
	assert(keyless.some((model) => model.id === "claude-opus-5"), "the catalog is kept when no key resolves");
} finally {
	globalThis.fetch = realFetch;
	if (savedKey !== undefined) process.env.CMD_API_KEY = savedKey;
}
const notices = [];
await handlers.get("custom-providers").handler("", { hasUI: true, ui: { notify: (message) => notices.push(message) } });
const status = notices.at(-1) ?? "";
const statusSegment = status.match(/commandcode[^;]*/)?.[0] ?? "";
assert(status.includes("CMD_API_KEY"), `the status output names the missing variable (got: ${status})`);
assert(statusSegment.includes("refresh failed"), `the status output reports the failed refresh (got: ${statusSegment})`);

// The session_start warning must also report it — a memoized live list must not hide a
// failing refresh behind "70 models (live)". Fetch is stubbed so this stays offline.
const warnings = [];
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
try {
	await events.get("session_start")({}, { hasUI: true, ui: { notify: (message) => warnings.push(message) } });
} finally {
	globalThis.fetch = realFetch;
}
const warning = warnings.at(-1) ?? "";
assert(warning.includes("refresh failed"), `session_start reports failed refreshes (got: ${warning})`);
assert(warning.includes("from the last successful fetch"), `a memoized list is reported as such (got: ${warning})`);

// pi follows every registerProvider with a cache-only refreshModels round; it carries no
// outcome of its own and must not erase the failure we just recorded.
await commandcode.refreshModels({ allowNetwork: false, signal: new AbortController().signal, publish: async () => true });
const afterCacheOnly = [];
await handlers.get("custom-providers").handler("", { hasUI: true, ui: { notify: (message) => afterCacheOnly.push(message) } });
// Scoped to this provider's own segment: the other providers were not refreshed here,
// so a whole-message match would pass on their text alone.
const cacheOnlySegment = (afterCacheOnly.at(-1) ?? "").match(/commandcode[^;]*/)?.[0] ?? "";
assert(cacheOnlySegment.includes("refresh failed"), `a cache-only round keeps the recorded failure for that provider (got: ${cacheOnlySegment})`);

console.log(`built-in catalog: ${builtin.byId.size} ids, ${builtin.rejectsTemperature.size} reject temperature`);
console.log(`drift for codecommand: matched=${drift.matched} reasoning=${drift.reasoning.length} input=${drift.input.length} maxTokens=${drift.maxTokens.length} contextWindow=${drift.contextWindow.length}`);
console.log(`commands: ${[...handlers.keys()].join(", ")}`);
console.log("OK");
