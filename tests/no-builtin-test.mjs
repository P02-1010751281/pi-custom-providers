import { existsSync, readFileSync, rmSync } from "node:fs";
import { agentPath, assert, loadTs, runCommand, seedDefaultProviders, startExtension, testModel, TEST_VENDORS, withFetch } from "./harness.mjs";

/**
 * There are no built-in providers and no shipped vendor knowledge (design §8, v0.5.0): a provider
 * exists because `custom-providers/<id>/provider.json` does, and `init` writes that directory.
 */
// --- no directory, no provider -------------------------------------------------
const empty = await startExtension();
assert(empty.providers.size === 0, `no custom-providers directory registers nothing (got ${[...empty.providers.keys()].join(", ")})`);

// --- a directory registers with what it declares, credential included ----------
await seedDefaultProviders("commandcode");
const seeded = await startExtension();
assert(seeded.providers.has("commandcode"), "a directory registers the provider");
assert(seeded.providers.get("commandcode").models.length > 0, "and gets the model table from its own models.json");
assert(seeded.providers.get("commandcode").apiKey === "$CMD_API_KEY", "and the credential from its own accounts.json");
assert(seeded.providers.get("commandcode").api === TEST_VENDORS.commandcode.declaration.api, "and the declared endpoint");

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

// --- init writes the directory and registers it; rescan is for out-of-band edits ---
const notify = [];
const ui = await startExtension();
const run = (args) => runCommand(ui.commands, args, notify);

const scnetDir = agentPath("custom-providers", "scnet");
const scnetFile = `${scnetDir}/provider.json`;
await run("init scnet --url https://api.scnet.cn/api/llm/v1 --api openai-completions --models-path /models");
assert(existsSync(scnetFile), "init writes the provider file");
const written = JSON.parse(readFileSync(scnetFile, "utf8"));
assert(written.api === "openai-completions" && written.baseUrl === "https://api.scnet.cn/api/llm/v1", `with the declaration it was given (got ${JSON.stringify(written)})`);
assert(written.modelsPath === "/models", "including the discovery path");
assert(!existsSync(`${scnetDir}/accounts.json`), "and no accounts.json when no key was given");

await run("init scnet --url https://api.scnet.cn/api/llm/v1 --api openai-completions");
assert((notify.at(-1) ?? "").includes("exists"), "a second init refuses to overwrite without --force");
await run("init scnet --url https://mirror.example/v1 --api openai-completions --force");
assert(JSON.parse(readFileSync(scnetFile, "utf8")).baseUrl === "https://mirror.example/v1", "--force overwrites");

// `init` applies its own write: no rescan step between the file and the session.
await run("status scnet");
assert((notify.at(-1) ?? "").startsWith("scnet: 0 models"), `init registers the vendor it wrote (got ${notify.at(-1)})`);
assert(ui.providers.has("scnet"), "and pi carries it without a rescan");
await run("rescan");
assert(ui.providers.has("scnet"), "a later rescan leaves it registered");

console.log(`test vendors: ${Object.keys(TEST_VENDORS).join(", ")}`);
console.log("OK");
