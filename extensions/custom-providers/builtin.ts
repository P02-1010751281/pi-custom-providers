/**
 * Cross-check against pi's built-in model catalog.
 *
 * pi's extension loader aliases `@earendil-works/pi-ai` to its compat entry, which
 * exports `getProviders()` / `getModels(providerId)` on top of `dist/index.js`. That
 * gives this package a second, independently maintained source of model metadata.
 *
 * It is used for three things, all deliberately narrow:
 *
 *   1. `absorbCompat` — copy a whitelist of fields that only ever *remove* request
 *      surface. Today that is `supportsTemperature: false` (pi's wording: "Claude
 *      Opus 4.7+ rejects non-default temperature values"), which is a property of the
 *      model, not of one gateway. Wire-shaping fields (`thinkingFormat`,
 *      `maxTokensField`, `supportsDeveloperRole`, `forceAdaptiveThinking`, ...) are
 *      tuned for the vendor's own endpoint and are NOT copied: a reseller that does
 *      not implement them answers 400.
 *   2. `summarizeDrift` — count where the built-in catalog disagrees with ours
 *      (`reasoning` / `input` / `maxTokens` / `contextWindow`). Never used to
 *      overwrite: the directory's `models.json` is authoritative for `maxTokens` /
 *      `contextWindow`, and built-in numbers describe the vendor's endpoint (a
 *      reseller may cap or round differently). `reasoning` / `input` are voted per
 *      field over the providers shipping the same id, so a lone third-party host
 *      cannot flip a model (design decision 18's majority rule, kept for reporting
 *      after the shipped model table was removed).
 *   3. `vendorFacts` / `unanimousFacts` — synthesize the fields of an id the base table has
 *      never seen. The model maker's own entry (`vendorFacts`: `deepseek`, `moonshotai`,
 *      `zai`, `qwen-token-plan*`, `minimax*`, ...) is the closest thing to a model fact, so it
 *      wins; a family with no vendor entry falls back to the values *every* built-in provider
 *      shipping the id agrees on (`unanimousFacts`). Neither may outrank a context window the
 *      wire itself reported — a gateway's own budget is harder than the model's spec — and
 *      `maxTokens` is capped to the window that ends up in the entry. A pi build without those
 *      exports, or an unknown family, keeps the conservative fallback. The base table stays the
 *      only place where a *choice* is written.
 *
 * A pi build that lacks the alias or those exports degrades to an empty catalog:
 * nothing is absorbed, nothing is reported, nothing throws.
 */

/**
 * Which built-in providers are a model family's *own* vendor, per pi's catalog. pi ships both the
 * vendor's plan (`deepseek`, `moonshotai`, `zai`, `qwen-token-plan*`, `minimax*` — measured from the
 * installed pi) and resellers that use bare ids too (`opencode`), so the boundary cannot be read off
 * the id shape and is stated here instead. A new vendor plan is a one-line addition.
 */
const VENDOR_HOSTS: readonly { readonly family: RegExp; readonly hosts: readonly string[] }[] = [
	{ family: /^deepseek/, hosts: ["deepseek"] },
	{ family: /^kimi/, hosts: ["moonshotai", "moonshotai-cn", "kimi-coding"] },
	{ family: /^glm/, hosts: ["zai", "zai-coding-cn"] },
	{ family: /^qwen/, hosts: ["qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual"] },
	{ family: /^minimax/, hosts: ["minimax", "minimax-cn"] },
	{ family: /^claude/, hosts: ["anthropic"] },
	{ family: /^gpt|^o[1-9]/, hosts: ["openai", "openai-codex"] },
	{ family: /^gemini/, hosts: ["google", "google-vertex"] },
	{ family: /^grok/, hosts: ["xai"] },
	{ family: /^mimo/, hosts: ["xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp"] },
];

/** The vendor hosts for a normalized id, by family; `undefined` for a family pi's catalog does not know. */
function vendorHostsFor(key: string): readonly string[] | undefined {
	return VENDOR_HOSTS.find((entry) => entry.family.test(key))?.hosts;
}

/**
 * A dated snapshot and its base model are the vendor's own two names for one model
 * (`DeepSeek-V4-Pro-0813` / `deepseek-v4-pro`), so the vendor lookup retries without a trailing
 * `MMDD`. Only used for that retry — `normalizeModelId` itself stays as it is, since merging keys
 * globally would move ids other readers already compare by.
 */
function stripSnapshot(key: string): string {
	const match = /^(.+?)(\d{4})$/.exec(key);
	if (!match) return key;
	const month = Number(match[2].slice(0, 2));
	const day = Number(match[2].slice(2));
	if (month < 1 || month > 12 || day < 1 || day > 31) return key;
	return match[1];
}

