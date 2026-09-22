import { mkdirSync, writeFileSync } from "node:fs";
import { agentPath, assert, startExtension } from "./harness.mjs";

/**
 * Accounts (design §3.3, §7): credentials only, and one provider id per credential set.
 *
 * `pi`'s `auth.json` is one credential per provider id, so a second key for the same
 * product needs a second provider id — `<vendor>-<account>` — while a *different product*
 * needs a different directory. The `default` pointer decides which account registers as the
 * plain `<vendor>` id; with no usable pointer the base id is suppressed for a directory
 * vendor, and with no accounts at all it is still registered (without credentials) so
 * `/login`, `--api-key` and stored credentials remain reachable.
 */
const vendorDir = (id) => agentPath("custom-providers", id);
const write = (id, name, contents) => {
	mkdirSync(vendorDir(id), { recursive: true });
	writeFileSync(`${vendorDir(id)}/${name}`, JSON.stringify(contents, null, "\t"));
};
const reset = (modelsJson = {}) => writeFileSync(agentPath("models.json"), JSON.stringify(modelsJson));
const provider = { api: "openai-completions", baseUrl: "https://demo.example/v1", modelsPath: "/models" };
const model = (id) => ({ id, contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

/** A fresh directory vendor with one model, so each scenario starts from the same base. */
function vendor(accounts, models = [model("m")]) {
	mkdirSync(vendorDir("demo"), { recursive: true });
	writeFileSync(`${vendorDir("demo")}/provider.json`, JSON.stringify(provider));
	writeFileSync(`${vendorDir("demo")}/models.json`, JSON.stringify({ models }));
	if (accounts) writeFileSync(`${vendorDir("demo")}/accounts.json`, JSON.stringify(accounts));
	else writeFileSync(`${vendorDir("demo")}/accounts.json`, JSON.stringify({}));
}

reset();
vendor({ default: "main", main: { apiKey: "$MAIN_KEY", authHeader: true }, work: { apiKey: "$WORK_KEY" } });
let ext = await startExtension();
assert(ext.providers.has("demo") && ext.providers.has("demo-work"), `the pointer target registers as the base id, the rest as <id>-<name> (got ${[...ext.providers.keys()].join(",")})`);
assert(ext.providers.get("demo").apiKey === "$MAIN_KEY", "the base id carries the pointed account's key");
assert(ext.providers.get("demo").authHeader === true, "and its authHeader");
assert(ext.providers.get("demo-work").apiKey === "$WORK_KEY", "the second account is its own provider id");
assert(ext.providers.get("demo-work").authHeader === undefined, "an account only sets what it declares");
assert(ext.providers.get("demo").models.length === 1 && ext.providers.get("demo-work").models.length === 1, "accounts share the vendor's model table");
assert(!ext.providers.get("demo-work").models.some((entry) => entry.name.includes("(main)")), "the base account gets no name suffix");

// A bare UPPER_SNAKE key is an env var *name*: pi only interpolates `$VAR`, so we rewrite it.
write(vendorDir("demo"), "accounts.json", { default: "main", main: { apiKey: "MAIN_KEY" } });
assert((await startExtension()).providers.get("demo").apiKey === "$MAIN_KEY", "a bare variable name is normalized to $VAR before pi sees it");

// Accounts but no pointer: the base id is not registered, the accounts still are.
vendor({ main: { apiKey: "$MAIN_KEY" }, work: { apiKey: "$WORK_KEY" } });
ext = await startExtension();
assert(!ext.providers.has("demo"), "with accounts and no default pointer the base id is not registered");
assert(ext.providers.has("demo-main") && ext.providers.has("demo-work"), "the declared accounts still register");
await ext.sessionStart();
assert(ext.notifications.map((entry) => entry.message).join(" | ").includes('no "default" account') || ext.notifications.length === 0, "the missing pointer is reported");

// A pointer to a nonexistent account: only the base id is affected.
vendor({ default: "ghost", main: { apiKey: "$MAIN_KEY" } });
ext = await startExtension();
assert(!ext.providers.has("demo") && ext.providers.has("demo-main"), "a dangling pointer only suppresses the base id");

// No accounts at all: still registered, without a credential, so /login can rescue it.
vendor(undefined);
ext = await startExtension();
assert(ext.providers.has("demo"), "with no accounts.json the base id is still registered");
assert(ext.providers.get("demo").apiKey === undefined, "and carries no credential of its own");
assert(ext.providers.get("demo").models.length === 1, "the base model table is registered");
await ext.sessionStart();
assert(!ext.notifications.some((entry) => entry.message.includes("no credential")), "a credential-less vendor is not spammy at startup (it is reported as a failed refresh)");

// An account without apiKey is skipped, which also makes the pointer dangle: the base id is
// suppressed (a directory vendor requires a usable pointer) and both facts are reported.
vendor({ default: "main", main: { authHeader: true }, work: { apiKey: "$WORK_KEY" } });
ext = await startExtension();
assert(!ext.providers.has("demo"), "a pointer that names a skipped account leaves the base id unregistered");
assert(ext.providers.has("demo-work"), "the other account is unaffected");
await ext.sessionStart();
const skippedReport = ext.notifications.map((entry) => entry.message).join(" | ");
assert(skippedReport.includes('account "main": needs "apiKey"'), `the skipped account is reported (got: ${skippedReport})`);
assert(skippedReport.includes('"default": "main" does not name an account'), "and the dangling pointer");

// Non-auth keys and invalid names are reported, never silently honored.
vendor({ default: "main", main: { apiKey: "$K", models: [{ id: "x" }] }, "Bad Name": { apiKey: "$K" }, wire: { apiKey: "$K" } });
ext = await startExtension();
assert(!ext.providers.has("demo-bad-name"), "an invalid account name is skipped");
assert(ext.providers.get("demo").models.length === 1, "an account cannot inject models: it only carries authentication");
await ext.sessionStart();
const accountReport = ext.notifications.map((entry) => entry.message).join(" | ");
assert(accountReport.includes("not an auth field"), `a non-auth account key is reported (got: ${accountReport})`);
assert(accountReport.includes("invalid name"), "an invalid account name is reported");

// `providers.<accountId>` is the native way to give one account its own model overrides.
reset({ providers: { demo: { models: [{ id: "m", maxTokens: 100 }] }, "demo-work": { models: [{ id: "m", maxTokens: 4096, contextWindow: 2048 }] } } });
vendor({ default: "main", main: { apiKey: "$MAIN_KEY" }, work: { apiKey: "$WORK_KEY" } });
ext = await startExtension();
assert(ext.providers.get("demo").models[0].maxTokens === 100, "the base provider reads its own models.json block");
assert(ext.providers.get("demo-work").models[0].maxTokens === 4096 && ext.providers.get("demo-work").models[0].contextWindow === 2048, "an account layers its own block over the base one");
assert(ext.providers.get("demo-work").models[0].name.includes("(work)"), `an account's models are labelled with the account (got ${ext.providers.get("demo-work").models[0].name})`);

// A directory for a shipped id keeps the shipped base account when the directory only adds accounts.
reset();
mkdirSync(vendorDir("scnet"), { recursive: true });
writeFileSync(`${vendorDir("scnet")}/provider.json`, JSON.stringify({ api: "openai-completions", baseUrl: "https://api.scnet.cn/api/llm/v1", modelsPath: "/models" }));
writeFileSync(`${vendorDir("scnet")}/accounts.json`, JSON.stringify({ work: { apiKey: "$WORK_KEY" } }));
ext = await startExtension();
assert(ext.providers.has("scnet"), "the shipped default account keeps the base id registered");
assert(ext.providers.get("scnet").apiKey === "$SCNET_API_KEY", "and supplies its credential");
assert(ext.providers.has("scnet-work"), "while the extra account is added");

console.log(`accounts: ${[...ext.providers.keys()].join(", ")}`);
console.log("OK");
