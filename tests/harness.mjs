import { execSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
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
