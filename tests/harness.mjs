import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Isolate the pi agent dir before anything imports the code under test. Without this,
 * `getAgentDir()` resolves to the developer's real `~/.pi/agent`, so tests would read
 * their `models.json` / `.env` and assert machine-dependent model sets.
 * `PI_CODING_AGENT_DIR` is the variable pi's own getAgentDir() honors.
 */
if (!process.env.PI_CODING_AGENT_DIR) {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-agent-test-"));
}

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The conventional extensions directory pi discovers as a package. */
export const EXT = path.join(REPO_ROOT, "extensions");

/** Locate the installed pi package so tests can reuse its jiti loader and alias map. */
export function findPiPackage() {
	if (process.env.PI_PKG) return process.env.PI_PKG;
	const candidates = [];
	try {
		const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (root) candidates.push(path.join(root, "@earendil-works/pi-coding-agent"));
	} catch {
		// npm may be unavailable; fall through to the known location.
	}
	candidates.push("/home/user/.local/lib/node_modules/@earendil-works/pi-coding-agent");
	for (const candidate of candidates) {
		if (existsSync(path.join(candidate, "dist/index.js"))) return candidate;
	}
	throw new Error("pi package not found; set PI_PKG to its install directory");
}

export const PI = findPiPackage();

// Mirrors pi's own extension loader alias map (dist/core/extensions/loader.js).
// Extensions resolve `@earendil-works/pi-ai` to the compat entry, a strict
// superset of dist/index.js that additionally exports getModels/getModel/getProviders.
// Aliasing to dist/index.js instead would let tests pass on code that cannot run in pi.
const piRequire = createRequire(`${PI}/dist/core/extensions/loader.js`);
const resolveOptional = (specifier) => {
	try {
		return piRequire.resolve(specifier);
	} catch {
		return undefined;
	}
};
const PI_AI = `${PI}/node_modules/@earendil-works/pi-ai/dist`;
const alias = Object.fromEntries(
	Object.entries({
		"@earendil-works/pi-coding-agent": `${PI}/dist/index.js`,
		"@mariozechner/pi-coding-agent": `${PI}/dist/index.js`,
		"@earendil-works/pi-ai": `${PI_AI}/compat.js`,
		"@mariozechner/pi-ai": `${PI_AI}/compat.js`,
		"@earendil-works/pi-ai/compat": `${PI_AI}/compat.js`,
		"@mariozechner/pi-ai/compat": `${PI_AI}/compat.js`,
		"@earendil-works/pi-ai/oauth": `${PI_AI}/oauth.js`,
		"@mariozechner/pi-ai/oauth": `${PI_AI}/oauth.js`,
		"@earendil-works/pi-ai/providers/all": `${PI_AI}/providers/all.js`,
		"@mariozechner/pi-ai/providers/all": `${PI_AI}/providers/all.js`,
		"@earendil-works/pi-agent-core": resolveOptional("@earendil-works/pi-agent-core"),
		"@mariozechner/pi-agent-core": resolveOptional("@earendil-works/pi-agent-core"),
		"@earendil-works/pi-tui": resolveOptional("@earendil-works/pi-tui"),
		"@mariozechner/pi-tui": resolveOptional("@earendil-works/pi-tui"),
		typebox: resolveOptional("typebox"),
		"typebox/compile": resolveOptional("typebox/compile"),
		"typebox/value": resolveOptional("typebox/value"),
		"@sinclair/typebox": resolveOptional("typebox"),
		"@sinclair/typebox/compile": resolveOptional("typebox/compile"),
		"@sinclair/typebox/value": resolveOptional("typebox/value"),
	}).filter(([, target]) => target !== undefined),
);

let jiti;
export async function loader() {
	if (!jiti) {
		const { createJiti } = await import(`${PI}/node_modules/jiti/lib/jiti-static.mjs`);
		jiti = createJiti(`${PI}/dist/core/extensions/loader.js`, { moduleCache: false, alias });
	}
	return jiti;
}

/** Import a TS module (relative path resolved against the repo root). */
export async function loadTs(relativePath) {
	return (await loader()).import(path.resolve(REPO_ROOT, relativePath));
}

export function assert(condition, message) {
	if (!condition) throw new Error(`FAIL: ${message}`);
}

