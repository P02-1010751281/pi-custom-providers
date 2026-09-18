import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EXT, PI } from "./harness.mjs";

/**
 * Load the extension through pi's real extension loader (not just jiti) and report
 * load errors. Expects the single custom-providers extension.
 */
const { discoverAndLoadExtensions } = await import(`${PI}/dist/core/extensions/loader.js`);
const { createEventBus } = await import(`${PI}/dist/core/event-bus.js`);

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-ext-load-"));
try {
	// discoverAndLoadExtensions reads <agentDir>/extensions; point it at this repo.
	const agentDir = path.join(tmp, "agent");
	await mkdir(agentDir, { recursive: true });
	await symlink(EXT, path.join(agentDir, "extensions"));

	const result = await discoverAndLoadExtensions([], tmp, agentDir, createEventBus());
	const errors = result.errors ?? [];
	console.log(`extensions loaded: ${result.extensions.length}`);
	for (const extension of result.extensions) {
		const file = typeof extension === "string" ? extension : (extension.path ?? extension.name);
		console.log(`  ${path.basename(path.dirname(String(file)))}/${path.basename(String(file))}`);
	}
	console.log(`errors: ${errors.length}`);
	for (const error of errors) console.log(`  ${JSON.stringify(error)}`);
	if (errors.length > 0 || result.extensions.length !== 1) {
		process.exitCode = 1;
	}
} finally {
	await rm(tmp, { recursive: true, force: true });
}
