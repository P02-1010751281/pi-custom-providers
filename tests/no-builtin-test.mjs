import { existsSync, readFileSync, rmSync } from "node:fs";
import { agentPath, assert, loadTs, runCommand, seedDefaultProviders, startExtension, testModel, withFetch } from "./harness.mjs";

/**
 * There are no built-in providers (design §8): the shipped `sources.ts` defaults seed a
 * directory, they are never registered on their own. No directory = no provider, and
 * `custom-providers init` writes the directory that makes one.
 */
const { DEFAULTS } = await loadTs("extensions/custom-providers/sources.ts");

// --- no directory, no provider -------------------------------------------------
const empty = await startExtension();
assert(empty.providers.size === 0, `no custom-providers directory registers nothing (got ${[...empty.providers.keys()].join(", ")})`);

// --- a directory for a shipped id gets the seeded model table + default account --
await seedDefaultProviders("commandcode");
const seeded = await startExtension();
assert(seeded.providers.has("commandcode"), "a directory registers the provider");
assert(seeded.providers.get("commandcode").models.length > 0, "and gets the model table from its own models.json");
assert(seeded.providers.get("commandcode").apiKey === "$CMD_API_KEY", "and the shipped default account");
assert(seeded.providers.get("commandcode").api === DEFAULTS.find((vendor) => vendor.id === "commandcode").declaration.api, "and the shipped endpoint");

// --- the extension ships no model table: provider.json alone registers no models --
rmSync(agentPath("custom-providers", "commandcode", "models.json"));
const bare = await startExtension();
assert(bare.providers.has("commandcode"), "the directory still registers");
assert(bare.providers.get("commandcode").models.length === 0, "with no models.json there is no model table to register (the extension ships none)");

// --- an empty registry answer must not shadow the persisted snapshot -------------
// Regression: memoizing an empty `/models` answer made the store-restore branch skip, so a
// provider without `models.json` registered 0 models even when pi held a snapshot.
const snapshotProvider = bare.providers.get("commandcode");
process.env.CMD_API_KEY ??= "test-key";
await withFetch(async () => ({ ok: true, json: async () => ({ data: [] }) }), async () => {
	await snapshotProvider.refreshModels({ allowNetwork: true, signal: new AbortController().signal, publish: async () => true });
	const restored = await snapshotProvider.refreshModels({
		allowNetwork: false,
		signal: new AbortController().signal,
		publish: async () => true,
		stored: { models: [testModel("from-store", { name: "From Store", reasoning: true, contextWindow: 4321, maxTokens: 321 })] },
	});
	assert(restored.some((model) => model.id === "from-store"), `an empty /models answer must not shadow the persisted snapshot (got ${restored.length} models)`);
	assert(restored.find((model) => model.id === "from-store").maxTokens === 321, "and the restored entry keeps the parameters pi persisted");
});

// --- init writes provider.json for a shipped id --------------------------------
const notify = [];
const ui = await startExtension();
const run = (args) => runCommand(ui.commands, args, notify);

const scnetFile = agentPath("custom-providers", "scnet", "provider.json");
await run("init scnet");
assert(existsSync(scnetFile), "init writes the provider file");
const written = JSON.parse(readFileSync(scnetFile, "utf8"));
assert(written.api === "openai-completions" && written.baseUrl.includes("scnet"), "with the shipped declaration");
assert(written.apis?.["anthropic-messages"]?.baseUrl, "including the second endpoint");

await run("init scnet");
assert((notify.at(-1) ?? "").includes("exists"), "a second init refuses to overwrite without --force");
// Regression: `sync` re-scans, so it sees a directory `init` wrote in this same session.
await run("sync scnet");
assert(!(notify.at(-1) ?? "").includes("No provider directory named"), `sync sees the directory init just wrote (got: ${notify.at(-1)})`);
await run("init scnet --force");
assert((notify.at(-1) ?? "").includes("wrote"), "--force overwrites");
await run("init nope");
assert((notify.at(-1) ?? "").includes("unknown"), "an unknown id is reported");

console.log(`defaults: ${DEFAULTS.map((vendor) => vendor.id).join(", ")}`);
console.log("OK");