/**
 * Run `fn` with `globalThis.fetch` replaced by `stub`, restoring the real one afterwards.
 * Every test that fakes a wire answer goes through this: a stub left installed would follow
 * the rest of the file (and later `startExtension()` rounds) into the network.
 */
export async function withFetch(stub, fn) {
	const real = globalThis.fetch;
	globalThis.fetch = stub;
	try {
		return await fn();
	} finally {
		globalThis.fetch = real;
	}
}

/**
 * Invoke the `custom-providers` command, collecting its `notify` lines into `sink` (a plain
 * array of message strings — tests assert on the text, never on the level).
 */
export function runCommand(commands, args, sink) {
	return commands.get("custom-providers").handler(args, { hasUI: true, ui: { notify: (message) => sink.push(message) } });
}

/** The temp agent dir every test writes into (`PI_CODING_AGENT_DIR`). */
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

/** Absolute path of a file under the temp agent dir. */
export const agentPath = (...parts) => path.join(AGENT_DIR, ...parts);

/** `<agent dir>/custom-providers/<id>` — the directory that makes a provider exist. */
export const vendorDir = (id) => agentPath("custom-providers", id);

/**
 * The repo-side model table tests seed their vendor directories from. The extension itself
 * ships no model data: a directory gets its base table from its own `models.json` (or live
 * discovery), so tests supply one as the "curated user table" would. Only ids the tests
 * reference are listed; `tests/models-test.mjs` guards their shape.
 */
export const FIXTURE_MODELS = JSON.parse(readFileSync(path.join(REPO_ROOT, "tests/fixtures/models.json"), "utf8"));

/**
 * Write `<id>/provider.json` for the shipped defaults into the temp agent dir, plus the
 * fixture `models.json` when one exists for that vendor. A provider only exists when its
 * directory does; this is what `custom-providers init` + a user's table produce.
 */
export async function seedDefaultProviders(...ids) {
	const { DEFAULTS } = await loadTs("extensions/custom-providers/sources.ts");
	for (const id of ids.length > 0 ? ids : DEFAULTS.map((vendor) => vendor.id)) {
		const shipped = DEFAULTS.find((vendor) => vendor.id === id);
		if (!shipped) continue;
		const dir = agentPath("custom-providers", id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "provider.json"), `${JSON.stringify({ name: shipped.name, ...shipped.declaration }, null, "\t")}\n`);
		const models = FIXTURE_MODELS[id];
		if (!models) throw new Error(`no tests/fixtures/models.json entry for "${id}"`);
		writeFileSync(path.join(dir, "models.json"), `${JSON.stringify({ models }, null, "\t")}\n`);
	}
}

/**
 * A stub `pi` plus the collections the extension fills in. Tests want different slices of this
 * (events, commands, notifications, providers), so it is built once here instead of per test.
 */
export function stubPi() {
	const providers = new Map();
	const events = new Map();
	const commands = new Map();
	const notifications = [];
	const notify = (message, level) => notifications.push({ message, level });
	const pi = {
		on: (event, handler) => events.set(event, handler),
		registerCommand: (name, options) => commands.set(name, options),
		registerProvider: (id, config) => providers.set(id, config),
		registerFlag: () => {},
		registerShortcut: () => {},
		registerTool: () => {},
		getFlag: () => undefined,
	};
	return { pi, providers, events, commands, notifications, notify };
}

/** A complete model row. `cost` is the field pi dereferences on every request. */
export const testModel = (id, extra = {}) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	...extra,
});

/**
 * Load the extension with a stub pi and hand back what it registered. Tests write their
 * `models.json` / `custom-providers/<id>/...` into the temp agent dir first, so this is the
 * one entry point for "what would pi see with this configuration".
 */
export async function startExtension() {
	const factory = (await loadTs("extensions/custom-providers/index.ts")).default;
	const { pi, providers, events, commands, notifications, notify } = stubPi();
	await factory(pi);
	/**
	 * `session_start` refreshes live, so tests run it with fetch offline unless they stub it
	 * themselves: the suite must never depend on the network. Tests that want a fetch result
	 * call `refreshModels` with their own stub instead.
	 */
	const sessionStart = (ctx = {}) =>
		withFetch(
			async () => {
				throw new Error("offline test");
			},
			() => events.get("session_start")?.({}, { hasUI: true, ui: { notify }, ...ctx }),
		);
	return { providers, events, commands, notifications, notify, sessionStart };
}
