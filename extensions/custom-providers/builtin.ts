/**
 * Cross-check against pi's built-in model catalog.
 *
 * pi's extension loader aliases `@earendil-works/pi-ai` to its compat entry, which
 * exports `getProviders()` / `getModels(providerId)` on top of `dist/index.js`. That
 * gives this package a second, independently maintained source of model metadata.
 *
 * It is used for exactly two things, both deliberately narrow:
 *
 *   1. `absorbCompat` — copy a whitelist of fields that only ever *remove* request
 *      surface. Today that is `supportsTemperature: false` (pi's wording: "Claude
 *      Opus 4.7+ rejects non-default temperature values"), which is a property of the
 *      model, not of one gateway. Wire-shaping fields (`thinkingFormat`,
 *      `maxTokensField`, `supportsDeveloperRole`, `forceAdaptiveThinking`, ...) are
 *      tuned for the vendor's own endpoint and are NOT copied: a reseller that does
 *      not implement them answers 400.
 *   2. `capabilityAuthority` / `builtinLevelMap` — the *authority* for `reasoning` and
 *      `input` (user ruling 2026-09-18, design decision 18). The relays publish no
 *      capability metadata at all, and the reseller's docs page contradicts itself,
 *      while pi's catalog agrees across the providers shipping the same model, so the
 *      built-in catalog decides — per field, by majority vote over those providers
 *      (a lone third-party host cannot flip a model). `scripts/refresh-catalog.mjs`
 *      writes the result into `catalog.ts`, and `summarizeDrift` votes the same way,
 *      so the two can never disagree about what the built-in catalog says.
 *   3. `summarizeDrift` — count where the built-in catalog disagrees with ours
 *      (`reasoning` / `input` / `maxTokens` / `contextWindow`). Never used to
 *      overwrite: `catalog.ts` is proxy-authoritative for `maxTokens` /
 *      `contextWindow`, and built-in numbers describe the vendor's endpoint (a
 *      reseller may cap or round differently).
 *
 * `thinkingLevelMap` is *not* voted on across providers: an OpenAI-shaped effort map is
 * gateway-specific (the same id ships 9 different maps across hosts, using `off: "none"`,
 * `minimal: null`, ...), so copying another gateway's map would send values the endpoint
 * rejects. Only the `anthropic-messages` map is a model fact (Anthropic's adaptive-effort
 * levels, identical across its own endpoints), and only that one is exposed to callers.
 *
 * A pi build that lacks the alias or those exports degrades to an empty catalog:
 * nothing is absorbed, nothing is reported, nothing throws.
 */

/** pi's compat flags this package is willing to absorb (see the module doc). */
export interface CatalogCompat {
	supportsTemperature?: boolean;
}

/** How many built-in providers voted for each value of a boolean capability. */
export interface CapabilityVotes {
	/** `[yes, no]` over every built-in entry shipped for this normalized id. */
	reasoning: readonly [number, number];
	image: readonly [number, number];
}

export interface BuiltinModelInfo {
	provider: string;
	id: string;
	reasoning: boolean;
	input: readonly string[];
	contextWindow: number;
	maxTokens: number;
}

export interface BuiltinCatalog {
	/** Normalized id -> the first built-in entry seen for it. */
	byId: ReadonlyMap<string, BuiltinModelInfo>;
	/**
	 * Normalized id -> per-field votes across the providers shipping it. Capabilities are
	 * model facts, so the majority decides and the provider order stops mattering.
	 */
	votes: ReadonlyMap<string, CapabilityVotes>;
	/**
	 * Normalized id -> api -> serialized `thinkingLevelMap` -> how many providers ship it.
	 * Only `anthropic-messages` maps are model facts (see the module doc); the rest are
	 * read for reporting, never applied.
	 */
	levelMaps: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, number>>>;
	/**
	 * Normalized ids for which *any* built-in entry says `supportsTemperature: false`.
	 * Aggregated across providers because the rejection is a model property; "false
	 * wins" is also the safe direction, since omitting `temperature` never fails.
	 */
	rejectsTemperature: ReadonlySet<string>;
	/** False when the catalog could not be read (older pi, different loader). */
	available: boolean;
}

