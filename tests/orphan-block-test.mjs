/**
 * `providers.<key>` blocks for ids nothing here answers to (design §10 #18, the reporting half of
 * the B′ drift fix): pi owns the `providers` map and registers such an id itself, while this
 * package has no directory behind it — so the block is configured but inert, and saying so is the
 * only way its author learns it stopped being read. Reported, never dropped silently.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { agentPath, assert, runCommand, seedDefaultProviders, startExtension, TEST_VENDORS } from "./harness.mjs";

/** `demo` + its two accounts (so `demo-work` is an id this package does register). */
mkdirSync(agentPath("custom-providers", "demo"), { recursive: true });
writeFileSync(agentPath("custom-providers", "demo", "provider.json"), JSON.stringify({ name: "demo", ...TEST_VENDORS.scnet.declaration }));
writeFileSync(agentPath("custom-providers", "demo", "accounts.json"), JSON.stringify({ default: "main", main: { apiKey: "$DEMO_KEY" }, work: { apiKey: "$DEMO_KEY" } }));
await seedDefaultProviders("commandcode");

writeFileSync(
	agentPath("models.json"),
	JSON.stringify({
		providers: {
			// Read: a registered directory id, and the id of an account under it.
			demo: { headers: { "x-demo": "1" } },
			"demo-work": { baseUrl: "https://demo.example/work" },
			// Not ours: pi configures its own built-in provider through the same map.
			anthropic: { headers: { "x-own": "1" } },
			// Inert: a vendor's former key, and a typo.
			codecommand: { models: [] },
			scnettt: {},
		},
	}),
);

const ext = await startExtension();
const notify = [];
await runCommand(ext.commands, "", notify);
const status = notify.at(-1) ?? "";

assert(ext.providers.has("demo") && ext.providers.has("demo-work"), "the two directory-backed ids register from their own files");
assert(status.includes("providers.codecommand: no directory for this id"), `a former key is reported (got ${status})`);
assert(status.includes("providers.scnettt: no directory for this id"), `a typo is reported too (got ${status})`);
assert(!status.includes("providers.demo: no directory"), "a registered id is not reported");
assert(!status.includes("providers.demo-work: no directory"), "an account id this package registers is not reported");
assert(!status.includes("providers.anthropic: no directory"), "a pi built-in id is not reported (pi configures its own provider)");

console.log("OK");
