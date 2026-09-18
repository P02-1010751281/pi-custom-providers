import { writeFileSync } from "node:fs";
import { agentPath, assert, loadTs, loader, startExtension } from "./harness.mjs";

/**
 * Protocol (api) selection — design §5.
 *
 * pi's model shape is `model.api ?? provider.api`, and `ModelDefinitionSchema` allows a
 * per-model `api` + `baseUrl`, so choosing a protocol per model needs no invention of ours.
 * What does need doing: keeping a model on the *default* protocol free of `api`/`baseUrl`
 * (so `providers.<id>.baseUrl` can still redirect it), stamping both on a model that is not,
 * and rejecting an api pi cannot stream.
 */
const cfg = await loadTs("extensions/custom-providers/config.ts");
const { SOURCES } = await loadTs("extensions/custom-providers/sources.ts");
const compat = await (await loader()).import("@earendil-works/pi-ai");

const SCNet = SOURCES.find((vendor) => vendor.id === "scnet");
const SCNetAnthropic = SCNet.declaration.apis["anthropic-messages"].baseUrl;
const CommandCodeAnthropic = SOURCES.find((vendor) => vendor.id === "commandcode").declaration.apis["anthropic-messages"].baseUrl;

// --- the built-in api vocabulary ----------------------------------------------
// `BUILTIN_APIS` is a private const in pi, so our copy is asserted against the registry pi
// actually populates: a pi build that adds or drops a protocol must fail here.
const registered = new Set(compat.getApiProviders().map((provider) => provider.api));
for (const api of cfg.BUILTIN_APIS) assert(registered.has(api), `pi registers the built-in api "${api}"`);
assert(registered.size === cfg.BUILTIN_APIS.length, `our api list matches pi's registry (${registered.size} vs ${cfg.BUILTIN_APIS.length})`);

assert(cfg.normalizeApi("anthropic") === "anthropic-messages", "the short name maps to pi's id");
assert(cfg.normalizeApi("Chat") === "openai-completions", "aliases are case-insensitive");
assert(cfg.normalizeApi("responses") === "openai-responses", "responses is an alias");
assert(cfg.normalizeApi("openai-completions") === "openai-completions", "a pi id passes through");
assert(cfg.normalizeApi("bogus") === undefined, "an unknown protocol is rejected instead of passed to pi");
assert(cfg.normalizeApi(7) === undefined && cfg.normalizeApi("") === undefined, "non-strings are rejected");

const declaration = { api: "openai-completions", baseUrl: "https://a.example/v1", apis: { "anthropic-messages": { baseUrl: "https://a.example/anthropic" } } };
assert(cfg.resolveModelEndpoint(declaration, {}, { id: "m" }).stampApi === false, "a model without api stays on the default protocol");
assert(cfg.resolveModelEndpoint(declaration, {}, { id: "m" }).stampBaseUrl === false, "and carries no baseUrl, so providers.<id>.baseUrl can still redirect it");
const moved = cfg.resolveModelEndpoint(declaration, {}, { id: "m", api: "anthropic" });
assert(moved.endpoint.api === "anthropic-messages" && moved.endpoint.baseUrl === "https://a.example/anthropic", "a model api picks its declared endpoint");
assert(moved.stampApi && moved.stampBaseUrl, "a moved model is stamped with api + baseUrl (pi would otherwise use the provider's protocol)");
const own = cfg.resolveModelEndpoint(declaration, {}, { id: "m", api: "openai-responses", baseUrl: "https://b.example" });
assert(own.endpoint.api === "openai-responses" && own.stampBaseUrl, "an undeclared protocol is allowed when the model has its own baseUrl");
const stranded = cfg.resolveModelEndpoint(declaration, {}, { id: "m", api: "google-generative-ai" });
assert(stranded.endpoint.api === "openai-completions" && stranded.issues.length === 1, "an undeclared protocol without a baseUrl falls back to the default and is reported");
assert(cfg.resolveModelEndpoint(declaration, {}, { id: "m", api: "nope" }).issues.length === 1, "an invalid api is reported");
const flipped = cfg.resolveModelEndpoint(declaration, { api: "anthropic" }, { id: "m" });
assert(flipped.endpoint.api === "anthropic-messages" && flipped.stampApi === false, "providers.<id>.api flips the default protocol without stamping models");

