import { existsSync, readFileSync, rmSync } from "node:fs";
import { agentPath, assert, loadTs, seedDefaultProviders, startExtension } from "./harness.mjs";

/**
 * There are no built-in providers (design §8): the shipped `sources.ts` defaults seed a
 * directory, they are never registered on their own. No directory = no provider, and
 * `custom-providers init` writes the directory that makes one.
 */
const { DEFAULTS } = await loadTs("extensions/custom-providers/sources.ts");

// --- no directory, no provider -------------------------------------------------
const empty = await startExtension();
assert(empty.providers.size === 0, `no custom-providers directory registers nothing (got ${[...empty.providers.keys()].join(", ")})`);

// --- a directory for a shipped id gets the seeded model table + default account --
await seedDefaultProviders("commandcode");
const seeded = await startExtension();
assert(seeded.providers.has("commandcode"), "a directory registers the provider");
assert(seeded.providers.get("commandcode").models.length > 0, "and gets the model table from its own models.json");
assert(seeded.providers.get("commandcode").apiKey === "$CMD_API_KEY", "and the shipped default account");
assert(seeded.providers.get("commandcode").api === DEFAULTS.find((vendor) => vendor.id === "commandcode").declaration.api, "and the shipped endpoint");

// --- the extension ships no model table: provider.json alone registers no models --
rmSync(agentPath("custom-providers", "commandcode", "models.json"));
const bare = await startExtension();
assert(bare.providers.has("commandcode"), "the directory still registers");
assert(bare.providers.get("commandcode").models.length === 0, "with no models.json there is no model table to register (the extension ships none)");

// --- init writes provider.json for a shipped id --------------------------------
const notify = [];
const ui = await startExtension();
const run = (args) => ui.commands.get("custom-providers").handler(args, { hasUI: true, ui: { notify: (message) => notify.push(message) } });

const scnetFile = agentPath("custom-providers", "scnet", "provider.json");
await run("init scnet");
assert(existsSync(scnetFile), "init writes the provider file");
const written = JSON.parse(readFileSync(scnetFile, "utf8"));
assert(written.api === "openai-completions" && written.baseUrl.includes("scnet"), "with the shipped declaration");
assert(written.apis?.["anthropic-messages"]?.baseUrl, "including the second endpoint");

await run("init scnet");
assert((notify.at(-1) ?? "").includes("exists"), "a second init refuses to overwrite without --force");
await run("init scnet --force");
assert((notify.at(-1) ?? "").includes("wrote"), "--force overwrites");
await run("init nope");
assert((notify.at(-1) ?? "").includes("unknown"), "an unknown id is reported");

console.log(`defaults: ${DEFAULTS.map((vendor) => vendor.id).join(", ")}`);
console.log("OK");
