/**
 * Subscription providers — register reseller/gateway LLM endpoints (CodeCommand /
 * CodeGoat and SCNet, OpenAI and Anthropic wires) using a versioned, in-repo model
 * catalog.
 *
 * Why this lives in a package instead of `~/.pi/agent/models.json`:
 *   - The provider `/models` endpoints of these resellers carry little or no
 *     metadata (SCNet returns ids only), so model parameters have to be curated.
 *     Keeping them in a gitignored `models.json` made them drift and silently
 *     fall back to pi's defaults (128000 context / 16384 output) on every refresh.
 *   - pi requires `cost` on every registered model. Omitting it makes
 *     `calculateCost()` throw `Cannot read properties of undefined (reading 'tiers')`
 *     on the first turn that reports usage.
 *
 * Layers, lowest to highest priority:
 *   1. `catalog.ts`  — committed, authoritative defaults (this package).
 *   2. `models.json` — optional per-project/user override for provider settings
 *      (`apiKey`, `authHeader`, `compat`, ...) and per-model fields (`models[]`).
 *   3. live `/models` — id discovery only. Context length and display name are
 *      refreshed when the wire provides them; other fields are never invented.
 *   4. `builtin.ts` — absorbs a whitelist of pi's built-in compat flags
 *      (`supportsTemperature: false`) and reports drift against pi's built-in
 *      catalog. It never overwrites `reasoning` / `input` / `maxTokens` /
 *      `contextWindow`: the reseller's own registry stays authoritative there.
 *
 * Compat is assembled per model (`entryFor`), because pi drops a provider-level
 * `compat` for extension providers: `applyExtension()` rebuilds each model from the
 * extension definition alone, while `models.json`'s provider-level `compat` is merged
 * into the model list *before* that replacement. Both layers are therefore re-applied
 * here, in pi's own precedence order, or they would be silently inert.
 *
 * A vendor whose wires serve the same model ids is registered as ONE pi provider:
 * `Source.providerId` groups the wires (SCNet's OpenAI and Anthropic lines), each model keeps
 * its own wire, and the wire is selected per model in `models.json` (`providers.scnet.wire`).
 * pi has no provider alias and one provider id holds a given model id only once (`model.id`
 * is the `model` value sent to the gateway), so a per-request wire switch is impossible —
 * exactly one wire is registered per model.
 *
 * Live refresh runs from pi's `refreshModels` hook, so `pi update --models` and
 * credential changes refresh these providers too, and the result is persisted to
 * `~/.pi/agent/models-store.json` for offline restore. The deferred `session_start`
 * refresh is kept so a slow network never delays the TUI.
 *
 * `models.json` remains read-only here: this extension never writes it.
 *
 * Files: `sources.ts` endpoint table (shared with the catalog generator), `types.ts`
 * shared types, `config.ts` the models.json layer, `env.ts` `.env` loading,
 * `catalog.ts` generated data, `builtin.ts` pi built-in catalog cross-check.
 */
import { homedir } from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { absorbCompat, loadBuiltinCatalog, summarizeDrift, type BuiltinCatalog, type CatalogCompat, type DriftSummary } from "./builtin.ts";
import { CATALOG } from "./catalog.ts";
import { readModelsConfig, sourceConfigFor, wireSelectionFor, type JsonObject, type WireSelection } from "./config.ts";
import { loadEnvFile } from "./env.ts";
import { SOURCES } from "./sources.ts";
import type { CatalogModel, LiveModelRow, ModelCompat, ProviderId, Source, SourceId } from "./types.ts";

