/**
 * The `models.json` blocks pi rejects at registration time — reported *before* `pi.registerProvider`
 * is called, so one bad block is a message instead of an exception that takes out every provider
 * registered after it (design §10 #22/#23/#24).
 *
 * pi's rules are pinned against pi itself (`ModelRuntime.registerProvider`), not only against our
 * copy of them: every case below also asserts that pi really throws for the same bytes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { agentPath, assert, PI, runCommand, seedDefaultProviders, startExtension, TEST_VENDORS } from "./harness.mjs";

const { ModelRuntime } = await import(`${PI}/dist/core/model-runtime.js`);
const { InMemoryCodingAgentModelsStore } = await import(`${PI}/dist/core/models-store.js`);

const modelsFile = agentPath("models.json");
const writeModels = (contents) => writeFileSync(modelsFile, JSON.stringify(contents));
/** `demo` needs a directory: a block only configures a provider this extension registers. */
mkdirSync(agentPath("custom-providers", "demo"), { recursive: true });
writeFileSync(agentPath("custom-providers", "demo", "provider.json"), JSON.stringify({ name: "demo", ...TEST_VENDORS.scnet.declaration }));
await seedDefaultProviders("commandcode");

/** What pi itself does with the file the extension just read: the same bytes, pi's own runtime. */
const piThrows = async () => {
	const runtime = await ModelRuntime.create({ modelsPath: modelsFile, modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
	try {
		runtime.registerProvider("demo", { name: "demo", baseUrl: "https://demo.example/v1", api: "openai-completions", models: [] });
		return undefined;
	} catch (error) {
		return String(error);
	}
};

/** Load the extension against one `models.json` and report the status line it produces. */
const load = async (contents) => {
	writeModels(contents);
	const ext = await startExtension();
	const notify = [];
	await runCommand(ext.commands, "", notify);
	return { ext, status: notify.at(-1) ?? "" };
};

// --- an empty `providers.<id>` block: pi throws, we report it and keep going -----------
{
	const { ext, status } = await load({ providers: { demo: {} } });
	assert(!ext.providers.has("demo"), "a block pi would reject leaves the provider unregistered");
	assert(ext.providers.has("commandcode"), "while the providers after it still register (that is the whole point)");
	assert(status.includes("must specify") && status.includes("modelOverrides"), `and the report says why (got ${status})`);
	assert((await piThrows()).includes("must specify"), "pi agrees: the same block throws in its own runtime");
}

// --- a `models[]` entry with no `api` anywhere: pi throws ----------------------------
{
	const { ext, status } = await load({ providers: { demo: { models: [{ id: "m1" }] } } });
	assert(!ext.providers.has("demo"), "a user model entry without an api leaves the provider unregistered");
	assert(ext.providers.has("commandcode"), "and the rest of the loop survives");
	assert(status.includes('an "api"') && status.includes('a "baseUrl"'), `both missing fields are named (got ${status})`);
	assert((await piThrows()).includes("api"), "pi agrees");
}

// --- `oauth` without `baseUrl`: pi throws --------------------------------------------
{
	const { ext, status } = await load({ providers: { demo: { oauth: "radius" } } });
	assert(!ext.providers.has("demo"), "oauth without baseUrl is refused before pi sees it");
	assert(status.includes('"oauth" is set without "baseUrl"'), `with pi's own wording (got ${status})`);
	assert((await piThrows()).includes("baseUrl"), "pi agrees");
}

// --- a short patch is legal when the block carries api+baseUrl (the kept layer's recipe) ------
// Keeping our `models[]` read is only useful if the entries can survive pi's validation, and the
// cheap form does: provider-level `api`+`baseUrl` plus a bare `{id, maxTokens}` entry is accepted
// by pi (measured 2026-10-03) and patched by this package. Only `baseUrl` (or neither) is not.
{
	const { ext, status } = await load({ providers: { demo: { api: "openai-completions", baseUrl: "https://user.example/v1", models: [{ id: "m1", maxTokens: 7 }] } } });
	assert(ext.providers.has("demo"), "block-level api+baseUrl accept a bare model patch");
	assert(ext.providers.get("demo").models.some((model) => model.id === "m1" && model.maxTokens === 7), "and this package applies it");
	assert((await piThrows()) === undefined, "pi accepts the same bytes — no entry-level api/baseUrl needed");
	assert(!status.includes("no \"api\""), `with nothing reported (got ${status})`);
}

// --- a block that fails pi's *schema*: pi discards the whole file, so we read none of it --
for (const [what, block] of [
	["a non-string apiKey", { apiKey: 123, models: [{ id: "m1", api: "openai-completions", maxTokens: 7 }] }],
	["an illegal oauth value", { oauth: "nope" }],
]) {
	const { ext, status } = await load({ providers: { demo: block } });
	assert(status.includes("discards the whole models.json"), `${what} is reported as the file-wide drop pi does (got ${status})`);
	assert(ext.providers.has("demo"), "the provider still registers from its own directory declaration");
	assert(!ext.providers.get("demo").models.some((model) => model.id === "m1"), "and nothing from the discarded file is applied");
}

// --- what pi applies from a user block for a provider an *extension* registered ---------------
// Measured 2026-10-03 against the real runtime: an extension-registered id keeps the extension's
// model list. The user's `models[]` entries are validated (they need `api`+`baseUrl` — a model
// entry is a *definition* to pi) but never applied, not even when the extension registered zero
// models; `modelOverrides` on the other hand is applied on top. So for our providers the patch
// door pi actually opens is `modelOverrides`, while `models[]` reaches the list only through this
// package's own read (design open question: that read is a mechanism pi does not run).
{
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const row = (id, name, maxTokens) => ({ id, name, api: "openai-completions", baseUrl: "https://x.example/v1", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens, cost });
	writeModels({ providers: { demo: { models: [row("m-new", "USER-NEW", 100)], modelOverrides: { "m-new": { maxTokens: 4242 }, m1: { maxTokens: 4242 } } } } });
	const runtime = await ModelRuntime.create({ modelsPath: modelsFile, modelsStore: new InMemoryCodingAgentModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider("demo", { name: "demo", baseUrl: "https://demo.example/v1", api: "openai-completions", models: [row("m1", "OURS", 200)] });
	const table = runtime.getModels("demo") ?? [];
	assert(!table.some((model) => model.id === "m-new"), "pi does not apply a user models[] entry to an extension-registered provider");
	assert(table.some((model) => model.id === "m1" && model.maxTokens === 4242), "but it does apply modelOverrides to the registered model");
	assert(runtime.getModel("demo", "m-new") === undefined, "so a model only declared there does not exist for pi");
}

// --- a legitimate block is applied, unchanged (the report must not fire on good input) ----
{
	const { ext, status } = await load({ providers: { demo: { models: [{ id: "m1", api: "openai-completions", baseUrl: "https://demo.example/v1", maxTokens: 7 }] } } });
	assert(ext.providers.has("demo"), "a legal block registers the provider");
	assert(ext.providers.get("demo").models.some((model) => model.id === "m1" && model.maxTokens === 7), "and this package reads it as a patch — pi itself would not apply it (case above)");
	assert(!status.includes("discards") && !status.includes("must specify"), `with nothing reported (got ${status})`);
}

console.log("OK");
