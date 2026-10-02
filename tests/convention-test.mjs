import { assert, FIXTURE_MODELS, loadTs, testModel } from "./harness.mjs";

/**
 * The last-resort capability convention (A same-family inheritance, B known-family list).
 * It must never override the curated table or a probe — only fill an id discovery introduced.
 * A inherits whatever this provider's table says (any wire); B's synthesized `{xhigh, max}` map
 * stays Anthropic-only, because that one is invented rather than inherited.
 */
const { familyKey, conventionCapability, CONVENTION_FAMILIES } = await loadTs("extensions/custom-providers/convention.ts");
const { applyLiveModels } = await loadTs("extensions/custom-providers/live.ts");

// --- familyKey: drop the vendor prefix, stop at the first version-bearing token ---
assert(familyKey("zai-org/GLM-5.3") === "glm", `vendor prefix is dropped (got ${familyKey("zai-org/GLM-5.3")})`);
assert(familyKey("claude-opus-4-8") === "claude-opus", "the variant word is part of the family");
assert(familyKey("xiaomi/mimo-v2.6-pro") === "mimo", "a `v` token ends the family");
assert(familyKey("Qwen3.8-Max") === "qwen", "a glued version falls back to the leading letters");
assert(familyKey("hy3-paid") === "hy", "the same when the family is two letters");
assert(familyKey("o3-mini") === "o", "openai o-series");

// --- A: inherit from the same family in the curated table ------------------------
const curated = [
	{ id: "claude-sonnet-5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
	{ id: "xiaomi/mimo-v2.6-pro", reasoning: false },
];
const inherited = conventionCapability(curated, "claude-sonnet-6", "anthropic-messages");
assert(inherited?.reasoning === true && inherited.thinkingLevelMap?.xhigh === "xhigh", "a same-family id inherits reasoning + map");
const inheritedOpen = conventionCapability(curated, "claude-sonnet-6", "openai-completions");
assert(
	inheritedOpen?.reasoning === true && inheritedOpen.thinkingLevelMap?.xhigh === "xhigh",
	"and the same inherited map on an OpenAI-shaped wire: a curated sibling is a fact about this gateway",
);

// The reported case: a discovered `deepseek/*-fast` id must inherit the table's short map on the
// OpenAI wire, or pi offers only off..high and the `max` level silently disappears.
const curatedDeepseek = [{ id: "deepseek/deepseek-v4.1-flash", reasoning: true, thinkingLevelMap: { low: "low", high: "high", max: "max" } }];
const fast = conventionCapability(curatedDeepseek, "deepseek/deepseek-v4.1-flash-fast", "openai-completions");
assert(
	fast?.thinkingLevelMap?.max === "max" && fast.thinkingLevelMap?.low === "low" && fast.thinkingLevelMap?.xhigh === undefined,
	"a discovered sibling keeps the curated short map on the OpenAI wire",
);
assert(conventionCapability(curated, "xiaomi/mimo-v2.7", undefined)?.reasoning === false, "a false sibling is inherited too");
assert(conventionCapability(curated, "brand-new-v1", undefined) === undefined, "an unknown family falls through to `false`");

// --- B: a known reasoning family with no sibling ---------------------------------
const known = conventionCapability([], "gemini-4-flash", "anthropic-messages");
assert(known?.reasoning === true && known.thinkingLevelMap?.xhigh === "xhigh" && known.thinkingLevelMap?.max === "max", "a known family gets reasoning + extended levels on the Anthropic wire");
const knownOpen = conventionCapability([], "gemini-4-flash", "openai-completions");
assert(knownOpen?.reasoning === true && knownOpen.thinkingLevelMap === undefined, "and only off..high (no map) elsewhere");

// The list is hand-maintained now that the package ships no model table, so check it against
// the only model data in the repo: a family whose curated entries all reason must be listed,
// or a newly discovered id of that family would silently lose reasoning.
const families = new Map();
for (const models of Object.values(FIXTURE_MODELS)) {
	for (const model of models) {
		const key = familyKey(model.id);
		const entry = families.get(key) ?? { yes: 0, no: 0 };
		if (model.reasoning === true) entry.yes += 1;
		else entry.no += 1;
		families.set(key, entry);
	}
}
let allReasoning = 0;
for (const [key, entry] of families) {
	if (entry.yes > 0 && entry.no === 0) {
		assert(CONVENTION_FAMILIES.includes(key), `every curated "${key}" entry reasons, so "${key}" must be in CONVENTION_FAMILIES`);
		allReasoning += 1;
	}
}
assert(allReasoning > 0, "the fixture table must exercise the all-reasoning family invariant");

// --- wiring: applyLiveModels actually consults the convention ---------------------
const applied = applyLiveModels([testModel("zai-org/GLM-5.3", { reasoning: true, thinkingLevelMap: { max: "max" } })], [{ id: "zai-org/GLM-5.4" }], "anthropic-messages");
const fresh = applied.models.find((model) => model.id === "zai-org/GLM-5.4");
assert(fresh.reasoning === true && fresh.thinkingLevelMap?.max === "max", "a newly discovered same-family id is registered with the inherited capability");
assert(applied.unknown.join(",") === "zai-org/GLM-5.4", "and is still reported as new");

const appliedOpen = applyLiveModels([testModel("zai-org/GLM-5.3", { reasoning: true, thinkingLevelMap: { max: "max" } })], [{ id: "zai-org/GLM-5.4" }], "openai-completions");
const freshOpen = appliedOpen.models.find((model) => model.id === "zai-org/GLM-5.4");
assert(freshOpen.reasoning === true && freshOpen.thinkingLevelMap?.max === "max", "a discovery on the OpenAI wire registers the inherited map too");

console.log(`convention: A+B, ${CONVENTION_FAMILIES.length} families, ${families.size} seen`);
console.log("OK");
