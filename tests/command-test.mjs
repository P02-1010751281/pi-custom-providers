/**
 * The command surface: one `/providers` command whose parsing is driven by a verb table plus a
 * per-verb flag table, and every mismatch answers `Usage:` (generated from those tables).
 *
 * Before v0.5.0 the verb was an `if`/`head === "…"` chain and the flags were `rest.includes(...)`:
 * a mistyped verb fell through to `status` and was answered as an unknown *provider*, a mistyped
 * flag was silently ignored (`sync x --writ` ran a dry run), and extra arguments were dropped.
 * `drift` is no longer a verb either: its count is one number in `status`, its detail one line in
 * `status <id>`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { agentPath, assert, loadTs, runCommand, startExtension, testModel, vendorDir } from "./harness.mjs";

const { VERBS, parseCommand, usageOverview } = await loadTs("extensions/custom-providers/verbs.ts");

// --- the tables -----------------------------------------------------------------------
const names = VERBS.map((verb) => verb.name);
assert(names.includes("status") && names.includes("files") && names.includes("init") && names.includes("sync") && names.includes("rescan"), `the verb table lists the jobs (got ${names.join(", ")})`);
assert(!names.includes("drift"), "`drift` is not a verb — its count folded into `status`");
assert(usageOverview().startsWith("Usage: /providers "), `the overview usage names the command (got ${usageOverview()})`);

// --- parsing: what the tokens mean ----------------------------------------------------
const parse = (args) => {
	const result = parseCommand(args);
	return result.ok ? result.command : undefined;
};
const failure = (args) => {
	const result = parseCommand(args);
	return result.ok ? undefined : result.failure.message;
};

assert(parse("").verb.name === "status", "no arguments runs the default verb");
assert(parse("demo").verb.name === "status" && parse("demo").positionals[0] === "demo", "a bare token is a provider id for `status`");
assert(parse("  files  ").verb.name === "files", "the first token is a verb when it hits the table");
const sync = parse("sync demo --dry-run --prune");
assert(sync.verb.name === "sync" && sync.positionals[0] === "demo", "`sync <id>` takes one positional");
assert(sync.flags.has("--dry-run") && sync.flags.has("--prune"), "both of `sync`'s flags are read");
assert(parse("sync").verb.name === "sync" && parse("sync").positionals.length === 0, "`sync` with no id means every vendor");
assert(parse("rescan --dry-run").flags.has("--dry-run"), "`rescan` takes `--dry-run`");
assert(parse("init demo --force").verb.name === "init", "`init` is dispatched with its flags");

// --- parsing: every mismatch is a `Usage:` error --------------------------------------
for (const args of ["sync demo extra", "files extra", "status a b", "sync demo --writ", "files --x", "init --nope", "sync --prune"]) {
	const message = failure(args);
	assert(message && message.includes("Usage:"), `\`${args}\` answers \`Usage:\` (got ${message})`);
}
assert(failure("sync demo --writ").includes("--writ"), "the diagnostic names the offending flag");
assert(failure("sync --prune").includes('"--prune" needs a provider id'), `a per-vendor flag needs its id (got ${failure("sync --prune")})`);
assert(failure("sync demo extra").includes("Usage: /providers sync [<id>]"), `the usage line is built from the table (got ${failure("sync demo extra")})`);
assert(failure("files --x").includes("Usage: /providers files"), "a no-flag verb prints its own usage line");
assert(failure("status a b").includes("takes at most one argument"), `an extra positional is named as such (got ${failure("status a b")})`);
assert(failure("files extra").includes('takes no arguments (got "extra")'), `a verb that takes nothing says so (got ${failure("files extra")})`);

// --- through the extension ------------------------------------------------------------
const ui = await startExtension();
const notify = [];
const run = (args) => runCommand(ui.commands, args, notify);

assert(ui.commands.has("providers"), "one `/providers` command is registered");
assert(!ui.commands.has("custom-providers"), "the old command name is gone");

await run("drfit");
assert(notify.at(-1).includes("Usage:"), `a mistyped verb answers \`Usage:\` (got ${notify.at(-1)})`);
assert(notify.at(-1).includes("drfit"), "and names the token it did not understand");

await run("drift");
assert(notify.at(-1).includes("Unknown provider") && notify.at(-1).includes("Usage:"), `\`drift\` is read as a provider id now (got ${notify.at(-1)})`);

await run("sync demo --writ");
assert(notify.at(-1).includes("Usage:") && !notify.at(-1).includes("dry run"), `a mistyped flag never runs the command (got ${notify.at(-1)})`);

// --- `drift` folded into `status`: a count in the overview, detail per provider -------
const { loadBuiltinCatalog } = await loadTs("extensions/custom-providers/builtin.ts");
const catalog = await loadBuiltinCatalog();
if (catalog.byId.size > 0) {
	// Any id pi's catalog knows, with one number deliberately off: the extension ships no tables,
	// so this is the only way a disagreement can arise in a test.
	const [id, builtin] = [...catalog.byId.entries()][0];
	mkdirSync(vendorDir("drift-demo"), { recursive: true });
		writeFileSync(agentPath("custom-providers", "drift-demo", "provider.json"), `${JSON.stringify({ name: "Drift demo", baseUrl: "https://drift.example/v1", api: "openai-completions" }, null, "\t")}\n`);
	const row = testModel(id, {
		reasoning: builtin.reasoning,
		input: [...builtin.input],
		contextWindow: builtin.contextWindow + 1000,
		maxTokens: builtin.maxTokens,
	});
	writeFileSync(agentPath("custom-providers", "drift-demo", "models.json"), `${JSON.stringify({ models: [row] }, null, "\t")}\n`);

	const driftUi = await startExtension();
	const driftNotify = [];
	const driftRun = (args) => runCommand(driftUi.commands, args, driftNotify);

	await driftRun("");
	const overview = driftNotify.at(-1);
	assert(overview.includes("drift-demo") && /drift 1\b/.test(overview), `the overview carries the disagreement count (got ${overview})`);

	await driftRun("status drift-demo");
	const detail = driftNotify.at(-1);
	assert(detail.includes("built-in catalog") && detail.includes(id), `\`status <id>\` carries the detail (got ${detail})`);
}

console.log("OK");
