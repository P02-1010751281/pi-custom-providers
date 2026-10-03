import { writeFileSync } from "node:fs";
import { agentPath, assert, FIXTURE_MODELS, loadTs, loader, seedDefaultProviders, startExtension, TEST_VENDORS } from "./harness.mjs";

/**
 * Protocol (api) selection — design §5.
 *
 * pi's model shape is `model.api ?? provider.api`, and `ModelDefinitionSchema` allows a
 * per-model `api` + `baseUrl`, so choosing a protocol per model needs no invention of ours.
 * What does need doing: keeping a model on the *default* protocol free of `api`/`baseUrl`
 * (so `providers.<id>.baseUrl` can still redirect it), stamping both on a model that is not,
 * and rejecting an api pi cannot stream.
 */
const apis = await loadTs("extensions/custom-providers/apis.ts");
const { resolveModelEndpoint } = await loadTs("extensions/custom-providers/endpoints.ts");
const compat = await (await loader()).import("@earendil-works/pi-ai");

const SCNet = TEST_VENDORS.scnet;
const SCNetAnthropic = SCNet.declaration.apis["anthropic-messages"].baseUrl;
const anthropicMessagesBaseUrl = TEST_VENDORS.commandcode.declaration.apis["anthropic-messages"].baseUrl;

// --- the built-in api vocabulary ----------------------------------------------
// `BUILTIN_APIS` is a private const in pi, so our copy is asserted against the registry pi
// actually populates: a pi build that adds or drops a protocol must fail here.
const registered = new Set(compat.getApiProviders().map((provider) => provider.api));
for (const api of apis.BUILTIN_APIS) assert(registered.has(api), `pi registers the built-in api "${api}"`);
assert(registered.size === apis.BUILTIN_APIS.length, `our api list matches pi's registry (${registered.size} vs ${apis.BUILTIN_APIS.length})`);

assert(apis.normalizeApi("anthropic") === "anthropic-messages", "the short name maps to pi's id");
assert(apis.normalizeApi("Chat") === "openai-completions", "aliases are case-insensitive");
assert(apis.normalizeApi("responses") === "openai-responses", "responses is an alias");
assert(apis.normalizeApi("openai-completions") === "openai-completions", "a pi id passes through");
assert(apis.normalizeApi("bogus") === undefined, "an unknown protocol is rejected instead of passed to pi");
assert(apis.normalizeApi(7) === undefined && apis.normalizeApi("") === undefined, "non-strings are rejected");

const declaration = { api: "openai-completions", baseUrl: "https://a.example/v1", apis: { "anthropic-messages": { baseUrl: "https://a.example/anthropic" } } };
assert(resolveModelEndpoint(declaration, {}, { id: "m" }).stampApi === false, "a model without api stays on the default protocol");
assert(resolveModelEndpoint(declaration, {}, { id: "m" }).stampBaseUrl === false, "and carries no baseUrl, so providers.<id>.baseUrl can still redirect it");
const moved = resolveModelEndpoint(declaration, {}, { id: "m", api: "anthropic" });
assert(moved.endpoint.api === "anthropic-messages" && moved.endpoint.baseUrl === "https://a.example/anthropic", "a model api picks its declared endpoint");
assert(moved.stampApi && moved.stampBaseUrl, "a moved model is stamped with api + baseUrl (pi would otherwise use the provider's protocol)");
const own = resolveModelEndpoint(declaration, {}, { id: "m", api: "openai-responses", baseUrl: "https://b.example" });
assert(own.endpoint.api === "openai-responses" && own.stampBaseUrl, "an undeclared protocol is allowed when the model has its own baseUrl");
const stranded = resolveModelEndpoint(declaration, {}, { id: "m", api: "google-generative-ai" });
assert(stranded.endpoint.api === "openai-completions" && stranded.issues.length === 1, "an undeclared protocol without a baseUrl falls back to the default and is reported");
assert(resolveModelEndpoint(declaration, {}, { id: "m", api: "nope" }).issues.length === 1, "an invalid api is reported");
const flipped = resolveModelEndpoint(declaration, { api: "anthropic" }, { id: "m" });
assert(flipped.endpoint.api === "anthropic-messages" && flipped.stampApi === false, "providers.<id>.api flips the default protocol without stamping models");

// --- registration: the SCNet vendor keeps both endpoints reachable --------------
// An empty `models.json` is not "no config": pi requires the `providers` key and drops the file
// (schema error) when it is missing — so "no config" is written as an empty providers object.
writeFileSync(agentPath("models.json"), JSON.stringify({ providers: {} }));
await seedDefaultProviders();
const plain = await startExtension();
assert([...plain.providers.keys()].join(",") === "commandcode,scnet", `one provider per vendor (got ${[...plain.providers.keys()].join(",")})`);
const scnet = plain.providers.get("scnet");
assert(scnet.api === "openai-completions" && scnet.baseUrl === SCNet.declaration.baseUrl, "the provider keeps its default protocol + endpoint");
assert(scnet.models.length === FIXTURE_MODELS.scnet.length, `the vendor's model list is the union of both endpoints (got ${scnet.models.length})`);
assert(scnet.models.every((model) => model.api === undefined), "without configuration no SCNet model carries an api (they are all on the default endpoint)");
assert(scnet.models.every((model) => model.baseUrl === undefined), "and none carries a baseUrl");
assert(scnet.models.every((model) => model.cost && typeof model.cost.input === "number"), "every model carries cost");
assert(plain.providers.get("commandcode").models.find((model) => model.id === "claude-sonnet-5").baseUrl === anthropicMessagesBaseUrl, "a model whose default endpoint cannot serve it is pointed at the declared endpoint");

