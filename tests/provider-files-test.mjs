import { mkdirSync, writeFileSync } from "node:fs";
import { agentPath, assert, loadTs, startExtension } from "./harness.mjs";

/**
 * The directory layer (design §3, §8, §10): scanning, validation and fail-closed behavior.
 *
 * A vendor is any subdirectory with a parseable `provider.json`; a file that exists but does
 * not parse fails that vendor closed (a half-read model list would silently shrink the
 * provider). Entry-level problems only skip the entry. Every problem must be *reported* —
 * this package exists because silent config failures are the norm in `models.json`.
 */
const files = await loadTs("extensions/custom-providers/provider-files.ts");
const root = agentPath("custom-providers");
const vendorDir = (id) => agentPath("custom-providers", id);
const write = (dir, name, contents) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(`${dir}/${name}`, typeof contents === "string" ? contents : JSON.stringify(contents, null, "\t"));
};
const reset = (modelsJson = {}) => {
	writeFileSync(agentPath("models.json"), JSON.stringify(modelsJson));
};

const provider = (extra = {}) => ({ api: "openai-completions", baseUrl: "https://demo.example/v1", modelsPath: "/models", ...extra });

// --- scanning -------------------------------------------------------------------
write(vendorDir("demo"), "provider.json", provider());
mkdirSync(agentPath("custom-providers", "not-a-vendor"), { recursive: true });
writeFileSync(agentPath("custom-providers", "not-a-vendor", "readme.txt"), "hi");
writeFileSync(agentPath("custom-providers", "loose-file.json"), "{}");
const scan = files.scanProviderRoot(root);
assert(scan.dirs.join(",") === "demo", `only directories with a parseable provider.json are vendors (got ${scan.dirs.join(",")})`);
assert(scan.ignored.join(",") === "not-a-vendor", `other directories are ignored, and listed (got ${scan.ignored.join(",")})`);

// --- validation, entry by entry --------------------------------------------------
const loaded = files.loadDirectory(root, "demo");
assert(loaded.loadable && !loaded.fatal, "a valid provider.json loads");
assert(loaded.declaration.api === "openai-completions" && loaded.declaration.modelsPath === "/models", "the declaration is read in pi's vocabulary");

write(vendorDir("demo"), "provider.json", provider({ apiKey: "$SECRET", compat: { supportsStore: false }, oauth: "radius", nonsense: 1 }));
const noisy = files.loadDirectory(root, "demo");
const messages = noisy.issues.map((issue) => issue.message).join(" | ");
assert(messages.includes('"apiKey" belongs in accounts.json'), `a credential in provider.json is reported (got: ${messages})`);
assert(messages.includes('"compat" belongs on model entries'), "a compat block in provider.json is reported");
assert(messages.includes('"oauth" is not supported'), "a JSON-inexpressible key is reported");
assert(messages.includes('unknown key "nonsense"'), "an unknown key is reported");
assert(noisy.loadable, "none of those is fatal: they are ignored keys");

