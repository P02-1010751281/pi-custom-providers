import { mkdirSync, writeFileSync } from "node:fs";
import { agentPath, assert, startExtension, testModel, withFetch } from "./harness.mjs";

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
 * request it is discovering for, which is exactly what this file pins down.
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

console.log("discovery credential: protocol shape, authHeader bearer, session → account → layer");
console.log("OK");
