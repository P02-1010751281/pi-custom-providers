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
import { agentPath, assert, loadTs, PI, REPO_ROOT, runCommand, seedDefaultProviders, startExtension, testModel } from "./harness.mjs";

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

// --- the counts the docs state are the counts the installed pi has ----------------------
// The table above is machine-checked; prose is not. README and attention.md both state
// per-protocol read-key counts, so a pi upgrade that changes a read set would leave the table
// (and its report) correct while the prose stayed stale - and the prose is what a user reads.
// Pinned here rather than in a doc test of its own, because the derived set is this file's job.
const flat = (file) => readFileSync(path.join(REPO_ROOT, file), "utf8").replace(/\s+/g, "");
const reads = (api) => readKeys(api).length;

// README: `anthropic-messages` 读 13 个、`openai-completions` 读 27 个、`google-*` 一个都不读
const readme = flat("README.md");
const stated = [...readme.matchAll(/`([a-z0-9-]+)`读(\d+)个/g)];
assert(stated.length >= 2, `README still states per-protocol read-key counts (found ${stated.length})`);
for (const [, api, count] of stated) {
	assert(BUILTIN_APIS.includes(api), `README's read-key count names a real protocol (${api})`);
	assert(Number(count) === reads(api), `README's count for ${api} matches pi (doc ${count} / pi ${reads(api)})`);
}
assert(readme.includes("`google-*`一个都不读"), "README still makes the google claim");
for (const api of ["google-generative-ai", "google-vertex"]) {
	assert(reads(api) === 0, `${api} reads no compat key, as README claims`);
}

// attention.md: 实测读键数：`anthropic-messages` 13、…、`pi-messages` 0；
const attention = flat(".codestable/attention.md");
const listStart = attention.indexOf("实测读键数");
assert(listStart >= 0, "attention.md keeps its read-key count list");
const listed = [...attention.slice(listStart, attention.indexOf("；", listStart)).matchAll(/`([a-z0-9-]+)`(\d+)/g)];
assert(listed.length === BUILTIN_APIS.length, `attention.md gives every protocol a count (found ${listed.length} of ${BUILTIN_APIS.length})`);
for (const [, api, count] of listed) {
	assert(BUILTIN_APIS.includes(api), `attention.md's count names a real protocol (${api})`);
	assert(Number(count) === reads(api), `attention.md's count for ${api} matches pi (doc ${count} / pi ${reads(api)})`);
}
const shared = attention.match(/被≥2个协议读的键(\d+)个/);
assert(shared, "attention.md states how many keys at least two protocols read");
const SHARED = [...new Set(BUILTIN_APIS.flatMap((api) => readKeys(api)))].filter((key) => BUILTIN_APIS.filter((api) => readKeys(api).includes(key)).length >= 2);
assert(Number(shared[1]) === SHARED.length, `attention.md's shared-key count matches pi (doc ${shared[1]} / pi ${SHARED.length})`);
// Keys attention.md names as read even though the schema never declares them.
for (const key of ["thinkingTokenBudgetField", "zaiToolStream", "supportsToolSearch"]) {
	assert(BUILTIN_APIS.some((api) => readKeys(api).includes(key)), `${key} is in the derived read set, as attention.md says`);
}

console.log("OK");