/**
 * Tails that name a *serving profile* of one model rather than another model. Measured across
 * pi's built-in entries, a `-fast` variant states the same `contextWindow`/`maxTokens` as its base
 * in 31 of 34 same-host pairs — the three exceptions are one off-by-one (1048572 vs 1048573) and
 * two rows whose `maxTokens` equals `contextWindow`; no maker host in the catalog ships the tail
 * itself, so it only ever fires for a reseller's id. Other tails stay out on the same measurement:
 * `-flash` agrees in 11 of 20 pairs, `-turbo` 1 of 5, `-thinking` 2 of 5, and `-max`/`-pro`/`-mini`
 * name genuinely different models.
 */
const SAME_MODEL_TAILS = ["fast"];

/** The base id for a serving-profile tail (`glm52fast` -> `glm52`), or the key unchanged. */
function stripSameModelTail(key: string): string {
	for (const tail of SAME_MODEL_TAILS) {
		if (key.length > tail.length && key.endsWith(tail)) return key.slice(0, -tail.length);
	}
	return key;
}

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

/**
 * Facts every built-in entry for one normalized id agrees on. A key is present only when *all*
 * providers shipping the id state the same value — the numbers describe a host's serving limits,
 * so agreement is the weakest point at which copying one is not a guess.
 */
export interface UnanimousFacts {
	contextWindow?: number;
	maxTokens?: number;
	input?: readonly string[];
}

export interface BuiltinCatalog {
	/** Normalized id -> the first built-in entry seen for it. */
	byId: ReadonlyMap<string, BuiltinModelInfo>;
	/**
	 * Normalized id -> the entry from the model maker's own provider (`VENDOR_HOSTS`), when pi's
	 * catalog ships one. The preferred source for an id the base table has never seen.
	 */
	vendor: ReadonlyMap<string, BuiltinModelInfo>;
	/**
	 * Normalized id -> per-field votes across the providers shipping it. Capabilities are
	 * model facts, so the majority decides and the provider order stops mattering.
	 */
	votes: ReadonlyMap<string, CapabilityVotes>;
	/**
	 * Normalized id -> the values every provider shipping it agrees on (absent keys = contested).
	 * This is what a discovered id may be synthesized from; `byId`'s first-wins numbers may not.
	 */
	unanimous: ReadonlyMap<string, UnanimousFacts>;
	/**
	 * Normalized ids for which *any* built-in entry says `supportsTemperature: false`.
	 * Aggregated across providers because the rejection is a model property; "false
	 * wins" is also the safe direction, since omitting `temperature` never fails.
	 */
	rejectsTemperature: ReadonlySet<string>;
	/** The pi provider ids themselves — the takeover boundary of design §8. */
	providers: ReadonlySet<string>;
	/** False when the catalog could not be read (older pi, different loader). */
	available: boolean;
}

export const EMPTY_BUILTIN_CATALOG: BuiltinCatalog = {
	byId: new Map(),
	vendor: new Map(),
	votes: new Map(),
	unanimous: new Map(),
	rejectsTemperature: new Set(),
	providers: new Set(),
	available: false,
};

/**
 * Reseller ids are namespaced (`zai-org/GLM-5.1`, `xiaomi/mimo-v2.5`) and may carry a
 * dated suffix (`claude-haiku-4-5-20251001`); pi's built-in ids are bare and lowercased
 * (`glm-5.1`, `mimo-v2.5`, `claude-haiku-4-5`). Normalizing both sides lets a curated
 * table entry match its built-in counterpart.
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
		const vendor = new Map<string, BuiltinModelInfo>();
		const votes = new Map<string, { reasoning: [number, number]; image: [number, number] }>();
		/** Per id: the distinct values seen, so agreement can be read off after the walk. */
		const seen = new Map<string, { context: Set<number>; max: Set<number>; input: Map<string, readonly string[]> }>();
		const rejectsTemperature = new Set<string>();
		for (const raw of piAi.getProviders()) {
			const provider = String(raw);
			for (const model of piAi.getModels(provider) ?? []) {
				if (!model || typeof model.id !== "string") continue;
				const key = normalizeModelId(model.id);
				if (!key) continue;
				const fields = seen.get(key) ?? { context: new Set<number>(), max: new Set<number>(), input: new Map<string, readonly string[]>() };
				if (typeof model.contextWindow === "number" && model.contextWindow > 0) fields.context.add(model.contextWindow);
				if (typeof model.maxTokens === "number" && model.maxTokens > 0) fields.max.add(model.maxTokens);
				const input = Array.isArray(model.input) ? model.input.map(String) : [];
				if (input.length > 0) fields.input.set([...input].sort().join("\u0000"), input);
				seen.set(key, fields);
				const info: BuiltinModelInfo = {
					provider,
					id: model.id,
					reasoning: model.reasoning === true,
					input: Array.isArray(model.input) ? model.input : [],
					contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : 0,
					maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : 0,
				};
				if (!byId.has(key)) byId.set(key, info);
				if (vendorHostsFor(key)?.includes(provider) && !vendor.has(key)) vendor.set(key, info);
				const vote = votes.get(key) ?? { reasoning: [0, 0] as [number, number], image: [0, 0] as [number, number] };
				vote.reasoning[model.reasoning === true ? 0 : 1] += 1;
				vote.image[(Array.isArray(model.input) ? model.input : []).includes("image") ? 0 : 1] += 1;
				votes.set(key, vote);
				if (model.compat?.supportsTemperature === false) rejectsTemperature.add(key);
			}
		}
		const unanimous = new Map<string, UnanimousFacts>();
		for (const [key, fields] of seen) {
			const facts: UnanimousFacts = {};
			if (fields.context.size === 1) facts.contextWindow = [...fields.context][0];
			if (fields.max.size === 1) facts.maxTokens = [...fields.max][0];
			if (fields.input.size === 1) facts.input = [...fields.input.values()][0];
			if (facts.contextWindow !== undefined || facts.maxTokens !== undefined || facts.input !== undefined) unanimous.set(key, facts);
		}
		return { byId, vendor, votes, unanimous, rejectsTemperature, providers: new Set(piAi.getProviders().map(String)), available: byId.size > 0 };
	} catch {
		return EMPTY_BUILTIN_CATALOG;
	}
}