// --- registration: the SCNet vendor keeps both endpoints reachable --------------
writeFileSync(agentPath("models.json"), "{}");
const plain = await startExtension();
assert([...plain.providers.keys()].join(",") === "commandcode,scnet", `one provider per vendor (got ${[...plain.providers.keys()].join(",")})`);
const scnet = plain.providers.get("scnet");
assert(scnet.api === "openai-completions" && scnet.baseUrl === SCNet.declaration.baseUrl, "the provider keeps its default protocol + endpoint");
assert(scnet.models.length === 19, `the vendor's model list is the union of both endpoints (got ${scnet.models.length})`);
assert(scnet.models.every((model) => model.api === undefined), "without configuration no SCNet model carries an api (they are all on the default endpoint)");
assert(scnet.models.every((model) => model.baseUrl === undefined), "and none carries a baseUrl");
assert(scnet.models.every((model) => model.cost && typeof model.cost.input === "number"), "every model carries cost");
assert(plain.providers.get("commandcode").models.find((model) => model.id === "claude-sonnet-5").baseUrl === CommandCodeAnthropic, "a model whose default endpoint cannot serve it is pointed at the declared endpoint");

// --- moving one model to the vendor's second protocol endpoint -----------------
writeFileSync(agentPath("models.json"), JSON.stringify({ providers: { scnet: { models: [{ id: "GLM-5.2", api: "anthropic-messages" }] } } }));
const perModel = await startExtension();
const models = perModel.providers.get("scnet").models;
const glm = models.find((model) => model.id === "GLM-5.2");
assert(glm.api === "anthropic-messages", "the model's own api moves it to that endpoint");
assert(glm.baseUrl === SCNetAnthropic, `the moved model is stamped with the endpoint's baseUrl (got ${glm.baseUrl})`);
assert(glm.name.endsWith("(anthropic-messages)"), `a multi-endpoint vendor labels the protocol in the display name (got ${glm.name})`);
assert(glm.contextWindow === 1000000 && glm.maxTokens === 131072, "moving a model keeps the base table's parameters (the patch is per field)");
assert(models.filter((model) => model.id === "GLM-5.2").length === 1, "the same id is not registered twice");
assert(models.filter((model) => model.id !== "GLM-5.2").every((model) => model.baseUrl === undefined), "no other model is touched");
assert(perModel.providers.get("scnet").baseUrl === SCNet.declaration.baseUrl, "a per-model move does not move the provider's endpoint");

// --- flipping the provider's default protocol ----------------------------------
writeFileSync(agentPath("models.json"), JSON.stringify({ providers: { scnet: { api: "anthropic-messages" } } }));
const wholeVendor = await startExtension();
assert(wholeVendor.providers.get("scnet").api === "anthropic-messages", "providers.<id>.api flips the provider's protocol");
assert(wholeVendor.providers.get("scnet").baseUrl === SCNetAnthropic, "and the provider is pointed at that protocol's declared endpoint");
assert(wholeVendor.providers.get("scnet").models.every((model) => model.api === undefined), "models on the (new) default protocol carry no api of their own");

// --- an unknown protocol is reported, never handed to pi -----------------------
writeFileSync(agentPath("models.json"), JSON.stringify({ providers: { scnet: { api: "anthropick" } } }));
const typo = await startExtension();
await typo.sessionStart();
const report = typo.notifications.map((entry) => entry.message).join(" | ");
assert(typo.providers.get("scnet").api === "openai-completions", "a misspelled provider api keeps the declared default");
assert(report.includes("anthropick"), `a misspelled provider api is reported (got: ${report})`);

// --- the alias key still configures the renamed provider ------------------------
writeFileSync(agentPath("models.json"), JSON.stringify({ providers: { codecommand: { models: [{ id: "claude-opus-5", maxTokens: 1234 }] } } }));
const aliased = await startExtension();
const opus = aliased.providers.get("commandcode").models.find((model) => model.id === "claude-opus-5");
assert(opus?.maxTokens === 1234, "the pre-rename `providers.codecommand` block still configures commandcode");

console.log(`apis: ${cfg.BUILTIN_APIS.join(", ")}`);
console.log(`scnet endpoints: ${SCNet.declaration.api} ${SCNet.declaration.baseUrl} | anthropic-messages ${SCNetAnthropic}`);
console.log("OK");