export const EMPTY_BUILTIN_CATALOG: BuiltinCatalog = {
	byId: new Map(),
	votes: new Map(),
	levelMaps: new Map(),
	rejectsTemperature: new Set(),
	available: false,
};

/**
 * Reseller ids are namespaced (`zai-org/GLM-5.1`, `xiaomi/mimo-v2.5`) and may carry a
 * dated suffix (`claude-haiku-4-5-20251001`); pi's built-in ids are bare and lowercased
 * (`glm-5.1`, `mimo-v2.5`, `claude-haiku-4-5`). Normalizing both sides matches
 * 101 of this catalog's 107 models against the built-in catalog.
 */
export function normalizeModelId(id: string): string {
	const tail = id.split("/").pop() ?? id;
	return tail
		.toLowerCase()
		.replace(/-\d{8}$/, "")
		.replace(/[-_.\s]+/g, "");
}

/** Read pi's built-in catalog through the extension loader alias. Never throws. */
export async function loadBuiltinCatalog(): Promise<BuiltinCatalog> {
	try {
		const piAi = (await import("@earendil-works/pi-ai")) as {
			getProviders?: () => readonly unknown[];
			getModels?: (provider: string) => readonly any[];
		};
		if (typeof piAi.getProviders !== "function" || typeof piAi.getModels !== "function") return EMPTY_BUILTIN_CATALOG;
		const byId = new Map<string, BuiltinModelInfo>();
		const votes = new Map<string, { reasoning: [number, number]; image: [number, number] }>();
		const levelMaps = new Map<string, Map<string, Map<string, number>>>();
		const rejectsTemperature = new Set<string>();
		for (const raw of piAi.getProviders()) {
			const provider = String(raw);
			for (const model of piAi.getModels(provider) ?? []) {
				if (!model || typeof model.id !== "string") continue;
				const key = normalizeModelId(model.id);
				if (!key) continue;
				if (!byId.has(key)) {
					byId.set(key, {
						provider,
						id: model.id,
						reasoning: model.reasoning === true,
						input: Array.isArray(model.input) ? model.input : [],
						contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : 0,
						maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : 0,
					});
				}
				const vote = votes.get(key) ?? { reasoning: [0, 0] as [number, number], image: [0, 0] as [number, number] };
				vote.reasoning[model.reasoning === true ? 0 : 1] += 1;
				vote.image[(Array.isArray(model.input) ? model.input : []).includes("image") ? 0 : 1] += 1;
				votes.set(key, vote);
				if (model.thinkingLevelMap && typeof model.api === "string") {
					const perApi = levelMaps.get(key) ?? new Map<string, Map<string, number>>();
					const perMap = perApi.get(model.api) ?? new Map<string, number>();
					const serialized = JSON.stringify(model.thinkingLevelMap);
					perMap.set(serialized, (perMap.get(serialized) ?? 0) + 1);
					perApi.set(model.api, perMap);
					levelMaps.set(key, perApi);
				}
				if (model.compat?.supportsTemperature === false) rejectsTemperature.add(key);
			}
		}
		return { byId, votes, levelMaps, rejectsTemperature, available: byId.size > 0 };
	} catch {
		return EMPTY_BUILTIN_CATALOG;
	}
}

/**
 * Compat flags worth copying onto a catalog model. `supportsTemperature` only exists
 * in pi's Anthropic compat, and only `false` is absorbed — `true` is pi's default and
 * would freeze a value that pi may change.
 */
export function absorbCompat(model: { id: string; api?: string }, catalog: BuiltinCatalog): CatalogCompat | undefined {
	if (model.api !== "anthropic-messages") return undefined;
	if (!catalog.rejectsTemperature.has(normalizeModelId(model.id))) return undefined;
	return { supportsTemperature: false };
}

/**
 * pi's value for a capability, or undefined where it is silent or the providers tie.
 * `voters` is how many built-in entries shipped the id — reported, so a 1-vote entry
 * (a lone third-party host) is visible in the output instead of looking authoritative.
 */
