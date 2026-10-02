/**
 * The `compat` read-key table (design §10 #15, owner decision 2026-10-02: report the keys a
 * protocol's implementation never reads, criterion = pi's own read-set).
 *
 * pi takes a compat key it does not know — `ProviderCompatSchema` is a union of the three
 * per-family object schemas and each of them allows extra properties — and then drops it
 * silently, because every protocol implementation reads `compat.<key>` for itself. So "this key
 * has no effect" is only sayable with a read-set, and the read-set must come from pi: this test
 * re-derives it from the installed `pi-ai/dist/api` and fails when it drifts, so a pi upgrade
 * that adds or removes a key turns into a red test instead of a lying report.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentPath, assert, loadTs, PI, runCommand, seedDefaultProviders, startExtension, testModel } from "./harness.mjs";

const { API_COMPAT_KEYS, BUILTIN_APIS, inertCompatKeys } = await loadTs("extensions/custom-providers/apis.ts");

const API_DIR = path.join(PI, "node_modules/@earendil-works/pi-ai/dist/api");
const KEY = /compat\??\.([A-Za-z_][A-Za-z0-9_]*)/g;
const IMPORT = /from\s+"(\.\/[^"]+\.js)"/g;

/** Every `dist/api` module one protocol implementation pulls in — helpers read keys too. */
function closure(entry) {
	const seen = new Set();
	const stack = [entry];
	while (stack.length > 0) {
		const name = stack.pop();
		if (seen.has(name)) continue;
		let source;
		try {
			source = readFileSync(path.join(API_DIR, name), "utf8");
		} catch {
			continue;
		}
		seen.add(name);
		for (const match of source.matchAll(IMPORT)) stack.push(path.basename(match[1]));
	}
	return seen;
}

/** The keys pi actually reads for one protocol, derived the same way the table was. */
function readKeys(api) {
	const keys = new Set();
	for (const module of closure(`${api}.js`)) {
		for (const match of readFileSync(path.join(API_DIR, module), "utf8").matchAll(KEY)) keys.add(match[1]);
	}
	return [...keys].sort();
}

// --- the table is a mirror of the installed pi -----------------------------------------
for (const api of BUILTIN_APIS) {
	const derived = readKeys(api);
	const ours = [...(API_COMPAT_KEYS[api] ?? [])].sort();
	assert(derived.join(", ") === ours.join(", "), `${api}: read-key table matches pi (ours: ${ours.join(", ")} / pi: ${derived.join(", ")})`);
}
assert(
	Object.keys(API_COMPAT_KEYS).sort().join(", ") === [...BUILTIN_APIS].sort().join(", "),
	`every known protocol has an entry, measured or empty (got ${Object.keys(API_COMPAT_KEYS).join(", ")})`,
);

// --- what counts as inert --------------------------------------------------------------
assert(inertCompatKeys("anthropic-messages", { forceAdaptiveThinking: true, supportsTemperature: false }).length === 0, "keys the protocol reads are left alone");
assert(inertCompatKeys("anthropic-messages", { thinkingFormat: "zai" }).join(", ") === "thinkingFormat", "a key only another family reads is inert");
assert(inertCompatKeys("openai-completions", { thinkingFormat: "zai" }).length === 0, "the same key is fine on the family whose builder reads it");
assert(inertCompatKeys("google-generative-ai", { a: 1, b: 2 }).join(", ") === "a, b", "a protocol that reads no compat key makes every key inert");
assert(inertCompatKeys("unmeasured-protocol", { anything: 1 }).length === 0, "an api nobody measured claims nothing");
assert(inertCompatKeys("anthropic-messages", undefined).length === 0, "no compat, nothing to report");

// --- the report, on the model's own layer and on pi's modelOverrides top layer ---------
mkdirSync(agentPath("custom-providers", "demo"), { recursive: true });
writeFileSync(
	agentPath("custom-providers", "demo", "provider.json"),
	JSON.stringify({ name: "demo", api: "openai-completions", baseUrl: "https://demo.example/v1", apis: { "anthropic-messages": { baseUrl: "https://demo.example/anthropic" } } }),
);
await seedDefaultProviders("commandcode");

/** Load the extension with one `models.json` and return what the default `status` verb said. */
const statusWith = async (providerBlock, modelExtra) => {
	writeFileSync(
		agentPath("custom-providers", "demo", "models.json"),
		JSON.stringify({ models: [testModel("m1", { api: "anthropic-messages", ...modelExtra })] }),
	);
	// No block at all is fine for pi (an *empty* one is not), and the model's own compat is the
	// layer under test — the second case adds `modelOverrides`, pi's top layer.
	writeFileSync(agentPath("models.json"), JSON.stringify({ providers: providerBlock ? { demo: providerBlock } : {} }));
	const ext = await startExtension();
	const notify = [];
	await runCommand(ext.commands, "", notify);
	const model = ext.providers.get("demo")?.models.find((row) => row.id === "m1");
	assert(model?.api === "anthropic-messages", "the model really ended up on the anthropic endpoint");
	return { ext, status: notify.at(-1) ?? "" };
};

{
	const { status } = await statusWith(undefined, { compat: { thinkingFormat: "zai" } });
	assert(status.includes('demo: compat key "thinkingFormat" has no effect on anthropic-messages'), `the model layer is reported (got ${status})`);
	assert(!status.includes("commandcode: compat"), "and a provider with only effective keys stays quiet");
}

{
	const { status } = await statusWith(
		{ modelOverrides: { m1: { compat: { supportsDeveloperRole: true, thinkingFormat: "zai" } } } },
		{},
	);
	assert(
		status.includes('demo: compat keys "supportsDeveloperRole", "thinkingFormat" have no effect on anthropic-messages'),
		`pi's top layer is reported too, keys sorted and named once (got ${status})`,
	);
}

console.log("OK");
