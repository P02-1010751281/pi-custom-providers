import { mkdirSync, writeFileSync } from "node:fs";
import { agentPath, assert, loader, startExtension } from "./harness.mjs";

/**
 * `openai-responses` is a first-class pi-ai protocol and one of the ten in the vocabulary, so
 * a model that declares it must end up on `<baseUrl>/responses` — the SDK appends that path
 * itself and does *not* add `/v1`. This drives pi's own implementation for that protocol with
 * a recording fetch: what the extension stamps on the model is what the request is made of.
 */
const compat = await (await loader()).import("@earendil-works/pi-ai");
const vendorDir = agentPath("custom-providers", "responses-demo");
mkdirSync(vendorDir, { recursive: true });
writeFileSync(agentPath("models.json"), "{}");
writeFileSync(`${vendorDir}/provider.json`, JSON.stringify({
	api: "openai-completions",
	baseUrl: "https://demo.example/v1",
	modelsPath: "/models",
	apis: { "openai-responses": { baseUrl: "https://demo.example" } },
}));
writeFileSync(`${vendorDir}/models.json`, JSON.stringify({
	models: [
		{ id: "plain", contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		{ id: "responses-only", api: "openai-responses", contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
	],
}));

const ext = await startExtension();
const provider = ext.providers.get("responses-demo");
const model = provider.models.find((entry) => entry.id === "responses-only");
assert(provider.api === "openai-completions", "the provider keeps its default protocol");
assert(model.api === "openai-responses", "the model's api selects the declared protocol");
assert(model.baseUrl === "https://demo.example", `and the declared endpoint (got ${model.baseUrl})`);
assert(model.name.includes("(openai-responses)"), `a multi-endpoint vendor labels the protocol (got ${model.name})`);
assert(provider.models.find((entry) => entry.id === "plain").baseUrl === undefined, "the other model keeps the provider's default endpoint");

// Drive pi-ai's own implementation for that protocol and watch the request it makes.
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	calls.push({ url: String(url), method: init?.method, body: String(init?.body ?? "") });
	return new Response("event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"test stub\"}}\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
};
try {
	const api = compat.getApiProvider("openai-responses");
	assert(api !== undefined, "pi registers an implementation for openai-responses");
	// The stream itself is expected to fail against the stub — what matters is the request.
	// `streamSimple` can hand back a promise or a stream depending on the implementation, so
	// both shapes are drained here.
	const result = api.streamSimple(
		{ ...model, provider: provider.name, baseUrl: model.baseUrl },
		{ messages: [{ role: "user", content: "hello" }] },
		{ apiKey: "test-key" },
	);
	if (result && typeof result[Symbol.asyncIterator] === "function") {
		for await (const _chunk of result) void _chunk;
	} else if (typeof result?.then === "function") {
		await result;
	}
} finally {
	globalThis.fetch = realFetch;
}
assert(calls.length === 1, `exactly one request is made (got ${calls.length})`);
assert(calls[0].url === "https://demo.example/responses", `the request goes to <baseUrl>/responses (got ${calls[0].url})`);
assert(calls[0].method === "POST", "as a POST");
assert(calls[0].body.includes('"model":"responses-only"'), `the body carries the model id (got ${calls[0].body.slice(0, 120)})`);

console.log(`request: ${calls[0].method} ${calls[0].url}`);
console.log("OK");
