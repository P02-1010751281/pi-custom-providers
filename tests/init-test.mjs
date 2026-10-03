/**
 * `init` — the wizard (with a UI) and the flag path (without one) write the same two files:
 * `provider.json` and, only when a key was given and no file exists yet, `accounts.json`.
 *
 * The credential is stored **verbatim**: it is a reference as often as it is a literal, and
 * resolving it here would persist a secret pi would then own. It is never echoed in the report.
 * The vendor is registered as part of the write: a verb that changes the directory applies its own
 * change, so `init` hands the user no follow-up command (`rescan` stays for out-of-band edits).
 */
import { existsSync, readFileSync } from "node:fs";
import { agentPath, assert, loadTs, runCommand, startExtension, withFetch } from "./harness.mjs";

const { readAccountsFile } = await loadTs("extensions/custom-providers/credentials.ts");
const { loadBuiltinCatalog, unanimousFacts, vendorFacts } = await loadTs("extensions/custom-providers/builtin.ts");
const ext = await startExtension();
const notify = [];
const last = () => notify.at(-1) ?? "";
const file = (id, name) => agentPath("custom-providers", id, name);
const json = (id, name) => JSON.parse(readFileSync(file(id, name), "utf8"));
// `init` ends with the same discovery round `sync` runs, so every call here is offline: a test
// must never depend on the network.
const offline = async () => {
	throw new Error("offline test");
};
const run = (args, answers) => withFetch(offline, () => runCommand(ext.commands, args, notify, answers));

// --- the flag path (no dialogs needed) -------------------------------------------
await run("init manual --url https://manual.example/v1 --api openai-completions --key $MANUAL_KEY");
assert(last().includes("wrote provider.json"), `the provider file is reported (got ${last()})`);
assert(json("manual", "provider.json").api === "openai-completions" && json("manual", "provider.json").baseUrl === "https://manual.example/v1", "the declaration is what was asked for");
assert(json("manual", "provider.json").name === "manual", "the directory name is the display name (editable in the file)");
assert(!("apis" in json("manual", "provider.json")), "no second endpoint is invented");

// The written credential reads back with zero issues, verbatim.
const issues = [];
const parsed = readAccountsFile(file("manual", "accounts.json"), issues);
assert(issues.length === 0, `the written accounts.json reads back clean (got ${JSON.stringify(issues)})`);
assert(parsed.defaultPointer === "main" && parsed.accounts[0].apiKey === "$MANUAL_KEY", `and holds the reference as written (got ${JSON.stringify(parsed.accounts)})`);
assert(!last().includes("MANUAL_KEY"), "the value is never echoed in the report");

// A literal key is kept as written and *said out loud* — the file is where a secret would sit.
await run("init literal --url https://literal.example/v1 --api openai-completions --key sk-abc123");
assert(readFileSync(file("literal", "accounts.json"), "utf8").includes("sk-abc123"), "a literal key is stored verbatim");
assert(last().includes("literal"), `the report flags a literal key (got ${last()})`);
assert(!last().includes("sk-abc123"), "without echoing the secret");

// An existing `accounts.json` is never clobbered: it may hold several accounts.
await run("init manual --url https://manual.example/v2 --api openai-completions --key $OTHER_KEY --force");
assert(readFileSync(file("manual", "accounts.json"), "utf8").includes("MANUAL_KEY"), "an existing accounts.json is left alone even with --force");
assert(json("manual", "provider.json").baseUrl === "https://manual.example/v2", "while --force does rewrite provider.json");

// --- the wizard path: the dialogs answer what the flags did not ------------------
await run("init", { input: ["wizard", "https://wizard.example/v1", "", "$WIZARD_KEY"], select: ["openai-completions"], confirm: [true] });
assert(json("wizard", "provider.json").baseUrl === "https://wizard.example/v1", "the wizard writes the same provider.json");
assert(json("wizard", "provider.json").modelsPath === undefined, "a blank discovery answer means no modelsPath");
assert(readFileSync(file("wizard", "accounts.json"), "utf8").includes("$WIZARD_KEY"), "and the same accounts.json when a key was typed");

