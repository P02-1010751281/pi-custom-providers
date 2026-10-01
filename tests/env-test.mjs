import { writeFileSync } from "node:fs";
import { PI, agentPath, assert, loadTs } from "./harness.mjs";

/**
 * The value grammar and the `!command` shell.
 *
 * Both are pi's, mirrored in `env.ts` because pi exports neither its resolver nor its
 * grammar — but this package resolves a credential only to decide *whether* one exists,
 * while pi resolves the very same string at request time. The two must agree, so the mirror
 * is pinned here against pi's own `resolveConfigValue`. A `!command` is the case where they
 * most easily drift: it runs in a shell pi picks, not in the one Node would default to.
 *
 * The one intentional divergence is a bare `UPPER_SNAKE` value, which pi sends as the token
 * itself and this package reads as an environment variable *name* (then hands pi `$NAME`);
 * the round trip is asserted below instead.
 */
const { resolveConfigValue, configValueForPi, loadEnvFile } = await loadTs("extensions/custom-providers/env.ts");
const pi = await import(`${PI}/dist/core/resolve-config-value.js`);
const resolveWithPi = (value, env) => pi.resolveConfigValueUncached(value, env);

const env = { SET_KEY: "sk-set", EMPTY: "" };
const cases = [
	"sk-plain", // a literal is a literal
	"$$SET_KEY", // `$$` escapes a leading $: still a literal
	"$!cmd", // `$!` escapes a leading !: not a command
	"$SET_KEY", // the two environment forms
	"${SET_KEY}",
	"$MISSING", // an unset variable is no credential…
	"${MISSING}",
	"$EMPTY", // …and neither is an empty one
	"!printf %s sk-from-command", // a command: stdout, trimmed
	"!printf %s '  sk-padded  '",
	"!exit 3", // a failing command is no credential, not a crash
	"!printf %s ''", // nor is a command with no output
	"!command-that-does-not-exist-xyz", // nor is one that cannot even start
];
for (const value of cases) {
	const ours = resolveConfigValue(value, env);
	const theirs = resolveWithPi(value, env);
	assert(ours === theirs, `the grammar matches pi's for ${JSON.stringify(value)}: ${JSON.stringify(ours)} vs ${JSON.stringify(theirs)}`);
}

// A `!command` runs in *pi's* shell, not in Node's default. `printf` is a builtin of bash/sh
// and absent from `cmd.exe`, so on Windows this is the difference between the credential and
// a spurious "no API key" at refresh time (pi runs it through `getShellConfig()` there).
assert(resolveConfigValue("!printf %s shell-check", env) === "shell-check", "a !command runs in the shell pi would use");
assert(resolveConfigValue("!printf %s shell-check") === "shell-check", "and the ambient environment is the default");

// The documented divergence, in both directions: we read a bare name as an env var, and the
// `$NAME` we hand pi resolves back to the very value we checked for.
assert(resolveConfigValue("SET_KEY", env) === "sk-set", "a bare name is an environment variable name to us");
assert(resolveConfigValue("MISSING", env) === undefined, "including when it is unset");
assert(configValueForPi("SET_KEY") === "$SET_KEY", "and we hand pi the interpolated form");
assert(resolveWithPi(configValueForPi("SET_KEY"), env) === resolveConfigValue("SET_KEY", env), "so pi resolves the value we checked for");
assert(configValueForPi("$SET_KEY") === "$SET_KEY" && configValueForPi("sk-plain") === "sk-plain", "a reference or literal is handed over untouched");
assert(configValueForPi("!printf %s x") === "!printf %s x" && configValueForPi(undefined) === undefined, "and so is a command, and nothing");

// `.env` loading is additive: an already-set variable wins, quotes come off, `export ` is
// tolerated, only the first `=` separates, and a missing file is not an error.
const envFile = agentPath("test.env");
writeFileSync(envFile, ["# a comment", "export FROM_FILE='quoted value'", "EQUALS=a=b", "PLAIN=from-file", "BROKEN", ""].join("\n"));
delete process.env.FROM_FILE;
delete process.env.EQUALS;
delete process.env.BROKEN;
process.env.PLAIN = "already set";
loadEnvFile(envFile);
assert(process.env.FROM_FILE === "quoted value", "quotes are stripped and `export ` tolerated");
assert(process.env.EQUALS === "a=b", "only the first = separates the pair");
assert(process.env.PLAIN === "already set", "an existing environment variable is never overwritten");
assert(process.env.BROKEN === undefined, "a line without = is skipped");
loadEnvFile(agentPath("no-such-file.env")); // must not throw: the agent dir may not exist yet

console.log(`env: ${cases.length} value forms match pi, plus .env loading`);
console.log("OK");
