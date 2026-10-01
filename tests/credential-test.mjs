import { mkdirSync, writeFileSync } from "node:fs";
import { agentPath, assert, PI, startExtension, testModel, withFetch } from "./harness.mjs";

/**
 * Which credential this package's own discovery probe sends, and in what shape.
 *
 * pi exports no way to ask "which credential would you use for this provider?", so the answer is
 * ours, and it lives in `credentials.ts` (`discoveryCredential`): pi's order — a credential pi
 * stored, the one pi is offering this session, the account's, the provider layer of pi's global
 * `models.json`, then the shipped default account's variable. The *shape* is pi's too: an
 * `anthropic-messages` endpoint authenticates with `x-api-key`, and `authHeader: true` adds
 * `Authorization: Bearer` on top of the api's own default — that is what pi's `withConfiguredAuth`
 * sends for the real request. A probe that picks the shape itself can disagree with the chat
 * request it is discovering for, which is exactly what this file pins down — and both halves of
 * that shape are asserted against their owners, not against a comment: whether `authHeader` adds
 * the bearer header is pi's own `composeModelProvider`, and the api's default header for
 * `anthropic-messages` is the Anthropic SDK's request the model will really make.
 */
const dir = agentPath("custom-providers", "demo");
mkdirSync(dir, { recursive: true });
process.env.DEMO_KEY = "account-key";
process.env.LAYER_KEY = "layer-key";
const providerFile = {
	name: "Demo",
	api: "openai-completions",
	baseUrl: "https://demo.example/v1",
	modelsPath: "/models",
	apis: { "anthropic-messages": { baseUrl: "https://demo.example/anthropic", modelsPath: "/models" } },
};
const writeVendor = (accounts, layer = {}) => {
	writeFileSync(`${dir}/provider.json`, JSON.stringify(providerFile));
	writeFileSync(`${dir}/models.json`, JSON.stringify({ models: [testModel("keep")] }));
	writeFileSync(`${dir}/accounts.json`, JSON.stringify(accounts));
	writeFileSync(agentPath("models.json"), JSON.stringify(layer));
};

/** Probe every endpoint once; returns a lookup from a URL fragment to the headers it was sent. */
const probeHeaders = async (refresh, credential) => {
	const seen = [];
	await withFetch(
		async (url, init) => {
			seen.push({ url: String(url), headers: init?.headers ?? {} });
			return { ok: true, json: async () => ({ data: [{ id: "keep" }] }) };
		},
		() => refresh({ allowNetwork: true, signal: new AbortController().signal, ...(credential ? { credential } : {}) }),
	);
	return (fragment) => seen.find((request) => request.url.includes(fragment))?.headers ?? {};
};

// --- the shape: per protocol, plus the bearer header when the provider asked for it ---------
writeVendor({ default: "main", main: { apiKey: "$DEMO_KEY" } });
let ext = await startExtension();
let headers = await probeHeaders(ext.providers.get("demo").refreshModels, undefined);
assert(headers("/v1/models").Authorization === "Bearer account-key", `an openai endpoint authenticates with the bearer header (got ${JSON.stringify(headers("/v1/models"))})`);
assert(headers("/anthropic")["x-api-key"] === "account-key" && headers("/anthropic")["anthropic-version"] === "2023-06-01", `an anthropic endpoint authenticates with x-api-key (got ${JSON.stringify(headers("/anthropic"))})`);
assert(!("Authorization" in headers("/anthropic")), "and not with the bearer header until something asks for it");

writeVendor({ default: "main", main: { apiKey: "$DEMO_KEY", authHeader: true } });
ext = await startExtension();
headers = await probeHeaders(ext.providers.get("demo").refreshModels, undefined);
assert(headers("/anthropic").Authorization === "Bearer account-key", `authHeader: true adds the bearer header to an anthropic probe (got ${JSON.stringify(headers("/anthropic"))})`);
assert(headers("/anthropic")["x-api-key"] === "account-key", "without dropping the api's own header — that is what pi sends, too");

// --- the shape is pi's, not ours: pi's composer, and the SDK pi-ai hands the key to --------
// `withConfiguredAuth` is not exported, but `composeModelProvider` is and it calls it, so the
// registration payload this package hands pi can be run through pi's own composition. The api's
// own default header is decided by the Anthropic SDK (pi-ai builds the client with the resolved
// key), so that half is taken from the SDK's real request — captured through an injected fetch,
// which also means the assertion cannot drift with a comment.
const { composeModelProvider } = await import(`${PI}/dist/core/provider-composer.js`);
const anthropicSdk = await import(`${PI}/node_modules/@anthropic-ai/sdk/index.js`);
const piAuth = async (payload) => {
	// Only `getProvider` (pi's global models.json layer — empty here) and the base provider's
	// model list are read; the auth shape comes from the payload, which is the thing under test.
	const composed = composeModelProvider("demo", { id: "demo", getModels: () => [], auth: {} }, { getProvider: () => undefined }, payload);
	return composed.auth.apiKey.resolve({ ctx: { env: async (name) => (name === "DEMO_KEY" ? "account-key" : undefined) } });
};