write(vendorDir("demo"), "provider.json", provider({ api: "openai" }));
assert(files.loadDirectory(root, "demo").declaration.api === "openai-completions", "an api alias is normalized at load time");
write(vendorDir("demo"), "provider.json", provider({ api: "gpt-4" }));
assert(!files.loadDirectory(root, "demo").loadable, "an api pi cannot stream makes the directory not a vendor");
write(vendorDir("demo"), "provider.json", provider({ baseUrl: undefined }));
assert(files.loadDirectory(root, "demo").fatal, "a missing baseUrl is fatal");
write(vendorDir("demo"), "provider.json", "{ not json");
assert(files.loadDirectory(root, "demo").fatal, "malformed provider.json is fatal");
write(vendorDir("demo"), "provider.json", provider({ apis: { "anthropic-messages": { baseUrl: "https://demo.example/anthropic" }, "openai-completions": { baseUrl: "https://dupe.example" }, "anthropic": { baseUrl: "https://alias.example" }, bogus: { baseUrl: "https://x.example" }, "openai-responses": {} } }));
const apis = files.loadDirectory(root, "demo");
assert(apis.declaration.apis["anthropic-messages"].baseUrl === "https://demo.example/anthropic", "a second protocol endpoint is declared by api id");
const apiIssues = apis.issues.map((issue) => issue.message).join(" | ");
assert(apiIssues.includes("openai-completions: already the default endpoint"), `an apis entry that repeats the default protocol is ignored and reported (got: ${apiIssues})`);
assert(apiIssues.includes("unsupported api"), "an unknown api key under apis is reported");
assert(apiIssues.includes("apis.anthropic-messages: already declared"), `two spellings of one protocol do not silently overwrite each other (got: ${apiIssues})`);
assert(apiIssues.includes('apis.openai-responses: "baseUrl" is required'), "an apis entry without baseUrl is reported");
assert(apis.declaration.apis["openai-responses"] === undefined, "and is not declared");

