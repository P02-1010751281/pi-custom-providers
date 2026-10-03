/**
 * `sync` — fetch every endpoint, merge what answered into the vendor's base table, write it, and
 * register what it wrote in this session.
 *
 * This is the package's only writer of user data (`<id>/models.json`), and `--dry-run` is the one
 * thing that refuses to write. What it writes is the *base* table: the user's `providers.<id>`
 * layer and pi's `modelOverrides` are not inputs, because baking them in would fossilize an
 * override into the file that is supposed to be its base.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { agentPath, assert, loadTs, runCommand, startExtension, testModel, withFetch } from "./harness.mjs";

// The base table's read/diff/write half lives with its reader, in the directory layer.
const sync = await loadTs("extensions/custom-providers/model-table.ts");
const vendorDir = agentPath("custom-providers", "demo");
const file = `${vendorDir}/models.json`;
const base = (id, maxTokens = 100) => testModel(id, { maxTokens });

// --- diff semantics ---------------------------------------------------------------
const diff = sync.diffBaseTable("demo", file, [base("a", 200), base("b")], [base("a"), base("gone")]);
assert(diff.added.join(",") === "b", "a new id is an addition");
assert(diff.changed.length === 1 && diff.changed[0].id === "a" && diff.changed[0].fields.join(",") === "maxTokens", "a changed field is named");
assert(diff.removed.join(",") === "gone", "an id discovery no longer returns is named for --prune, not dropped");
assert(sync.summarizeDiff(diff).some((line) => line.startsWith("- gone (removed")), "the summary marks the pruned id as removed");
assert(sync.summarizeDiff(diff).some((line) => line.startsWith("~ a (maxTokens)")), "the summary names the field that moved");

// --- serialization round-trip -----------------------------------------------------
const serialized = sync.serializeBaseTable([base("a")]);
const parsed = JSON.parse(serialized);
assert(Array.isArray(parsed.models) && parsed.models[0].id === "a", "the canonical {models: []} shape is written");
assert(serialized.indexOf('"id"') < serialized.indexOf('"name"'), "fields are written in a stable order");
assert(parsed.models[0].api === undefined && parsed.models[0].baseUrl === undefined, "a model on the default protocol is stored without api/baseUrl");

// --- the command: fetch, dry run, write -------------------------------------------
mkdirSync(vendorDir, { recursive: true });
writeFileSync(`${vendorDir}/provider.json`, JSON.stringify({ api: "openai-completions", baseUrl: "https://demo.example/v1", modelsPath: "/models", apis: { "anthropic-messages": { baseUrl: "https://demo.example/anthropic" } } }));
writeFileSync(file, JSON.stringify({ models: [base("a"), { ...base("b"), api: "anthropic-messages" }] }));
// The fetch needs a credential before anything runs, or every endpoint is skipped uncredentialed.
process.env.DEMO_KEY = "test-key";
writeFileSync(`${vendorDir}/accounts.json`, JSON.stringify({ default: "main", main: { apiKey: "$DEMO_KEY" } }));

const answered = (rows) => async () => ({ ok: true, json: async () => ({ data: rows }) });
const offline = async () => {
	throw new Error("offline test");
};
const ext = await startExtension();
const notify = [];
const run = (args, stub = answered([{ id: "a", name: "A (live)", context_length: 5000 }, { id: "discovered" }]), answers = {}) =>
	withFetch(stub, () => runCommand(ext.commands, args, notify, answers));
const last = () => notify.at(-1);

const before = readFileSync(file, "utf8");
await run("sync demo --dry-run");
assert(readFileSync(file, "utf8") === before, "--dry-run writes nothing");
assert(last().includes("dry run"), `the dry run says so (got ${last()})`);
assert(last().includes("+ discovered"), `and names the discovered id (got ${last()})`);
assert(last().includes("~ a (name, contextWindow)"), `and the fields discovery moved (got ${last()})`);

// One endpoint failing skips that endpoint only; the other one's answer still counts.
await run(
	"sync demo --dry-run",
	async (url) => (url.includes("/anthropic") ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, json: async () => ({ data: [{ id: "discovered" }] }) }),
);
assert(last().includes("skipped anthropic-messages: HTTP 429"), `a failed endpoint is reported and skipped (got ${last()})`);
assert(last().includes("+ discovered"), `while the endpoint that answered is still applied (got ${last()})`);

// Every endpoint failing: there is no new data to apply, so the file (and its backup) stay put.
await run("sync demo", offline);
assert(readFileSync(file, "utf8") === before, "no answer means no write");
assert(last().includes("no endpoint answered"), `and that is said out loud (got ${last()})`);
assert(!existsSync(`${file}.bak`), "not even a backup");

// A directory that looks configured but whose key does not resolve: the skip is a warning that
// names the reference, not a note — an unset `$VAR` is otherwise a silent `undefined`.
const levels = [];
delete process.env.DEMO_KEY;
await run("sync demo", offline, { levels });
assert(last().includes("no API key") && last().includes("$DEMO_KEY"), `a missing credential names the reference (got ${last()})`);
assert(last().includes("restart or /reload"), `and says why a variable in .env may not be there (got ${last()})`);
assert(levels.at(-1) === "warning", `and is a warning, not a note (got ${levels.at(-1)})`);
assert(readFileSync(file, "utf8") === before, "still no write");
process.env.DEMO_KEY = "test-key";

// The write path.
await run("sync demo");
const after = JSON.parse(readFileSync(file, "utf8"));
assert(Array.isArray(after.models), "sync rewrites the file in the canonical shape");
assert(after.models.length === 3, `the discovered id is now part of the base table (got ${after.models.length})`);
assert(after.models.find((model) => model.id === "a").maxTokens === 100, "the existing base table is the source, not the built-in catalog");
assert(after.models.find((model) => model.id === "a").contextWindow === 5000 && after.models.find((model) => model.id === "a").name === "A (live)", "discovery's values are written");
assert(after.models.find((model) => model.id === "discovered")?.cost?.input === 0, "a discovered id is written with cost (pi requires it)");
assert(after.models.find((model) => model.id === "discovered").baseUrl === undefined, "and without a derived baseUrl (that is a registration-time product)");
assert(existsSync(`${file}.bak`), "a .bak of the previous file is written");
assert(last().includes("wrote") && last().includes("registered demo in this session"), `the write says it applied itself (got ${last()})`);
assert(ext.providers.get("demo").models.length === 3, "and the session carries the new table without a rescan");
assert(ext.providers.get("demo").models.some((model) => model.id === "discovered"), "including the id discovery introduced");

// The written file loads back as the same model set.
const reloaded = await startExtension();
assert(reloaded.providers.get("demo").models.length === 3, "the written table loads back as the same model set");

// The user layer is not baked into the file: it stays in pi's models.json.
writeFileSync(agentPath("models.json"), JSON.stringify({ providers: { demo: { models: [{ id: "a", api: "openai-completions", baseUrl: "https://demo.example/v1", maxTokens: 7 }] } } }));
await run("sync demo");
assert(JSON.parse(readFileSync(file, "utf8")).models.find((model) => model.id === "a").maxTokens === 100, "a user override in models.json is not written into the base table");

// An id discovery no longer returns is kept, named, and dropped only with `--prune`.
await run("sync demo --dry-run", answered([{ id: "a" }, { id: "discovered" }]));
assert(last().includes("vanished (kept, pass --prune to drop): b"), `a vanished id is reported, not dropped (got ${last()})`);
await run("sync demo --prune", answered([{ id: "a" }, { id: "discovered" }]));
assert(JSON.parse(readFileSync(file, "utf8")).models.some((model) => model.id === "b") === false, "--prune drops it from the base table");

// No id means every vendor, and `--prune` is per-vendor by design.
const secondDir = agentPath("custom-providers", "second");
mkdirSync(secondDir, { recursive: true });
writeFileSync(`${secondDir}/provider.json`, JSON.stringify({ name: "second", baseUrl: "https://second.example/v1", api: "openai-completions", modelsPath: "/models" }));
writeFileSync(`${secondDir}/models.json`, JSON.stringify({ models: [base("s1")] }));
await run("sync");
assert(last().includes("demo") && last().includes("second"), `no id syncs every vendor (got ${last()})`);

// An unknown id is reported, not guessed at.
await run("sync nope --dry-run");
assert(last().includes("No provider directory"), `an unknown id is reported (got ${last()})`);

console.log(`sync diff: +${diff.added.length} ~${diff.changed.length} -${diff.removed.length}`);
console.log("OK");