export function capabilityAuthority(
	catalog: BuiltinCatalog,
	id: string,
): { reasoning?: boolean; image?: boolean; voters: number } | undefined {
	const votes = catalog.votes.get(normalizeModelId(id));
	if (!votes) return undefined;
	const pick = ([yes, no]: readonly [number, number]) => (yes === no ? undefined : yes > no);
	const reasoning = pick(votes.reasoning);
	const image = pick(votes.image);
	if (reasoning === undefined && image === undefined) return undefined;
	return { reasoning, image, voters: votes.reasoning[0] + votes.reasoning[1] };
}

/**
 * The built-in `thinkingLevelMap` for a model on one wire, or undefined when the
 * built-in catalog is silent, ties, or the wire's map is not transferable.
 *
 * Gated to `anthropic-messages` on purpose: there the map is Anthropic's adaptive-effort
 * mapping (which levels exist, and that `off: null` means thinking cannot be disabled),
 * a fact about the model. On the OpenAI-shaped wires the same model is shipped with up
 * to nine different maps across gateways, so another gateway's map must not be copied.
 */
export function builtinLevelMap(catalog: BuiltinCatalog, id: string, api: string | undefined): Record<string, unknown> | undefined {
	if (api !== "anthropic-messages") return undefined;
	const perMap = catalog.levelMaps.get(normalizeModelId(id))?.get(api);
	if (!perMap || perMap.size === 0) return undefined;
	const ranked = [...perMap.entries()].sort((a, b) => b[1] - a[1]);
	const [serialized, count] = ranked[0];
	const total = ranked.reduce((sum, [, n]) => sum + n, 0);
	if (count * 2 <= total) return undefined; // tie → pi has no majority opinion
	return JSON.parse(serialized) as Record<string, unknown>;
}

export interface DriftSummary {
	/** Catalog models whose normalized id exists in the built-in catalog. */
	matched: number;
	reasoning: string[];
	input: string[];
	maxTokens: string[];
	contextWindow: string[];
}

/**
 * Per-field disagreements with the built-in catalog, as `field id: ours != builtin`.
 * Callers decide whether to surface the detail; the counts alone are the default.
 */
export function summarizeDrift(
	models: readonly { id: string; api?: string; reasoning: boolean; input: readonly string[]; contextWindow: number; maxTokens: number }[],
	catalog: BuiltinCatalog,
): DriftSummary {
	const summary: DriftSummary = { matched: 0, reasoning: [], input: [], maxTokens: [], contextWindow: [] };
	for (const model of models) {
		const builtin = catalog.byId.get(normalizeModelId(model.id));
		if (!builtin) continue;
		summary.matched += 1;
		const who = `${model.id} (builtin ${builtin.provider})`;
		// Vote the same way the generator does, or `drift` would re-report disagreements
		// that decision 18 already settled against the built-in majority.
		const votes = catalog.votes.get(normalizeModelId(model.id));
		const pick = ([yes, no]: readonly [number, number]) => (yes === no ? undefined : yes > no);
		const builtinReasoning = votes ? pick(votes.reasoning) ?? builtin.reasoning : builtin.reasoning;
		const builtinImage = votes ? pick(votes.image) ?? builtin.input.includes("image") : builtin.input.includes("image");
		if (builtinReasoning !== model.reasoning) summary.reasoning.push(`${who}: ours=${model.reasoning} builtin=${builtinReasoning}`);
		const vision = model.input.includes("image");
		if (builtinImage !== vision) summary.input.push(`${who}: ours=${vision ? "image" : "text"} builtin=${builtinImage ? "image" : "text"}`);
		if (builtin.maxTokens > 0 && builtin.maxTokens !== model.maxTokens) summary.maxTokens.push(`${who}: ours=${model.maxTokens} builtin=${builtin.maxTokens}`);
		if (builtin.contextWindow > 0 && builtin.contextWindow !== model.contextWindow) summary.contextWindow.push(`${who}: ours=${model.contextWindow} builtin=${builtin.contextWindow}`);
	}
	return summary;
}