/** The fillable facts of one built-in entry — an absent key stays absent. */
function factsOf(info: BuiltinModelInfo): UnanimousFacts {
	return {
		...(info.contextWindow > 0 ? { contextWindow: info.contextWindow } : {}),
		...(info.maxTokens > 0 ? { maxTokens: info.maxTokens } : {}),
		...(info.input.length > 0 ? { input: info.input } : {}),
	};
}

/**
 * The model maker's own facts for one id — `undefined` when pi's catalog ships no vendor entry for
 * its family (or the vendor does not list that model), which is when `unanimousFacts` takes over.
 * A dated snapshot also matches its base model (`DeepSeek-V4-Pro-0813` -> `deepseek-v4-pro`).
 */
export function vendorFacts(id: string, catalog: BuiltinCatalog): (UnanimousFacts & { provider: string }) | undefined {
	const key = normalizeModelId(id);
	const info = catalog.vendor.get(key) ?? catalog.vendor.get(stripSnapshot(key));
	if (!info) return undefined;
	return { provider: info.provider, ...factsOf(info) };
}

/**
 * The maker's entry for the *base* model when an id only adds a serving-profile tail and the maker
 * does not list the tailed id itself (`GLM-5.2-Fast` -> zai's `glm-5.2`): one model, two serving
 * profiles, and rate and throughput are not fields we fill. `undefined` when the exact id already
 * has a vendor entry (so this never overrides a direct hit) or when its base has none either.
 * `baseId` is the catalog's own spelling of the base model, for the report.
 */
export function vendorBaseFacts(id: string, catalog: BuiltinCatalog): (UnanimousFacts & { provider: string; baseId: string }) | undefined {
	const key = normalizeModelId(id);
	if (catalog.vendor.has(key) || catalog.vendor.has(stripSnapshot(key))) return undefined;
	const base = stripSameModelTail(stripSnapshot(key));
	if (base === key) return undefined;
	const info = catalog.vendor.get(base);
	if (!info) return undefined;
	return { provider: info.provider, baseId: info.id, ...factsOf(info) };
}

/**
 * The uncontested facts for one model id — `undefined` when its hosts disagree (or nobody ships
 * it), which is the fallback source for a discovered id.
 */
export function unanimousFacts(id: string, catalog: BuiltinCatalog): UnanimousFacts | undefined {
	return catalog.unanimous.get(normalizeModelId(id));
}

/**
 * Compat flags worth copying from pi's built-in catalog onto a model. `supportsTemperature` only exists
 * in pi's Anthropic compat, and only `false` is absorbed — `true` is pi's default and
 * would freeze a value that pi may change.
 */
export function absorbCompat(model: { id: string; api?: string }, catalog: BuiltinCatalog): CatalogCompat | undefined {
	if (model.api !== "anthropic-messages") return undefined;
	if (!catalog.rejectsTemperature.has(normalizeModelId(model.id))) return undefined;
	return { supportsTemperature: false };
}

/** Where the built-in catalog disagrees with the registered table (design decision 18). */
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
		// Vote the way decision 18's majority rule does, or `drift` would re-report
		// disagreements against a lone third-party host.
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
