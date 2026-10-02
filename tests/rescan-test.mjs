/**
 * `rescan` — the only verb that changes registration without touching the directory.
 *
 * The registry entry list is a load-time snapshot, so a hand-edited `models.json` (or a new or
 * deleted directory) used to stay invisible until pi's `/reload`. `rescan` re-reads the directory
 * and re-registers from a *fresh* snapshot, and it is the one verb that never writes disk:
 * `files` looks, `sync` writes files, `rescan` moves the session.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { assert, runCommand, startExtension, testModel, vendorDir } from "./harness.mjs";

const write = (dir, name, data) => writeFileSync(`${dir}/${name}`, typeof data === "string" ? data : `${JSON.stringify(data, null, "\t")}\n`);
const seed = (id, models) => {
	mkdirSync(vendorDir(id), { recursive: true });
	write(vendorDir(id), "provider.json", { name: id, baseUrl: `https://${id}.example/v1`, api: "openai-completions" });
	write(vendorDir(id), "models.json", { models });
};

// The session starts with no provider at all: every case below is a change made behind its back.
const ext = await startExtension();
const notify = [];
const run = (args) => runCommand(ext.commands, args, notify);
const last = () => notify.at(-1);

await run("status manual");
assert(last().includes('Unknown provider "manual"'), `a directory that does not exist yet is unknown (got ${last()})`);

// A new directory: `files` sees it, registration has not moved, `rescan` makes it real.
seed("manual", [testModel("m1")]);
await run("files");
assert(last().includes("manual"), `\`files\` reads the new directory (got ${last()})`);
await run("status manual");
assert(last().includes('Unknown provider "manual"'), `but registration has not moved yet (got ${last()})`);

await run("rescan");
assert(last().includes("registered 1 provider(s)") && last().includes("1 new (manual)"), `\`rescan\` picks the new directory up (got ${last()})`);
assert(ext.providers.has("manual"), "and pi now carries the provider");
await run("status manual");
assert(last().startsWith("manual: 1 models"), `\`status\` sees the fresh snapshot (got ${last()})`);

// A hand-edited table: invisible until the session is told to re-read it.
write(vendorDir("manual"), "models.json", { models: [testModel("m1"), testModel("m2")] });
await run("status manual");
assert(last().includes("1 models"), `a hand edit is invisible before rescan (got ${last()})`);
await run("rescan");
assert(ext.providers.get("manual").models.length === 2, "rescan re-registers from a fresh snapshot");
await run("status manual");
assert(last().startsWith("manual: 2 models"), `and \`status\` reflects it (got ${last()})`);

// `--dry-run` reports what it would do and moves nothing.
rmSync(vendorDir("manual"), { recursive: true });
await run("rescan --dry-run");
assert(last().includes("1 to unregister (manual)"), `a dry run names what it would drop (got ${last()})`);
assert(ext.providers.has("manual") && ext.unregistered.length === 0, "and neither registers nor unregisters");
await run("status manual");
assert(last().startsWith("manual: 2 models"), `the provider outlives the dry run (got ${last()})`);

// A deleted directory: pi's `unregisterProvider` is the only way to drop it in-session.
await run("rescan");
assert(ext.unregistered.join(",") === "manual", `the removed directory is unregistered (got ${ext.unregistered.join(",")})`);
assert(!ext.providers.has("manual"), "pi no longer carries it");
await run("status manual");
assert(last().includes('Unknown provider "manual"'), `and it leaves \`status\` (got ${last()})`);

// A one-provider rescan never touches another provider's ids.
seed("other", [testModel("o1")]);
await run("rescan other");
assert(ext.providers.has("other"), "a one-provider rescan registers that provider");
ext.unregistered.length = 0;
write(vendorDir("other"), "models.json", { models: [testModel("o1"), testModel("o2")] });
await run("rescan other");
assert(ext.unregistered.length === 0, "and never unregisters a provider it did not scan");
assert(ext.providers.get("other").models.length === 2, "while the scanned provider is refreshed");

// The verb knows a directory that never existed: nothing to do, said out loud.
await run("rescan nope");
assert(last().includes('No provider directory named "nope"'), `an unknown id is reported (got ${last()})`);

console.log("OK");
