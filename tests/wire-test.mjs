import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadTs, PI, assert } from "./harness.mjs";

/**
 * Merged providers: SCNet's OpenAI and Anthropic wires register as ONE `scnet` provider, and
 * the wire is picked per model in `models.json` (`providers.scnet.wire`). pi has no provider
 * alias and one provider id holds a given model id only once (`model.id` is the `model` value
 * sent to the gateway), so this is the only shape that shows one vendor once in the picker
 * while both wires stay reachable.
 *
 * Each scenario re-runs the factory with a different `models.json`. No fetch is allowed to
 * succeed, so nothing here touches the network.
 */
const { getAgentDir } = await import(`${PI}/dist/index.js`);
const cfg = await loadTs("extensions/custom-providers/config.ts");
const { SOURCES } = await loadTs("extensions/custom-providers/sources.ts");
const factory = (await loadTs("extensions/custom-providers/index.ts")).default;
const modelsJson = path.join(getAgentDir(), "models.json");
const OPENAI_WIRE = SOURCES.find((source) => source.id === "scnet").baseUrl;
const ANTHROPIC_WIRE = SOURCES.find((source) => source.id === "scnet-anthropic").baseUrl;
const realFetch = globalThis.fetch;

async function register(config) {
	writeFileSync(modelsJson, JSON.stringify(config));
	const providers = new Map();
	const events = new Map();
	const commands = new Map();
	const notifications = [];
	await factory({
		on: (event, handler) => events.set(event, handler),
		registerCommand: (name, options) => commands.set(name, options),
		registerProvider: (id, providerConfig) => providers.set(id, providerConfig),
		registerFlag: () => {},
		registerShortcut: () => {},
		registerTool: () => {},
		getFlag: () => undefined,
	});
	const models = providers.get("scnet").models;
	const onWire = (wire) => models.filter((model) => (model.api === "anthropic-messages") === (wire === "anthropic"));
	return { providers, models, onWire, events, commands, notifications };
}

// Every refresh must fail loudly instead of reaching the network, and a failing wire must not
// stop the other one from being merged.
globalThis.fetch = async () => {
	throw new Error("offline test");
};
let failed = 0;
try {
	// --- wire name parsing (unit) ------------------------------------------------
	assert(cfg.wireSelectionFor({ wire: "anthropic" }).default === "anthropic", "a bare wire name is the provider default");
	assert(cfg.wireSelectionFor({ wire: "anthropic-messages" }).default === "anthropic", "pi's own api id is accepted as a wire name");
	assert(cfg.wireSelectionFor({}).default === undefined, "no wire key means no preference");
	assert(
		JSON.stringify(cfg.wireSelectionFor({ wire: { default: "openai", models: { a: "anthropic", b: 7 } } }).models) === '{"a":"anthropic"}',
		"per-model wire entries are read, non-string ones dropped",
	);

	// --- no configuration: one provider, default wire ----------------------------
	const plain = await register({});
	assert([...plain.providers.keys()].sort().join(",") === "codecommand,scnet", `one provider per vendor (got ${[...plain.providers.keys()].join(",")})`);
	assert(plain.providers.get("scnet").baseUrl === OPENAI_WIRE, "the provider keeps the default wire's base URL");
	assert(plain.providers.get("scnet").api === "openai-completions", "the provider keeps the default wire's api");
	assert(plain.models.length === 19, `the merged list is the union of both wires (got ${plain.models.length})`);
	assert(plain.onWire("anthropic").length === 0, "without a configured wire every model stays on the default wire");
	assert(plain.models.every((model) => model.cost && typeof model.cost.input === "number"), "merged models carry cost");

	// --- per-model selection -----------------------------------------------------
	const perModel = await register({ providers: { scnet: { wire: { models: { "GLM-5.2": "anthropic" } } } } });
	const moved = perModel.onWire("anthropic");
	assert(moved.length === 1 && moved[0].id === "GLM-5.2", `only the selected model moves (got ${moved.map((model) => model.id).join(",") || "none"})`);
	assert(moved[0].baseUrl === ANTHROPIC_WIRE, `the chosen wire's base URL is stamped on the model (got ${moved[0].baseUrl})`);
	assert(moved[0].name.endsWith("(Anthropic)"), `the display name shows the wire (got ${moved[0].name})`);
	assert(perModel.models.filter((model) => model.id === "GLM-5.2" && model.api !== "anthropic-messages").length === 0, "the same id is not registered twice");
	assert(perModel.providers.get("scnet").baseUrl === OPENAI_WIRE, "a per-model move does not change the provider-level base URL");
	assert(perModel.models.filter((model) => model.id !== "GLM-5.2").every((model) => model.baseUrl === undefined), "models on the default wire carry no base URL override");
	await perModel.commands.get("custom-providers").handler("", { ui: { notify: (message) => perModel.notifications.push({ message }) } });
	const status = perModel.notifications.map((entry) => entry.message).join(" | ");
	assert(status.includes("[openai 18 (catalog), anthropic 1 (catalog)]"), `the status line splits the provider's models per wire (got: ${status})`);

	// --- provider-wide default ---------------------------------------------------
	const wholeWire = await register({ providers: { scnet: { wire: "anthropic" } } });
	assert(wholeWire.onWire("anthropic").length === 18, `the whole catalog moves to the named wire (got ${wholeWire.onWire("anthropic").length})`);
	assert(wholeWire.onWire("anthropic").every((model) => model.baseUrl === ANTHROPIC_WIRE), "every moved model carries the wire's base URL");
	const stranded = wholeWire.models.find((model) => model.id === "MiniMax-M2.5");
	assert(stranded?.api !== "anthropic-messages", "a model the wire does not serve stays on the default wire");
	assert(wholeWire.providers.get("scnet").baseUrl === OPENAI_WIRE, "the provider-level endpoint stays the default wire's");
	await wholeWire.events.get("session_start")({}, { hasUI: true, ui: { notify: (message, level) => wholeWire.notifications.push({ message, level }) } });
	const reported = wholeWire.notifications.map((entry) => entry.message).join(" | ");
	assert(reported.includes("MiniMax-M2.5") && reported.includes('not on the "anthropic" wire'), `a model that could not move is reported, not moved silently (got: ${reported})`);

	// --- a misspelled wire name is reported, not silently ignored ----------------
	const typo = await register({ providers: { scnet: { wire: "anthropik" } } });
	assert(typo.onWire("anthropic").length === 0, "a misspelled wire name moves nothing");
	await typo.events.get("session_start")({}, { hasUI: true, ui: { notify: (message, level) => typo.notifications.push({ message, level }) } });
	const typoReport = typo.notifications.map((entry) => entry.message).join(" | ");
	assert(typoReport.includes('"anthropik"'), `a misspelled wire name is reported instead of ignored (got: ${typoReport})`);
} catch (error) {
	failed = 1;
	console.error(error);
} finally {
	globalThis.fetch = realFetch;
}
assert(failed === 0, "wire selection scenarios passed");

console.log(`openai wire: ${OPENAI_WIRE}`);
console.log(`anthropic wire: ${ANTHROPIC_WIRE}`);
console.log("OK");