// A wizard the user escapes writes nothing at all.
await run("init", {});
assert((last().includes("cancelled") || last().includes("Usage:")) && !existsSync(file("cancelled", "provider.json")), `an escaped wizard aborts with usage (got ${last()})`);

// --- without a UI the flags are the whole interface ------------------------------
await run("init noflags", { hasUI: false });
assert(last().includes("Usage: /providers init") && !existsSync(file("noflags", "provider.json")), `a missing flag is a usage error, not a prompt (got ${last()})`);

await run("init bad --url https://bad.example/v1 --api nope", { hasUI: false });
assert(last().includes("unsupported api") && !existsSync(file("bad", "provider.json")), `an api pi cannot stream is refused before writing (got ${last()})`);

await run("init bad --url https://bad.example/v1 --api openai-completions --models-path /v1/models", { hasUI: false });
assert(json("bad", "provider.json").modelsPath === "/v1/models", "a discovery path is written when given");

// --- init ends by running sync: one verb from nothing to a usable provider -------
// The endpoint and the credential are proven here, not on the user's first request, and the
// written table is what the session registers — no follow-up `sync`.
process.env.AUTO_KEY = "test-key";
delete process.env.MISSING_KEY;
const catalog = await loadBuiltinCatalog();
// Derived, not hardcoded: the maker's own entry first, the all-providers-agree values second.
// The id is picked so the two sources *disagree* (57 ids do — e.g. deepseek-v4-pro, where only the
// maker states the windows), otherwise this case could not tell the precedence apart.
const settled = [...catalog.vendor.keys()]
	.map((key) => ({ key, facts: vendorFacts(key, catalog), agreed: unanimousFacts(key, catalog) }))
	.find(
		(entry) =>
			entry.facts?.maxTokens !== undefined &&
			entry.facts.contextWindow !== undefined &&
			entry.facts.maxTokens <= entry.facts.contextWindow &&
			(entry.agreed?.contextWindow !== entry.facts.contextWindow || entry.agreed?.maxTokens !== entry.facts.maxTokens),
	);
assert(settled, "the catalog carries a vendor id whose own numbers differ from the agreement for this case");
const settledId = settled.key;
await withFetch(
	async () => ({ ok: true, json: async () => ({ data: [{ id: settledId }, { id: "zzz-auto-sync" }] }) }),
	() => runCommand(ext.commands, "init auto --url https://auto.example/v1 --api openai-completions --models-path /models --key $AUTO_KEY", notify),
);
assert(existsSync(file("auto", "models.json")), "init fetches the live list");
const autoModels = json("auto", "models.json").models;
assert(autoModels.map((model) => model.id).sort().join(",") === [settledId, "zzz-auto-sync"].sort().join(","), `and writes it to the vendor's models.json (got ${autoModels.map((model) => model.id).join(",")})`);
const settledRow = autoModels.find((model) => model.id === settledId);
assert(settledRow.maxTokens === settled.facts.maxTokens && settledRow.contextWindow === settled.facts.contextWindow, `a discovered id takes its maker's / the agreed windows (got ${settledRow.contextWindow}/${settledRow.maxTokens})`);
assert(autoModels.find((model) => model.id === "zzz-auto-sync").maxTokens === 16384, "an id the catalog does not carry keeps the conservative fallback");
assert(last().includes("registered auto in this session"), `init reports the registration (got ${last()})`);
assert(ext.providers.get("auto").models.length === 2, "and the session carries the table without a rescan or a second sync");
// A directory whose key does not resolve: init says so instead of registering an empty provider.
delete process.env.AUTO_KEY;
await run("init keyless --url https://keyless.example/v1 --api openai-completions --models-path /models --key $MISSING_KEY");
assert(!existsSync(file("keyless", "models.json")), "no credential means no model table");
assert(last().includes("$MISSING_KEY") && last().includes("no model table yet"), `and init names the unresolved reference (got ${last()})`);
assert(ext.providers.has("keyless"), "while the provider itself is still registered");

console.log("OK");
