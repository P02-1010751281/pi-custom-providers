import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { agentPath, assert, startExtension, testModel } from "./harness.mjs";

/**
 * Ids a complete discovery round no longer returns are *reported* (never silently dropped),
 * and only `sync --prune` drops them. The report is deliberately conservative: a failed
 * endpoint, or an empty registry answer (SCNet quota), makes "gone" indistinguishable from
 * "no data" — so the whole vendor reports nothing and nothing is pruned.
 */
const dir = agentPath("custom-providers", "demo");
mkdirSync(dir, { recursive: true });
writeFileSync(
	`${dir}/provider.json`,
	JSON.stringify({
		name: "Demo",
		api: "openai-completions",
		baseUrl: "https://demo.example/v1",
		modelsPath: "/models",
		apis: { "anthropic-messages": { baseUrl: "https://demo.example/anthropic", modelsPath: "/models" } },
	}),
);
const base = (id) => testModel(id, { reasoning: true });
const file = `${dir}/models.json`;
writeFileSync(file, JSON.stringify({ models: [base("keep"), base("gone")] }));
writeFileSync(agentPath("models.json"), "{}");
process.env.DEMO_KEY = "test-key";
writeFileSync(`${dir}/accounts.json`, JSON.stringify({ default: "main", main: { apiKey: "$DEMO_KEY" } }));

const ext = await startExtension();
const provider = ext.providers.get("demo");
const command = ext.commands.get("custom-providers");
const refresh = () => provider.refreshModels({ allowNetwork: true, signal: new AbortController().signal, publish: async () => true });
const run = async (args) => {
	const out = [];
	await command.handler(args, { ui: { notify: (message) => out.push(message) } });
	return out.join(" ");
};
const ids = () => JSON.parse(readFileSync(file, "utf8")).models.map((model) => model.id);

const realFetch = globalThis.fetch;
const withFetch = async (impl) => {
	globalThis.fetch = impl;
	try {
		await refresh();
	} finally {
		globalThis.fetch = realFetch;
	}
};

// --- an empty registry answer (SCNet quota) is not evidence of deletion --------
await withFetch(async () => ({ ok: true, json: async () => ({ data: [] }) }));
assert(!(await run("")).includes("gone"), "an empty /models answer does not report every id as vanished");
assert(ids().join(",") === "keep,gone", "and nothing is dropped");

// --- a failed sibling endpoint suppresses the report ---------------------------
let calls = 0;
await withFetch(async () => {
	calls += 1;
	if (calls === 1) return { ok: true, json: async () => ({ data: [{ id: "keep" }] }) };
	throw new Error("endpoint down");
});
assert(!(await run("")).includes("gone"), "a failed sibling endpoint suppresses the vanished report");
assert(ids().join(",") === "keep,gone", "and nothing is dropped from the file");

// --- a complete round reports the id, keeps it until --prune -------------------
await withFetch(async () => ({ ok: true, json: async () => ({ data: [{ id: "keep" }, { id: "live" }] }) }));
const status = await run("");
assert(status.includes("gone") && status.includes("no longer returned by discovery"), `vanished id is reported (got ${status})`);
const dry = await run("sync demo");
assert(dry.includes("--prune") && dry.includes("gone"), `the dry run offers --prune (got ${dry})`);
assert(ids().join(",") === "keep,gone", "a dry run does not drop the vanished id");
const wrote = await run("sync demo --write --prune");
assert(wrote.includes("wrote"), `the prune write is reported (got ${wrote})`);
assert(ids().join(",") === "keep,live", `--prune drops the vanished id and keeps discovery's (got ${ids().join(",")})`);

console.log(`vanished: empty+failure suppressed, then reported and pruned (kept ${ids().length})`);
console.log("OK");
