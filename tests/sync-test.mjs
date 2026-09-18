import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { agentPath, assert, loadTs, startExtension } from "./harness.mjs";

/**
 * `sync` — the only code path in this package that writes a user file, and only with
 * `--write` (design §9, decision 13).
 *
 * What it writes is the *base* table (the vendor's model base merged with discovery). The
 * user's `providers.<id>` layer and `modelOverrides` are deliberately excluded: baking them
 * in would fossilize a user override into the file that is supposed to be its base.
 */
const sync = await loadTs("extensions/custom-providers/sync-models.ts");
const vendorDir = agentPath("custom-providers", "demo");
const file = `${vendorDir}/models.json`;
const reset = () => writeFileSync(agentPath("models.json"), "{}");
const base = (id, maxTokens = 100) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 1000, maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

// --- diff semantics ---------------------------------------------------------------
const diff = sync.diffBaseTable("demo", file, [base("a", 200), base("b")], [base("a"), base("gone")]);
assert(diff.added.join(",") === "b", "a new id is an addition");
assert(diff.changed.length === 1 && diff.changed[0].id === "a" && diff.changed[0].fields.join(",") === "maxTokens", "a changed field is named");
assert(diff.removed.join(",") === "gone", "an id discovery no longer returns is reported as kept, not dropped");
assert(sync.summarizeDiff(diff).some((line) => line.startsWith("~ a (maxTokens)")), "the summary names the field that moved");

// --- serialization round-trip -----------------------------------------------------
const serialized = sync.serializeBaseTable([base("a")]);
const parsed = JSON.parse(serialized);
assert(Array.isArray(parsed.models) && parsed.models[0].id === "a", "the canonical {models: []} shape is written");
assert(serialized.indexOf('"id"') < serialized.indexOf('"name"'), "fields are written in a stable order");
assert(parsed.models[0].api === undefined && parsed.models[0].baseUrl === undefined, "a model on the default protocol is stored without api/baseUrl");

// --- the command: dry run, then --write -------------------------------------------
mkdirSync(vendorDir, { recursive: true });
writeFileSync(`${vendorDir}/provider.json`, JSON.stringify({ api: "openai-completions", baseUrl: "https://demo.example/v1", modelsPath: "/models", apis: { "anthropic-messages": { baseUrl: "https://demo.example/anthropic" } } }));
writeFileSync(file, JSON.stringify({ models: [base("a"), { ...base("b"), api: "anthropic-messages" }] }));
reset();
// The vendor needs a credential before the extension loads, or the refresh has nothing to
// resolve and the discovery memo stays empty (which is itself a covered case elsewhere).
process.env.DEMO_KEY = "test-key";
writeFileSync(`${vendorDir}/accounts.json`, JSON.stringify({ default: "main", main: { apiKey: "$DEMO_KEY" } }));
const ext = await startExtension();
const command = ext.commands.get("custom-providers");
/** Fill the in-process discovery memo that `sync` merges — in this extension instance. */
const refreshAll = async () => {
	for (const provider of ext.providers.values()) {
		if (typeof provider.refreshModels === "function") await provider.refreshModels({ allowNetwork: true, signal: new AbortController().signal, publish: async () => true });
	}
};

const before = readFileSync(file, "utf8");
const dry = [];
await command.handler("sync demo", { ui: { notify: (message) => dry.push(message) } });
assert(readFileSync(file, "utf8") === before, "without --write nothing is written");
assert(dry.join(" ").includes("already current"), `an unchanged table says so (got ${dry.join(" ")})`);

// What makes a directory vendor's table dirty is discovery, not the user: the base table
// *is* the file. Run one online refresh with a stubbed registry, then look at the diff.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: "a", name: "A (live)", context_length: 5000 }, { id: "discovered" }] }) });
try {
	await refreshAll();
} finally {
	globalThis.fetch = realFetch;
}
const dirty = [];
await command.handler("sync demo", { ui: { notify: (message) => dirty.push(message) } });
assert(JSON.parse(readFileSync(file, "utf8")).models.length === 2, `a dry run does not touch the file (got ${JSON.parse(readFileSync(file, "utf8")).models.length})`);
assert(dirty.join(" ").includes("--write"), `the dry run says how to apply (got ${dirty.join(" ")})`);
assert(dirty.join(" ").includes("+ discovered"), `and names the discovered id (got ${dirty.join(" ")})`);
assert(dirty.join(" ").includes("~ a (name, contextWindow)"), `and the fields discovery moved (got ${dirty.join(" ")})`);

// A `sync --write` applies the merge, normalizes the shape and keeps a `.bak`.
writeFileSync(file, JSON.stringify([{ ...base("a"), maxTokens: 999 }, base("b")]));
const written = [];
await command.handler("sync demo --write", { ui: { notify: (message) => written.push(message) } });
const after = JSON.parse(readFileSync(file, "utf8"));
assert(Array.isArray(after.models), "sync --write rewrites the file in the canonical shape");
assert(after.models.length === 3, `the discovered id is now part of the base table (got ${after.models.length})`);
assert(after.models.find((model) => model.id === "a").maxTokens === 999, "the existing base table is the source, not the built-in catalog");
assert(after.models.find((model) => model.id === "a").contextWindow === 5000 && after.models.find((model) => model.id === "a").name === "A (live)", "discovery's values are written");
assert(after.models.find((model) => model.id === "discovered")?.cost?.input === 0, "a discovered id is written with cost (pi requires it)");
assert(after.models.find((model) => model.id === "discovered").baseUrl === undefined, "and without a derived baseUrl (that is a registration-time product)");
assert(existsSync(`${file}.bak`), "a .bak of the previous file is written");
assert(JSON.parse(readFileSync(`${file}.bak`, "utf8")).length === 2, "the backup holds the previous bytes");
assert(written.join(" ").includes("wrote"), `the write is reported (got ${written.join(" ")})`);

// The written file loads back as the same model set.
const reloaded = await startExtension();
assert(reloaded.providers.get("demo").models.length === 3, "the written table loads back as the same model set");
assert(reloaded.providers.get("demo").models.find((model) => model.id === "a").maxTokens === 999, "round trip keeps the values");

// The user layer is not baked into the file: it stays in pi's models.json.
writeFileSync(agentPath("models.json"), JSON.stringify({ providers: { demo: { models: [{ id: "a", maxTokens: 7 }] } } }));
const layered = [];
await command.handler("sync demo --write", { ui: { notify: (message) => layered.push(message) } });
assert(JSON.parse(readFileSync(file, "utf8")).models.find((model) => model.id === "a").maxTokens === 999, "a user override in models.json is not written into the base table");
assert(layered.join(" ").includes("current"), `and the base table is still reported as current (got ${layered.join(" ")})`);

// A directory that does not exist is reported, not guessed at.
const missing = [];
await command.handler("sync nope --write", { ui: { notify: (message) => missing.push(message) } });
assert(missing.join(" ").includes("No provider directory"), `an unknown id is reported (got ${missing.join(" ")})`);

console.log(`sync diff: +${diff.added.length} ~${diff.changed.length} -${diff.removed.length}`);
console.log("OK");
