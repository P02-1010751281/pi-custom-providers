import { readFileSync, writeFileSync } from "node:fs";
import { PI, agentPath, assert, loadTs } from "./harness.mjs";

/**
 * The model field vocabulary, pinned to pi's.
 *
 * A `models.json` entry is supposed to carry pi's own model fields and nothing else, but pi
 * exports no model schema (only its runtime knows it), so the list in `model-table.ts` is a
 * hand-kept mirror. `samplingParams` lived in that list while being read by nothing: the key
 * was accepted, the value was dropped from the registered model, and `sync --write` did not
 * write it back. A static comparison of two lists would not have caught that, so this file
 * checks both halves — the lists agree, and every field of them survives a read + write.
 *
 * A failure here is a decision to make, not necessarily a bug: pi gained a field (carry it),
 * or lost one (drop it), or this package grew a key of its own (which then belongs in its own
 * file, not in a base table).
 */
const { MODEL_KEYS, readModelsFile, serializeBaseTable } = await loadTs("extensions/custom-providers/model-table.ts");

/**
 * The top-level property names of one `const <name> = Type.Object({ … });` in pi's source —
 * pi's schema is a TypeBox literal, not a type this package could import. `ModelDefinitionSchema`
 * is the authority for a model entry; `ProviderConfigSchema` is the same for pi's own provider
 * config (ours is the four-file layout, which is why only the model entry is a mirror).
 */
const source = readFileSync(`${PI}/dist/core/model-config.js`, "utf8");
function schemaKeys(name) {
	const declaration = source.indexOf(`const ${name} = Type.Object({`);
	assert(declaration >= 0, `pi still declares ${name} (the schema this pin reads moved)`);
	let depth = 0;
	let body = "";
	for (let index = source.indexOf("{", declaration); index < source.length; index += 1) {
		const char = source[index];
		if (char === "{") depth += 1;
		else if (char === "}" && --depth === 0) break;
		if (depth >= 1) body += char;
	}
	return new Set([...body.matchAll(/^\s*([A-Za-z_$][\w$]*):/gm)].map((match) => match[1]));
}

const piKeys = schemaKeys("ModelDefinitionSchema");
const missing = [...piKeys].filter((key) => !MODEL_KEYS.has(key));
const extra = [...MODEL_KEYS].filter((key) => !piKeys.has(key));
assert(missing.length === 0, `every field pi's ModelDefinitionSchema knows is readable here (missing: ${missing.join(", ")})`);
assert(extra.length === 0, `and no key is accepted that pi would drop (not pi's: ${extra.join(", ")})`);
assert(schemaKeys("ProviderConfigSchema").size > 0, "the schema reader itself works (ProviderConfigSchema is non-empty)");

// --- every field survives a read + write -----------------------------------------
// `sync --write` rewrites the base table out of what the reader kept, so a field the reader
// ignores is a field the user loses on the next sync. One entry carrying every pi field,
// back out again: this is the half that a list comparison cannot prove.
const full = {
	id: "full",
	name: "Full",
	api: "anthropic-messages",
	baseUrl: "https://demo.example/anthropic",
	reasoning: true,
	thinkingLevelMap: { high: "high" },
	input: ["text", "image"],
	inputLimits: { maxRequestBytes: 1000, images: { maxPerRequest: 4, resize: { maxWidth: 800 } } },
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, tiers: [{ input: 100, output: 3, cacheRead: 1, cacheWrite: 1 }] },
	promptCache: { short: 300, long: 3600 },
	contextWindow: 200000,
	maxTokens: 8192,
	samplingParams: { temperature: 0.3, top_p: 0.9 },
	headers: { "x-test": "1" },
	compat: { supportsStore: false },
};
const file = agentPath("pi-surface-models.json");
writeFileSync(file, JSON.stringify({ models: [full] }));
const issues = [];
const { models, broken } = readModelsFile(file, issues);
assert(!broken && models.length === 1, "the entry loads");
assert(issues.length === 0, `no field of it is reported as unknown (got ${issues.map((issue) => issue.message).join(" | ")})`);
const roundTripped = JSON.parse(serializeBaseTable(models)).models[0];
for (const [key, value] of Object.entries(full)) {
	assert(JSON.stringify(roundTripped[key]) === JSON.stringify(value), `the ${key} field survives read + write (got ${JSON.stringify(roundTripped[key])})`);
}
assert(Object.keys(roundTripped).length === Object.keys(full).length, `and no field is invented (got ${Object.keys(roundTripped).join(", ")})`);
assert(MODEL_KEYS.size === Object.keys(full).length, "test premise: the sample entry carries every key of the vocabulary");

console.log(`pi model fields: ${piKeys.size} pinned, ${Object.keys(full).length} round-tripped`);
console.log("OK");