const ZERO_COST: CatalogModel["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const numberOr = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const stringOr = (value: unknown, fallback: string): string =>
	typeof value === "string" && value.length > 0 ? value : fallback;

function resolveApiKey(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	if (value.startsWith("$")) return process.env[value.slice(1)] || undefined;
	// A bare UPPER_SNAKE value is an environment variable *name* (matching `apiKeyConfig`),
	// never a key: sending the name itself would turn a missing credential into a 401.
	if (/^[A-Z][A-Z0-9_]+$/.test(value)) return process.env[value] || undefined;
	return value;
}

function apiKeyConfig(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return /^[A-Z][A-Z0-9_]+$/.test(value) ? `$${value}` : value;
}

const isInput = (value: unknown): value is "text" | "image" => value === "text" || value === "image";

/** Normalize one model, guaranteeing every field pi requires — above all `cost`. */
function normalizeModel(id: string, row: JsonObject, base: CatalogModel | undefined, source: Source): CatalogModel {
	const declared = Array.isArray(row.input) ? row.input.filter(isInput) : [];
	const vision = row.capabilities?.vision === true || row.capabilities?.image === true;
	const input: ("text" | "image")[] = declared.length > 0 ? declared : vision ? ["text", "image"] : [...(base?.input ?? ["text"])];
	return {
		id,
		name: stringOr(row.name, base?.name ?? id),
		...(row.api ?? base?.api ? { api: (row.api ?? base?.api) as CatalogModel["api"] } : {}),
		...(typeof row.baseUrl === "string" && row.baseUrl.length > 0 ? { baseUrl: row.baseUrl } : {}),
		reasoning: typeof row.reasoning === "boolean" ? row.reasoning : base?.reasoning ?? false,
		input,
		contextWindow: numberOr(row.contextWindow ?? row.context_length ?? row.context ?? row.max_input_tokens, base?.contextWindow ?? 128000),
		maxTokens: numberOr(row.maxTokens ?? row.max_output_tokens ?? row.output_tokens ?? row.max_completion_tokens, base?.maxTokens ?? 16384),
		cost: { ...ZERO_COST, ...(base?.cost ?? {}), ...(row.cost ?? {}) },
		...(row.thinkingLevelMap ?? base?.thinkingLevelMap
			? { thinkingLevelMap: { ...(base?.thinkingLevelMap ?? {}), ...(row.thinkingLevelMap ?? {}) } }
			: {}),
		// Carried through so `entryFor` can layer it above the provider-level compat.
		...(row.compat && typeof row.compat === "object" ? { compat: { ...row.compat } } : {}),
	};
}

/** Deep-enough copy: `catalog.ts` objects are never handed out by reference. */
function cloneModel(model: CatalogModel): CatalogModel {
	return {
		...model,
		input: [...model.input],
		cost: { ...model.cost },
		...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
		...(model.compat ? { compat: { ...model.compat } } : {}),
	};
}

/**
 * Catalog defaults, overlaid with any matching `models.json` entries. Extra ids
 * declared only in `models.json` are appended so user-added models keep working.
 */
export function mergeCatalogModels(source: Source, sourceConfig: JsonObject): CatalogModel[] {
	const byId = new Map<string, CatalogModel>();
	for (const base of CATALOG[source.id]) byId.set(base.id, cloneModel(base));
	const declared = Array.isArray(sourceConfig.models) ? sourceConfig.models : [];
	for (const row of declared) {
		if (!row || typeof row.id !== "string") continue;
		byId.set(row.id, normalizeModel(row.id, row, byId.get(row.id), source));
	}
	return [...byId.values()];
}

/**
 * Apply a live `/models` response to the catalog. The wire only refreshes the id
 * set, display name and context length; every other field stays catalog-owned so a
 * bare-id reseller response cannot silently downgrade a model to pi's defaults.
 * Unknown ids are added with conservative defaults and returned for reporting.
 *
 * Ids that vanish from the wire are deliberately kept: a truncated or degraded
 * response must not delete a working model from the picker. Removing a model is the
 * catalog generator's job, where it is reported and reviewed.
 */
export function applyLiveModels(models: CatalogModel[], rows: LiveModelRow[], source: Source): { models: CatalogModel[]; unknown: string[] } {
	const byId = new Map(models.map((model) => [model.id, cloneModel(model)]));
	const unknown: string[] = [];
	for (const row of rows) {
		if (!row || typeof row.id !== "string") continue;
		const known = byId.get(row.id);
		const ctx = row.context_length ?? row.contextWindow;
		const messagesOnly = Array.isArray(row.supported_endpoints) && row.supported_endpoints.length > 0 && row.supported_endpoints.every((e) => e === "/messages");
		if (known) {
			if (typeof ctx === "number" && ctx > 0) known.contextWindow = ctx;
			if (typeof row.name === "string" && row.name.length > 0) known.name = row.name;
			if (messagesOnly) known.api = "anthropic-messages";
		} else {
			unknown.push(row.id);
			byId.set(row.id, {
				id: row.id,
				name: stringOr(row.name, row.id),
				...(messagesOnly ? { api: "anthropic-messages" as const } : {}),
				reasoning: false,
				input: ["text"],
				contextWindow: numberOr(ctx, 128000),
				maxTokens: 16384,
				cost: { ...ZERO_COST },
			});
		}
	}
	return { models: [...byId.values()], unknown };
}

async function fetchLiveModels(source: Source, apiKey: string | undefined, signal?: AbortSignal): Promise<LiveModelRow[]> {
	// Fail with the variable's name instead of an unexplained 401/403.
	if (!apiKey) throw new Error(`no API key: set ${source.envVar} or apiKey in models.json`);
	const anthropic = source.api === "anthropic-messages";
	const timeout = AbortSignal.timeout(10000);
	const response = await fetch(`${source.baseUrl.replace(/\/$/, "")}${source.modelsPath ?? "/models"}`, {
		headers: {
			Accept: "application/json",
			...(anthropic ? { "anthropic-version": "2023-06-01" } : {}),
			...(anthropic ? { "x-api-key": apiKey } : { Authorization: `Bearer ${apiKey}` }),
		},
		signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const payload = (await response.json()) as JsonObject;
	const rows = Array.isArray(payload.data) ? payload.data : payload.models;
	if (!Array.isArray(rows)) throw new Error("response has no data/models array");
	return rows.filter((row): row is LiveModelRow => Boolean(row && typeof row === "object" && typeof row.id === "string"));
}

export type ProviderLoadStatus = {
	id: ProviderId;
	models: number;
	/** Live data is in use (a fetch succeeded in this process, or its memo is held). */
	live: boolean;
	unknown: string[];
	/** Disagreements with pi's built-in catalog; reported, never applied. */
	drift?: DriftSummary;
	/**
	 * Last fetch failure. Kept separate from `live`, which stays true while the memo
	 * from an earlier successful fetch is still in use — otherwise a failed refresh
	 * would look like a success.
	 */
	error?: string;
	/** Per-wire split of a merged provider's list (SCNet registers `openai` + `anthropic`). */
	wires?: { wire: string; models: number; live: boolean }[];
};

/** Catalog model plus the compat flags and wire base URL assembled for it. */
type CatalogEntry = CatalogModel & { compat?: CatalogCompat & ModelCompat; baseUrl?: string };

/**
 * The wire names a user picks in `models.json` (`wire`), derived from the wire's `api`.
 * pi has no provider-alias mechanism and one provider id can hold a given model id only
 * once (`getModels(provider).find((m) => m.id === id)`, and `model.id` is the `model`
 * value sent to the gateway), so a vendor whose two wires serve the same ids cannot be two
 * providers sharing one name: it is one provider whose models each carry their own wire.
 * `Source.providerId` groups the wires — today SCNet's OpenAI and Anthropic lines.
 */
const wireName = (api: Source["api"]): string => (api === "anthropic-messages" ? "anthropic" : "openai");
const wireLabel = (wire: string): string => (wire === "anthropic" ? "Anthropic" : wire === "openai" ? "OpenAI" : wire);

type Wire = {
	name: string;
	source: Source;
	/** This wire's `models.json` entry: its own key plus inherited credentials. */
	config: JsonObject;
};

type ProviderGroup = {
	/** The pi provider id every wire in this group registers under. */
	id: ProviderId;
	name: string;
	/** Supplies the provider-level `api`/`baseUrl`/credential, and is the default wire. */
	primary: Wire;
	wires: readonly Wire[];
	/** Per-model wire preference from the provider's own `models.json` entry. */
	selection: WireSelection;
};

/** One wire's loaded model list, before the group is assembled. */
type WireLoad = {
	wire: Wire;
	models: Map<string, CatalogModel>;
	live: boolean;
	unknown: string[];
	error?: string;
	fetched: boolean;
};

/** Group the endpoint table by the pi provider id each source registers under. */
function groupSources(config: JsonObject): ProviderGroup[] {
	const grouped = new Map<ProviderId, Source[]>();
	for (const source of SOURCES) {
		const id = source.providerId ?? source.id;
		const list = grouped.get(id);
		if (list) list.push(source);
		else grouped.set(id, [source]);
	}
	return [...grouped.entries()].map(([id, sources]) => {
		// The source named after the provider id is the default one: it supplies the
		// provider-level api/baseUrl/credential the other wires do not define.
		const primarySource = sources.find((source) => source.id === id) ?? sources[0];
		const primaryConfig = sourceConfigFor(primarySource, config);
		const providerModels = Array.isArray(primaryConfig.models) ? (primaryConfig.models as JsonObject[]) : [];
		const wires: Wire[] = [primarySource, ...sources.filter((source) => source !== primarySource)].map((source) => {
			if (source === primarySource) return { name: wireName(source.api), source, config: primaryConfig };
			const wireConfig = sourceConfigFor(source, config);
			// A model declared for the provider belongs to the provider, so any of its wires can
			// serve it and the wire selection decides which does. The wire's own entries win.
			const own = Array.isArray(wireConfig.models) ? (wireConfig.models as JsonObject[]) : [];
			const declared = new Map([...providerModels, ...own].filter((row) => row && typeof row.id === "string").map((row) => [row.id as string, row]));
			return { name: wireName(source.api), source, config: { ...wireConfig, models: [...declared.values()] } };
		});
		return { id, name: primarySource.name, primary: wires[0], wires, selection: wireSelectionFor(wires[0].config) };
	});
}

/** The wire a model's own `api` field implies, when it names one of this provider's wires. */
const implicitWire = (api: string | undefined): string | undefined => (api === "anthropic-messages" ? "anthropic" : api === "openai-completions" ? "openai" : undefined);

/**
 * Wire names in the order one model's selection prefers them: its `wire` entry, the model's own
 * `api` (the pre-merge way of pointing a model at a wire, still honored), the provider default,
 * then the group's own order.
 */
function wirePreference(group: ProviderGroup, modelId: string, implicit?: string): string[] {
	return [group.selection.models[modelId], implicit, group.selection.default, ...group.wires.map((wire) => wire.name)]
		.filter((name): name is string => Boolean(name))
		.filter((name, index, all) => all.indexOf(name) === index);
}

/**
 * The wire one model ends up on. A configured wire wins when it serves the id; otherwise the
 * first wire that does wins and the unusable preference is reported — SCNet's OpenAI line is
 * the only one serving `MiniMax-M2.5`, so `wire: "anthropic"` cannot move that one model.
 */
function pickWire(group: ProviderGroup, modelId: string, servedBy: (wire: Wire) => boolean, implicit?: string): { wire: Wire; missed?: string } {
	const order = wirePreference(group, modelId, implicit);
	for (const name of order) {
		const wire = group.wires.find((entry) => entry.name === name);
		if (wire && servedBy(wire)) return { wire, ...(name !== order[0] ? { missed: order[0] } : {}) };
	}
	return { wire: group.primary, ...(order[0] ? { missed: order[0] } : {}) };
}

/** The base URL pi must use for a model on this wire; pi hands it over to that wire's client. */
function wireBaseUrl(source: Source, api: string | undefined): string {
	// pi's Anthropic client appends `/v1/messages` itself, so that wire must not inherit a
	// base that already ends in `/v1` (measured: `POST /provider/v1/v1/messages` -> 404).
	return api === "anthropic-messages" ? (source.anthropicBaseUrl ?? source.baseUrl) : source.baseUrl;
}

function asCompat(value: unknown): ModelCompat | undefined {
	return typeof value === "object" && value !== null ? (value as ModelCompat) : undefined;
}

/**
 * Assemble one model. Compat is folded in here, lowest priority first: the whitelist absorbed
 * from pi's built-in catalog, the wire's `Source.compat`, the `models.json` model entry, then
 * the wire's provider-level `compat`. pi drops provider-level compat for extension providers
 * (`applyExtension()` rebuilds every model from the extension definition alone), so it must be
 * re-applied per model or it is silently inert. That provider-level compat stays wire-scoped:
 * the entry carrying it is the wire's own, never the sibling's — an OpenAI-shaped compat key
 * on the Anthropic wire is what breaks it.
 */
function entryFor(model: CatalogModel, wire: Wire, group: ProviderGroup, builtin: BuiltinCatalog, name: string): CatalogEntry {
	const absorbed = absorbCompat(model.api ? model : { ...model, api: wire.source.api }, builtin);
	const merged: ModelCompat = { ...absorbed, ...wire.source.compat, ...model.compat, ...asCompat(wire.config.compat) };
	// Only a wire that disagrees with the provider default needs a per-model base URL;
	// leaving the default off the model keeps provider-level settings in charge of it.
	const base = model.baseUrl ?? wireBaseUrl(wire.source, model.api);
	// A model on a wire other than the provider default must carry that wire's api: without it
	// pi would apply the provider-level api and speak the wrong protocol to the right host.
	const offDefaultWire = group.wires.length > 1 && wire !== group.primary;
	return {
		...cloneModel(model),
		...(offDefaultWire ? { api: wire.source.api } : {}),
		...(name !== model.name ? { name } : {}),
		...(base !== group.primary.source.baseUrl ? { baseUrl: base } : {}),
		...(Object.keys(merged).length > 0 ? { compat: merged } : {}),
	};
}

/**
 * One model list for the whole group: the union of its wires' ids, each id taking the wire the
 * user selected for it. A model that had to stay on another wire is reported, never moved
 * silently.
 */
function assembleGroup(group: ProviderGroup, loads: readonly WireLoad[], builtin: BuiltinCatalog): { models: CatalogEntry[]; notes: string[]; counts: Map<string, number> } {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const load of loads) {
		for (const id of load.models.keys()) {
			if (seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
		}
	}
	const byWire = new Map(loads.map((load) => [load.wire, load]));
	const notes: string[] = [];
	const counts = new Map<string, number>();
	const models: CatalogEntry[] = [];
	for (const id of ids) {
		// The primary wire's entry carries the user's per-model `models.json` intent.
		const intent = byWire.get(group.primary)?.models.get(id)?.api;
		const pick = pickWire(group, id, (wire) => byWire.get(wire)?.models.has(id) === true, implicitWire(intent));
		const model = byWire.get(pick.wire)?.models.get(id);
		if (!model) continue;
		counts.set(pick.wire.name, (counts.get(pick.wire.name) ?? 0) + 1);
		if (pick.missed && pick.missed !== pick.wire.name) notes.push(`${id} is not on the "${pick.missed}" wire, kept on ${pick.wire.name}`);
		// Both wires serve the same id, so the display name is the only place a merged
		// provider can show which wire a model is on.
		const suffix = group.wires.length > 1 && pick.wire !== group.primary ? ` (${wireLabel(pick.wire.name)})` : "";
		models.push(entryFor(model, pick.wire, group, builtin, `${model.name}${suffix}`));
	}
	return { models, notes, counts };
}

/**
 * Newest live model list per wire, for this process. pi re-registers a provider by calling
 * `refreshModels` with `allowNetwork: false` right after every `registerProvider`
 * (`model-runtime.js` ends `registerProvider` with `void this.refresh({ allowNetwork: false })`),
 * so without this memo the cache-only phase would overwrite the live values the caller just
 * registered with the committed catalog.
 */
const liveSnapshots = new Map<SourceId, CatalogModel[]>();

/**
 * One wire's model list, live data first: this process's memo, else the snapshot persisted by
 * a previous session, else the committed catalog plus `models.json`. Live data only refreshes
 * the id set, display name and context length, so a bare-id reseller response cannot downgrade
 * a model to pi's defaults. A failed fetch keeps the list it had and records why.
 */
async function refreshWire(
	wire: Wire,
	options: { allowFetch: boolean; apiKey?: string; signal?: AbortSignal; stored?: readonly { id?: string; name?: string; contextWindow?: number }[] },
): Promise<{ models: CatalogModel[]; live: boolean; unknown: string[]; error?: string; fetched: boolean }> {
	const { source, config } = wire;
	const memo = liveSnapshots.get(source.id);
	let models = memo ?? mergeCatalogModels(source, config);
	if (!memo) {
		const cached = (options.stored ?? []).filter((row): row is { id: string; name?: string; contextWindow?: number } => typeof row?.id === "string");
		if (cached.length > 0) models = applyLiveModels(models, cached, source).models;
	}
	if (!options.allowFetch) return { models, live: memo !== undefined, unknown: [], fetched: false };
	try {
		const applied = applyLiveModels(models, await fetchLiveModels(source, options.apiKey, options.signal), source);
		liveSnapshots.set(source.id, applied.models);
		return { models: applied.models, live: true, unknown: applied.unknown, fetched: true };
	} catch (error) {
		return { models, live: memo !== undefined, unknown: [], error: String(error), fetched: false };
	}
}

/**
 * Load every wire of a group (network only when `allowFetch`) and merge the results into one
 * model list. Failures stay per wire: one dead wire must not make the whole provider look
 * dead, and the merge keeps serving the other wire's models.
 */
async function loadGroup(
	group: ProviderGroup,
	builtin: BuiltinCatalog,
	options: { allowFetch: boolean; credential?: string; signal?: AbortSignal; stored?: readonly { id?: string; name?: string; contextWindow?: number }[] },
): Promise<{ models: CatalogEntry[]; status: ProviderLoadStatus; fetched: boolean; notes: string[] }> {
	const loads: WireLoad[] = await Promise.all(
		group.wires.map(async (wire) => {
			const result = await refreshWire(wire, {
				allowFetch: options.allowFetch,
				// A wire's own key wins; the provider-level credential is the primary wire's.
				apiKey: resolveApiKey(wire.config.apiKey ?? wire.source.envVar) ?? options.credential,
				signal: options.signal,
				stored: options.stored,
			});
			return { wire, models: new Map(result.models.map((model) => [model.id, model])), live: result.live, unknown: result.unknown, error: result.error, fetched: result.fetched };
		}),
	);
	const { models, notes, counts } = assembleGroup(group, loads, builtin);
	const errors = loads.filter((load) => load.error).map((load) => `${load.wire.name}: ${load.error}`);
	const status: ProviderLoadStatus = {
		id: group.id,
		models: models.length,
		live: loads.every((load) => load.live),
		unknown: loads.flatMap((load) => load.unknown),
		...(group.wires.length > 1 ? { wires: loads.map((load) => ({ wire: load.wire.name, models: counts.get(load.wire.name) ?? 0, live: load.live })) } : {}),
		...(builtin.available ? { drift: summarizeDrift(models, builtin) } : {}),
		...(errors.length > 0 ? { error: errors.join("; ") } : {}),
	};
	return { models, status, fetched: loads.some((load) => load.fetched), notes };
}

/** pi persists resolved `Model` objects; ours only lack the provider/api/baseUrl it stamps on. */
function toPersistableModels(models: readonly CatalogEntry[], group: ProviderGroup): JsonObject[] {
	return models.map((model) => ({
		...model,
		api: model.api ?? group.primary.source.api,
		provider: group.id,
		baseUrl: model.baseUrl ?? group.primary.source.baseUrl,
	}));
}

/**
 * Register one provider id. The group's primary wire supplies the provider-level
 * `api`/`baseUrl`/credential; every model keeps its own wire. `refreshModels` refreshes all
 * wires of the group and persists the merged list.
 */
function registerGroup(
	pi: ExtensionAPI,
	group: ProviderGroup,
	models: readonly CatalogEntry[],
	builtin: BuiltinCatalog,
	record: (status: ProviderLoadStatus, options?: { keepExisting?: boolean }) => void,
): void {
	const { primary } = group;
	const apiKey = apiKeyConfig(primary.config.apiKey ?? primary.source.envVar);
	pi.registerProvider(group.id, {
		name: group.name,
		baseUrl: primary.source.baseUrl,
		api: primary.source.api,
		...(apiKey ? { apiKey } : {}),
		...(primary.config.authHeader !== undefined || primary.source.authHeader !== undefined ? { authHeader: primary.config.authHeader ?? primary.source.authHeader } : {}),
		// No provider-level `compat` here: pi only reads compat per model, which `entryFor`
		// already merged in.
		models,
		// pi calls this on `pi update --models`, on credential changes and during online
		// startup; the returned list replaces the extension-provided models.
		refreshModels: async (context) => {
			const result = await loadGroup(group, builtin, {
				allowFetch: context.allowNetwork,
				credential: context.credential?.type === "api_key" ? context.credential.key : undefined,
				signal: context.signal,
				stored: context.stored?.models,
			});
			// pi re-registers with `allowNetwork: false` after every registerProvider, so a
			// cache-only round follows each registration. It adds no information and must not
			// erase the error from the refresh that just failed.
			record(result.status, { keepExisting: !context.allowNetwork });
			if (result.fetched && !context.signal.aborted) {
				await context.publish({ persist: { models: toPersistableModels(result.models, group), checkedAt: Date.now() } });
			}
			return result.models;
		},
	});
}

/** Compact one-line-per-provider drift counts against pi's built-in catalog. */
function driftProblems(statuses: readonly ProviderLoadStatus[]): string[] {
	return statuses
		.map((status) => {
			const drift = status.drift;
			if (!drift) return undefined;
			const parts = [
				drift.reasoning.length > 0 ? `reasoning ${drift.reasoning.length}` : undefined,
				drift.input.length > 0 ? `input ${drift.input.length}` : undefined,
				drift.maxTokens.length > 0 ? `maxTokens ${drift.maxTokens.length}` : undefined,
				drift.contextWindow.length > 0 ? `contextWindow ${drift.contextWindow.length}` : undefined,
			].filter(Boolean);
			return parts.length > 0 ? `${status.id}: pi built-in differs (${parts.join(", ")})` : undefined;
		})
		.filter((line): line is string => Boolean(line));
}

function statusProblems(statuses: ProviderLoadStatus[], configIssue?: string, notes: readonly string[] = []): string[] {
	return [
		...(configIssue ? [configIssue] : []),
		...(notes.length > 0 ? [`wire selection: ${notes.join("; ")}`] : []),
		...statuses
			.filter((status) => status.error)
			.map((status) => `${status.id}: refresh failed, using ${status.models} model(s)${status.live ? " from the last successful fetch" : " from the catalog"} (${status.error})`),
		...statuses
			.filter((status) => !status.error && !status.live)
			.map((status) => `${status.id}: live catalog unavailable, using ${status.models} catalog model(s)`),
		...statuses
			.filter((status) => status.unknown.length > 0)
			.map((status) => `${status.id}: ${status.unknown.length} new model(s) not in catalog: ${status.unknown.join(", ")}`),
	];
}

export default async function subscriptionProviders(pi: ExtensionAPI) {
	// Never write to stderr: raw output corrupts the TUI. Report issues via the session UI instead.
	loadEnvFile(path.join(getAgentDir(), ".env"));
	loadEnvFile(path.join(homedir(), ".omp", "agent", ".env"));

	const { config, issue: configIssue } = readModelsConfig();
	const builtin = await loadBuiltinCatalog();
	const statuses = new Map<ProviderId, ProviderLoadStatus>();
	/** Models that could not take the wire their configuration asked for, from the last refresh. */
	const wireNotes: string[] = [];
	const record = (status: ProviderLoadStatus, options: { keepExisting?: boolean } = {}): void => {
		if (options.keepExisting && statuses.has(status.id)) return;
		statuses.set(status.id, status);
	};

	// Every wire of a group registers under one pi provider id, so the model list is a
	// merge: SCNet's two lines become one `scnet` whose models each carry their own wire.
	const groups = groupSources(config);

	// Startup path: register the committed catalog plus absorbed compat, no network I/O.
	for (const group of groups) {
		const result = await loadGroup(group, builtin, { allowFetch: false });
		record(result.status);
		registerGroup(pi, group, result.models, builtin, record);
	}

	const refresh = async (): Promise<{ count: number; statuses: ProviderLoadStatus[] }> => {
		const results = await Promise.all(groups.map(async (group) => {
			const result = await loadGroup(group, builtin, { allowFetch: true });
			record(result.status);
			// Re-register so refreshed models reach pi outside its own refresh phase.
			registerGroup(pi, group, result.models, builtin, record);
			return result;
		}));
		wireNotes.length = 0;
		wireNotes.push(...results.flatMap((result) => result.notes));
		const refreshed = results.map((result) => result.status).sort((a, b) => a.id.localeCompare(b.id));
		return { count: refreshed.reduce((sum, status) => sum + status.models, 0), statuses: refreshed };
	};

	const sortedStatuses = (): ProviderLoadStatus[] => [...statuses.values()].sort((a, b) => a.id.localeCompare(b.id));

	pi.on("session_start", async (_event, ctx) => {
		// Live id refresh runs after startup so slow networks never delay the TUI.
		try {
			await refresh();
		} catch {
			// Keep catalog registrations when the refresh itself throws.
		}
		const problems = [...statusProblems(sortedStatuses(), configIssue, wireNotes), ...driftProblems(sortedStatuses())];
		if (problems.length > 0 && ctx.hasUI) ctx.ui.notify(`Subscription providers: ${problems.join("; ")}`, "warning");
	});

	pi.registerCommand("refresh-custom-models", {
		description: "Refresh CodeCommand and SCNet model catalogs",
		handler: async (_args, ctx) => {
			const result = await refresh();
			const failed = result.statuses.filter((status) => status.error);
			const unknown = result.statuses.flatMap((status) => status.unknown.map((id) => `${status.id}/${id}`));
			const detail = [
				...wireNotes,
				...(failed.length > 0 ? [`failed: ${failed.map((status) => `${status.id} (${status.error})`).join(", ")}`] : []),
				...(unknown.length > 0 ? [`new: ${unknown.join(", ")}`] : []),
			].join("; ");
			ctx.ui.notify(
				`Refreshed ${result.count} subscription models${detail ? `; ${detail}` : ""}`,
				failed.length > 0 || unknown.length > 0 || wireNotes.length > 0 ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("custom-providers", {
		description: "Show subscription provider status; add `drift` for built-in catalog differences",
		handler: async (args, ctx) => {
			const current = sortedStatuses();
			if (args.trim() === "drift") {
				const lines = current.flatMap((status) => {
					const drift = status.drift;
					if (!drift) return [];
					return [...drift.reasoning, ...drift.input, ...drift.maxTokens, ...drift.contextWindow];
				});
				// A toast cannot hold the full list (100+ lines); the counts stay in the summary.
				const shown = lines.slice(0, 8);
				const more = lines.length > shown.length ? ` (+${lines.length - shown.length} more)` : "";
				ctx.ui.notify(
					lines.length > 0 ? `Built-in catalog drift (reported, not applied) -> ${shown.join("; ")}${more}` : "No differences from pi's built-in catalog for catalog models",
					"info",
				);
				return;
			}
			const lines = current.map((status) => {
				const source = status.live ? "live" : "catalog";
				// A merged provider reports its wires, so a model half-way through a re-wire is visible.
				const wires = status.wires ? ` [${status.wires.map((wire) => `${wire.wire} ${wire.models}${wire.live ? "" : " (catalog)"}`).join(", ")}]` : "";
				const extra = status.unknown.length > 0 ? `, new: ${status.unknown.join(", ")}` : "";
				const matched = status.drift ? `, ${status.drift.matched} match pi built-in` : "";
				const failure = status.error ? `, last refresh failed: ${status.error}` : "";
				return `${status.id}: ${status.models} models (${source})${wires}${extra}${matched}${failure}`;
			});
			const drift = driftProblems(current);
			ctx.ui.notify(`Subscription providers -> ${lines.join("; ")}${drift.length > 0 ? `; ${drift.join("; ")}` : ""}`, "info");
		},
	});
}