// --- moving one model to the vendor's second protocol endpoint -----------------
// The model table is a model's only home, so the endpoint is chosen there: a `<id>/models.json`
// entry carrying `api` moves that model to the matching `apis.<api>` endpoint (the config layer's
// `models[]` is not read).
writeFileSync(agentPath("custom-providers", "scnet", "models.json"), JSON.stringify({ models: FIXTURE_MODELS.scnet.map((model) => (model.id === "GLM-5.2" ? { ...model, api: "anthropic-messages" } : model)) }));
const perModel = await startExtension();
const models = perModel.providers.get("scnet").models;
const glm = models.find((model) => model.id === "GLM-5.2");
assert(glm.api === "anthropic-messages", "the model's own api moves it to that endpoint");
assert(glm.baseUrl === SCNetAnthropic, `the moved model is stamped with the endpoint's baseUrl (got ${glm.baseUrl})`);
assert(glm.name.endsWith("(anthropic-messages)"), `a multi-endpoint vendor labels the protocol in the display name (got ${glm.name})`);
assert(glm.contextWindow === 1000000 && glm.maxTokens === 131072, "moving a model keeps the rest of the table entry's parameters");
assert(models.filter((model) => model.id === "GLM-5.2").length === 1, "the same id is not registered twice");
assert(models.filter((model) => model.id !== "GLM-5.2").every((model) => model.baseUrl === undefined), "no other model is touched");
assert(perModel.providers.get("scnet").baseUrl === SCNet.declaration.baseUrl, "a per-model move does not move the provider's endpoint");

// --- flipping the provider's default protocol ----------------------------------
// Back to the table as seeded: the case above moved one model, this one moves the whole provider.
writeFileSync(agentPath("custom-providers", "scnet", "models.json"), JSON.stringify({ models: FIXTURE_MODELS.scnet }));
writeFileSync(agentPath("models.json"), JSON.stringify({ providers: { scnet: { api: "anthropic-messages", baseUrl: SCNetAnthropic } } }));
const wholeVendor = await startExtension();
assert(wholeVendor.providers.get("scnet").api === "anthropic-messages", "providers.<id>.api flips the provider's protocol");
assert(wholeVendor.providers.get("scnet").baseUrl === SCNetAnthropic, "and the provider is pointed at that protocol's declared endpoint");
assert(wholeVendor.providers.get("scnet").models.every((model) => model.api === undefined), "models on the (new) default protocol carry no api of their own");

// --- a flipped default with only a baseUrl is honoured (no apis.<api> needed) ---
writeFileSync(agentPath("models.json"), JSON.stringify({ providers: { scnet: { api: "openai-responses", baseUrl: "https://mirror.example/responses" } } }));
const flippedWithUrl = await startExtension();
await flippedWithUrl.sessionStart();
assert(flippedWithUrl.providers.has("scnet"), "a flipped default is not refused when the layer supplies its baseUrl");
assert(
	flippedWithUrl.providers.get("scnet").api === "openai-responses" && flippedWithUrl.providers.get("scnet").baseUrl === "https://mirror.example/responses",
	"the flipped protocol uses the layer's endpoint",
);
assert(
	!flippedWithUrl.notifications.map((entry) => entry.message).join(" | ").includes("no endpoint"),
	"a layer baseUrl that satisfies the flip is not reported as a missing endpoint",
);

// --- a flip with no endpoint at all is refused AND reported ---------------------
writeFileSync(agentPath("models.json"), JSON.stringify({ providers: { scnet: { api: "openai-responses" } } }));
const refused = await startExtension();
await refused.sessionStart();
assert(!refused.providers.has("scnet"), "a flipped default with no endpoint is refused");
assert(refused.notifications.map((entry) => entry.message).join(" | ").includes("no endpoint"), "and the refusal is reported instead of dropping the provider silently");

// --- an unknown protocol is reported, never handed to pi -----------------------
writeFileSync(agentPath("models.json"), JSON.stringify({ providers: { scnet: { api: "anthropick", baseUrl: SCNet.declaration.baseUrl } } }));
const typo = await startExtension();
await typo.sessionStart();
const report = typo.notifications.map((entry) => entry.message).join(" | ");
assert(typo.providers.get("scnet").api === "openai-completions", "a misspelled provider api keeps the declared default");
assert(report.includes("anthropick"), `a misspelled provider api is reported (got: ${report})`);

// --- only the registered id is a config layer -----------------------------------
// The layer is read through provider-level fields (`api`/`baseUrl`/`compat`/credentials), not
// through `models[]`, which stays out of the model table either way.
writeFileSync(agentPath("models.json"), JSON.stringify({ providers: { codecommand: { baseUrl: "https://alias.example/v1" } } }));
const aliased = await startExtension();
assert(aliased.providers.get("commandcode").models.some((model) => model.id === "claude-opus-5"), "the vendor's own table still registers its models");
assert(aliased.providers.get("commandcode").baseUrl !== "https://alias.example/v1", "a pre-rename `providers.codecommand` block is not read (pi only resolves the registered id)");

writeFileSync(agentPath("models.json"), JSON.stringify({ providers: { commandcode: { baseUrl: "https://canonical.example/v1" } } }));
const canonical = await startExtension();
assert(canonical.providers.get("commandcode").baseUrl === "https://canonical.example/v1", "the registered id still configures the provider");

console.log(`apis: ${apis.BUILTIN_APIS.join(", ")}`);
console.log(`scnet endpoints: ${SCNet.declaration.api} ${SCNet.declaration.baseUrl} | anthropic-messages ${SCNetAnthropic}`);
console.log("OK");