writeVendor({ default: "main", main: { apiKey: "$DEMO_KEY", authHeader: true } });
ext = await startExtension();
headers = await probeHeaders(ext.providers.get("demo").refreshModels, undefined);
const piWithAuth = await piAuth(ext.providers.get("demo"));
assert(piWithAuth.auth.headers.Authorization === `Bearer ${piWithAuth.auth.apiKey}`, `test premise: pi's composer adds the bearer header (got ${JSON.stringify(piWithAuth.auth.headers)})`);
assert(
	headers("/anthropic").Authorization === piWithAuth.auth.headers.Authorization,
	`the anthropic probe sends the bearer header pi composes (probe ${headers("/anthropic").Authorization} vs pi ${piWithAuth.auth.headers.Authorization})`,
);
assert(headers("/anthropic")["x-api-key"] === piWithAuth.auth.apiKey, `and the key pi resolved from our payload (probe ${headers("/anthropic")["x-api-key"]} vs pi ${piWithAuth.auth.apiKey})`);

writeVendor({ default: "main", main: { apiKey: "$DEMO_KEY" } });
ext = await startExtension();
headers = await probeHeaders(ext.providers.get("demo").refreshModels, undefined);
const piWithoutAuth = await piAuth(ext.providers.get("demo"));
assert(piWithoutAuth.auth.headers === undefined, `test premise: with no authHeader pi composes no extra headers (got ${JSON.stringify(piWithoutAuth.auth.headers)})`);
assert(!("Authorization" in headers("/anthropic")), "and the probe sends none either — the bearer header is pi's decision, not ours");

// The api's own default, from the SDK request pi-ai makes for an `anthropic-messages` model.
const sdkSent = [];
const sdkClient = new anthropicSdk.Anthropic({
	apiKey: "account-key",
	baseURL: "https://demo.example/anthropic",
	maxRetries: 0,
	fetch: (url, init) => {
		sdkSent.push(Object.fromEntries(new Headers(init?.headers ?? {}).entries()));
		return Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
	},
});
await sdkClient.messages.create({ model: "keep", max_tokens: 1, messages: [{ role: "user", content: "x" }] }).catch(() => {});
assert(sdkSent.length === 1, `the Anthropic SDK request was captured (got ${sdkSent.length})`);
assert(sdkSent[0]["x-api-key"] === headers("/anthropic")["x-api-key"], `the probe's header name and key are the SDK's (SDK ${sdkSent[0]["x-api-key"]} vs probe ${headers("/anthropic")["x-api-key"]})`);
assert(
	sdkSent[0]["anthropic-version"] === headers("/anthropic")["anthropic-version"],
	`and so is the api version it sends (SDK ${sdkSent[0]["anthropic-version"]} vs probe ${headers("/anthropic")["anthropic-version"]})`,
);
assert(!("authorization" in sdkSent[0]), "the SDK sends no bearer header of its own, so that header can only come from pi's composer");

// --- the order: this session's credential, the account, the provider layer -------------------
writeVendor({ default: "main", main: { apiKey: "$DEMO_KEY" } }, { providers: { demo: { apiKey: "$LAYER_KEY" } } });
ext = await startExtension();
headers = await probeHeaders(ext.providers.get("demo").refreshModels, { type: "api_key", key: "session-key" });
assert(headers("/v1/models").Authorization === "Bearer session-key", "the credential pi is offering this session wins over the file's");
headers = await probeHeaders(ext.providers.get("demo").refreshModels, undefined);
assert(headers("/v1/models").Authorization === "Bearer account-key", "and without one, the account wins over the provider layer");

writeVendor({}, { providers: { demo: { apiKey: "$LAYER_KEY" } } });
ext = await startExtension();
headers = await probeHeaders(ext.providers.get("demo").refreshModels, undefined);
assert(headers("/v1/models").Authorization === "Bearer layer-key", "with no account, the provider layer of pi's models.json is used");

// --- nothing anywhere: no request, and the report says where a key can be put ----------------
writeVendor({});
ext = await startExtension();
headers = await probeHeaders(ext.providers.get("demo").refreshModels, undefined);
assert(Object.keys(headers("/v1/models")).length === 0 && Object.keys(headers("/anthropic")).length === 0, "with no credential anywhere no probe is sent");

console.log("discovery credential: protocol shape (vs pi's composer + the Anthropic SDK), authHeader bearer, session → account → layer");
console.log("OK");