// --- models.json: fatal vs entry-level -------------------------------------------
write(vendorDir("demo"), "provider.json", provider());
write(vendorDir("demo"), "models.json", "{ not json");
assert(files.loadDirectory(root, "demo").fatal, "models.json that does not parse fails the vendor closed");
write(vendorDir("demo"), "models.json", { models: [{ id: "a", contextWindow: 1000, maxTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, { name: "no id" }, { id: "b", typo: true }] });
const models = files.loadDirectory(root, "demo");
assert(models.models.map((model) => model.id).join(",") === "a,b", "an entry without an id is skipped, the others survive");
assert(models.issues.map((issue) => issue.message).join(" | ").includes('b: unknown key "typo"'), "an unknown model key is reported");
assert(!models.fatal, "entry-level problems do not fail the vendor");
write(vendorDir("demo"), "models.json", [{ id: "bare-array" }]);
assert(files.loadDirectory(root, "demo").models[0].id === "bare-array", "a bare array is accepted as the shorthand form");

// --- what pi actually receives ---------------------------------------------------
reset();
write(vendorDir("demo"), "models.json", { models: [{ id: "demo-model", contextWindow: 4096, maxTokens: 512, reasoning: true, api: "anthropic-messages", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
write(vendorDir("demo"), "provider.json", provider({ apis: { "anthropic-messages": { baseUrl: "https://demo.example/anthropic" } } }));
const ext = await startExtension();
const demo = ext.providers.get("demo");
assert(demo?.models.length === 1, "a directory vendor registers as its own provider");
assert(demo.models[0].api === "anthropic-messages" && demo.models[0].baseUrl === "https://demo.example/anthropic", "the model's api selects the declared endpoint");
assert(demo.api === "openai-completions" && demo.baseUrl === "https://demo.example/v1", "the provider keeps the default endpoint");

// A models.json patch is a patch: unnamed fields keep the base value (pi's own semantics).
reset({ providers: { demo: { models: [{ id: "demo-model", maxTokens: 4096 }] } } });
const patched = (await startExtension()).providers.get("demo").models[0];
assert(patched.maxTokens === 4096 && patched.contextWindow === 4096, "the user patch overrides one field and keeps the rest of the base entry");

// --- takeover boundary ------------------------------------------------------------
// `anthropic` is a pi built-in provider id: a directory may only claim it explicitly.
reset();
write(vendorDir("anthropic"), "provider.json", provider({ baseUrl: "https://proxy.example/v1" }));
const blocked = await startExtension();
await blocked.sessionStart();
assert(!blocked.providers.has("anthropic"), "a pi built-in id is not taken over without override");
assert(!blocked.providers.has("proxy.example"), "and the directory does not register under another id");
assert(blocked.notifications.map((entry) => entry.message).join(" | ").includes('set "override": true'), "the takeover refusal is reported with the fix");

write(vendorDir("anthropic"), "provider.json", provider({ baseUrl: "https://proxy.example/v1", override: true }));
const overridden = await startExtension();
assert(overridden.providers.get("anthropic").baseUrl === "https://proxy.example/v1", "override: true lets a directory replace a pi built-in provider");

// A declared user provider is the user's own layer, not a takeover target.
reset({ providers: { "my-relay": { baseUrl: "https://mine.example/v1", api: "openai-completions" } } });
write(vendorDir("my-relay"), "provider.json", provider({ baseUrl: "https://proxy.example/v1" }));
const userLayer = (await startExtension()).providers.get("my-relay");
assert(userLayer !== undefined, "an id the user declared in models.json needs no override");
assert(userLayer.baseUrl === "https://mine.example/v1", `the user layer (3) redirects the default endpoint over the directory definition (2) (got ${userLayer.baseUrl})`);

// A directory named after another vendor's alias would fight for the same configuration.
reset();
write(vendorDir("codecommand"), "provider.json", provider());
const collided = await startExtension();
await collided.sessionStart();
assert(!collided.providers.has("codecommand"), "a directory colliding with an alias of a built-in vendor is skipped");
assert(collided.notifications.map((entry) => entry.message).join(" | ").includes("collides with an alias"), "and the collision is reported");

// A built-in vendor's directory overrides its definition, keeping the built-in endpoints.
reset();
write(vendorDir("scnet"), "provider.json", provider({ baseUrl: "https://mirror.example/v1", modelsPath: "/models" }));
const mirrored = await startExtension();
assert(mirrored.providers.get("scnet").baseUrl === "https://mirror.example/v1", "a directory replaces the built-in default endpoint");
assert(mirrored.providers.get("scnet").models.length === 19, "and keeps the built-in model table when it declares none");
assert(mirrored.providers.get("scnet").models.some((model) => model.api === "anthropic-messages") === false, "the built-in endpoints still serve the models");


// --- the commands that read this layer -------------------------------------------
reset();
write(vendorDir("demo"), "provider.json", provider({ apis: { "anthropic-messages": { baseUrl: "https://demo.example/anthropic" } } }));
write(vendorDir("demo"), "models.json", { models: [{ id: "demo-model", api: "anthropic-messages" }] });
write(vendorDir("demo"), "accounts.json", { default: "main", main: { apiKey: "$DEMO_KEY" }, work: { apiKey: "$WORK_KEY" } });
mkdirSync(agentPath("custom-providers", "junk-dir"), { recursive: true });
const ui = await startExtension();
const notify = [];
const run = (args) => ui.commands.get("custom-providers").handler(args, { hasUI: true, ui: { notify: (message) => notify.push(message) } });

await run("files");
const filesOut = notify.at(-1);
assert(filesOut.includes("demo [directory]"), `\`files\` lists the vendor and its origin (got ${filesOut})`);
assert(filesOut.includes("accounts=main,work"), "and its accounts");
assert(filesOut.includes("ignored dirs: junk-dir"), "and the directories it did not read");

await run("demo");
const detail = notify.at(-1);
assert(detail.startsWith("demo:"), `\`<id>\` reports that provider (got ${detail})`);
assert(detail.includes("apis: anthropic-messages 1"), "with the per-protocol model split");
assert(detail.includes("accounts: main, work"), "and the account ids");

await run("nope");
assert(notify.at(-1).includes('Unknown provider "nope"') && notify.at(-1).includes("demo"), `an unknown id is reported with the known ones (got ${notify.at(-1)})`);

await run("drift");
assert(typeof notify.at(-1) === "string" && notify.at(-1).length > 0, "`drift` answers with one line");

console.log(`files: ${filesOut}`);
console.log(`detail: ${detail}`);

console.log(`scan: vendors=${scan.dirs.join(",")} ignored=${scan.ignored.join(",")}`);
console.log(`providers: ${[...ext.providers.keys()].join(", ")}`);
console.log("OK");
