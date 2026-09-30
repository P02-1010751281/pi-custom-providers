import { assert, loadTs } from "./harness.mjs";

/**
 * The last-resort capability convention (A same-family inheritance, B known-family list).
 * It must never override the curated table or a probe — only fill an id discovery introduced.
 */
const { familyKey, conventionCapability, CONVENTION_FAMILIES } = await loadTs("extensions/custom-providers/convention.ts");
const { applyLiveModels } = await loadTs("extensions/custom-providers/index.ts");

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
assert(inheritedOpen?.reasoning === true && inheritedOpen.thinkingLevelMap === undefined, "but no map on the non-Anthropic wire");
assert(conventionCapability(curated, "xiaomi/mimo-v2.7", undefined)?.reasoning === false, "a false sibling is inherited too");
assert(conventionCapability(curated, "brand-new-v1", undefined) === undefined, "an unknown family falls through to `false`");

// --- B: a known reasoning family with no sibling ---------------------------------
const known = conventionCapability([], "gemini-4-flash", "anthropic-messages");
assert(known?.reasoning === true && known.thinkingLevelMap?.xhigh === "xhigh" && known.thinkingLevelMap?.max === "max", "a known family gets reasoning + extended levels on the Anthropic wire");
const knownOpen = conventionCapability([], "gemini-4-flash", "openai-completions");
assert(knownOpen?.reasoning === true && knownOpen.thinkingLevelMap === undefined, "and only off..high (no map) elsewhere");

// --- the list tracks the curated catalog ------------------------------------------
const { CATALOG } = await loadTs("extensions/custom-providers/catalog.ts");
const families = new Map();
for (const models of Object.values(CATALOG)) {
	for (const model of models) {
		const key = familyKey(model.id);
		const entry = families.get(key) ?? { yes: 0, no: 0 };
		if (model.reasoning === true) entry.yes += 1;
		else entry.no += 1;
		families.set(key, entry);
	}
}
for (const [key, entry] of families) {
	if (entry.yes > 0 && entry.no === 0) assert(CONVENTION_FAMILIES.includes(key), `every curated entry of "${key}" reasons, so it must be in CONVENTION_FAMILIES`);
}

// --- wiring: applyLiveModels actually consults the convention ---------------------
const base = (id, extra = {}) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...extra });
const applied = applyLiveModels([base("zai-org/GLM-5.3", { thinkingLevelMap: { max: "max" } })], [{ id: "zai-org/GLM-5.4" }], "anthropic-messages");
const fresh = applied.models.find((model) => model.id === "zai-org/GLM-5.4");
assert(fresh.reasoning === true && fresh.thinkingLevelMap?.max === "max", "a newly discovered same-family id is registered with the inherited capability");
assert(applied.unknown.join(",") === "zai-org/GLM-5.4", "and is still reported as new");

console.log(`convention: A+B, ${CONVENTION_FAMILIES.length} families, ${families.size} seen`);
console.log("OK");
