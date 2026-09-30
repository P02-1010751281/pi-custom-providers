/**
 * Last-resort capability convention for ids discovery has just introduced.
 *
 * The authoritative sources stay authoritative: upstream metadata, a probe result, or the
 * curated base table. This file only speaks when all of them are silent — the live `/models`
 * wire carries no capability field today. Two steps, in order:
 *
 *   A. same-family inheritance: the new id takes `reasoning` (and, on the Anthropic wire,
 *      `thinkingLevelMap`) from the first already-curated entry of the same family. A new
 *      `GLM-5.4` therefore follows whatever the table already says about `GLM-5.3`.
 *   B. a hard-coded family allowlist: families known to be reasoning-capable, for ids with
 *      no same-family entry to inherit from.
 *
 * No match keeps `reasoning: false` — the honest "we don't know". A convention can be wrong;
 * a wrong `reasoning: true` shows thinking levels the wire may reject, so the list stays
 * deliberately short and is maintained by hand.
 */
import type { CatalogThinkingLevel } from "./types.ts";

export type ThinkingLevelMap = Partial<Record<CatalogThinkingLevel, string | null>>;

export interface ConventionCapability {
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

/** A curated entry the convention may inherit from. */
interface CuratedModel {
	id: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * Reasoning-capable families, matched against `familyKey()` **exactly**. Keys are family
 * stems, not vendor names: `claude-sonnet` covers every version of it, `gpt` covers `5.4` /
 * `5.6-sol`, `o` covers `o3`/`o4`. Mixed families (e.g. `mimo`, `llama`) are deliberately
 * absent — step A still covers them when a same-family entry exists, and "we don't know" is
 * the better answer otherwise. Kept short and hand-maintained.
 */
export const CONVENTION_FAMILIES: readonly string[] = [
	"claude-sonnet",
	"claude-opus",
	"claude-haiku",
	"claude-fable",
	"gpt",
	"o",
	"deepseek",
	"glm",
	"kimi",
	"qwen",
	"minimax",
	"grok",
	"gemini",
	"step",
	"hy",
	"hunyuan",
	"muse-spark",
	"inkling",
	"inkling-small",
	"fugu-ultra",
	"nemotron",
	"laguna-s",
	"ling",
	"longcat",
	"magistral",
];

/** The effort levels only the Anthropic wire can carry; added by convention when it is silent. */
const ANTHROPIC_EXTENDED: ThinkingLevelMap = { xhigh: "xhigh", max: "max" };

/**
 * The family stem of a model id: the leading words before the first version-bearing token.
 * `zai-org/GLM-5.3` → `glm`, `claude-opus-4-8` → `claude-opus`, `Qwen3.8-Max` → `qwen`,
 * `xiaomi/mimo-v2.6-pro` → `mimo`. The vendor prefix is dropped: two resellers' `GLM-5.x` are
 * the same model.
 */
export function familyKey(id: string): string {
	const tail = (id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id).toLowerCase();
	const tokens = tail.split(/[-_.\s]+/).filter(Boolean);
	const words: string[] = [];
	for (const token of tokens) {
		// A token carrying a digit is a version/size marker (`5.3`, `v4`, `hy3`, `k2.6`): stop.
		if (/\d/.test(token)) break;
		words.push(token);
	}
	if (words.length > 0) return words.join("-");
	// The family itself is glued to its version (`Qwen3.8`, `hy3`): use its leading letters.
	const leading = /^[a-z]+/.exec(tokens[0] ?? "");
	return leading ? leading[0] : tokens[0] ?? tail;
}

/**
 * The convention's answer for one freshly discovered id, or undefined when neither step
 * applies. `api` gates the `thinkingLevelMap` half: only the Anthropic wire inherits or
 * receives one, because on the OpenAI-shaped wires the same model ships with many different
 * maps and a copied one would be a guess about *this* gateway.
 */
export function conventionCapability(models: readonly CuratedModel[], id: string, api: string | undefined): ConventionCapability | undefined {
	const key = familyKey(id);
	// A. inherit from the curated table
	const sibling = models.find((model) => model.id !== id && familyKey(model.id) === key);
	if (sibling) {
		const map = api === "anthropic-messages" && sibling.thinkingLevelMap ? { ...sibling.thinkingLevelMap } : undefined;
		return { reasoning: sibling.reasoning === true, ...(map ? { thinkingLevelMap: map } : {}) };
	}
	// B. known reasoning family
	if (!CONVENTION_FAMILIES.includes(key)) return undefined;
	return { reasoning: true, ...(api === "anthropic-messages" ? { thinkingLevelMap: { ...ANTHROPIC_EXTENDED } } : {}) };
}
