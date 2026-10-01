/**
 * Live discovery and the merge rules for what a wire tells us.
 *
 * `refreshEntry` is one entry's refresh: synthesize the base list, resolve the credential,
 * probe every declared endpoint, merge each answer. Three process-wide maps carry the state a
 * refresh round needs — `liveSnapshots` makes pi's cache-only re-registration round harmless,
 * `vanishedByVendor` is the last *complete* round's absence set, `lastErrors` keeps a recorded
 * failure from being erased by an offline round. They are per module evaluation, i.e. per
 * loaded extension instance (the test harness re-imports for a clean slate).
 */
import { FALLBACK_CONTEXT_WINDOW, FALLBACK_MAX_TOKENS } from "./apis.ts";
import { conventionCapability } from "./convention.ts";
import { discoveryCredential } from "./credentials.ts";
import { mergeHeaders, synthesizeModels, ZERO_COST, type ModelEntry, type ProviderEntry } from "./providers.ts";
import type { LiveModelRow, LoadIssue, Vendor } from "./types.ts";
import { isObject, numberOr, stringOr, type JsonObject } from "./util.ts";

/**
 * Fetch one endpoint's model list. The auth shape is pi's: the api's own default (`anthropic-messages`
 * authenticates with `x-api-key`), plus `Authorization: Bearer` when the provider asked for it —
 * pi's `withConfiguredAuth` adds that one on top of the api's default, so the probe sends the same
 * headers the real request will send, and the shape therefore comes from the credential.
 */
async function discover(endpoint: { api: string; baseUrl: string; modelsPath?: string }, headers: JsonObject, credential: { key?: string; authHeader: boolean }, signal?: AbortSignal): Promise<LiveModelRow[]> {
	if (!endpoint.modelsPath) throw new Error("no modelsPath: no discovery for this endpoint");
	const key = credential.key;
	if (!key) throw new Error("no API key resolved");
	const url = `${endpoint.baseUrl.replace(/\/+$/, "")}${endpoint.modelsPath.startsWith("/") ? endpoint.modelsPath : `/${endpoint.modelsPath}`}`;
	const timeout = AbortSignal.timeout(10_000);
	const auth = {
		...(endpoint.api === "anthropic-messages" ? { "anthropic-version": "2023-06-01", "x-api-key": key } : { Authorization: `Bearer ${key}` }),
		...(credential.authHeader ? { Authorization: `Bearer ${key}` } : {}),
	};
	const response = await fetch(url, {
		headers: { Accept: "application/json", ...headers, ...auth } as Record<string, string>,
		signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} (GET ${url})`);
	const payload = (await response.json()) as JsonObject;
	const rows = Array.isArray(payload.data) ? payload.data : payload.models;
	if (!Array.isArray(rows)) throw new Error(`no data/models array (GET ${url})`);
	return rows.filter((row): row is LiveModelRow => isObject(row) && typeof row.id === "string");
}

/**
 * id → clone. `input`/`cost` are copied so nothing shares a reference with the list they came
 * from, and a row that skipped provider-file validation (the raw `models.json` re-read in `sync`)
 * still ends up with the array `input` every consumer assumes.
 */
function cloneById(models: readonly ModelEntry[]): Map<string, ModelEntry> {
	return new Map(
		models.map((model) => [
			model.id,
			{ ...model, input: Array.isArray(model.input) ? [...model.input] : ["text"], cost: { ...model.cost } },
		]),
	);
}

/** A row from `/models` or pi's store patches only the fields a wire owns. */
function patchLiveFields(known: ModelEntry, row: { name?: unknown; context_length?: unknown; contextWindow?: unknown }): void {
	const name = stringOr(row.name);
	const ctx = numberOr(row.context_length ?? row.contextWindow) ?? 0;
	if (name) known.name = name;
	if (ctx > 0) known.contextWindow = ctx;
}

/**
 * Apply discovery to a model list: the id set, display name and context window only. Every
 * other field stays base-owned — a reseller's bare-id registry must not silently downgrade
 * a curated model to pi's defaults. An id the base table has never seen takes its capability
 * from the naming convention in `convention.ts` (same-family inheritance, then a known-family
 * list); curated parameters only ever come from the base table.
 */
export function applyLiveModels(models: readonly ModelEntry[], rows: readonly LiveModelRow[], api?: string): { models: ModelEntry[]; unknown: string[] } {
	const byId = cloneById(models);
	const unknown: string[] = [];
	for (const row of rows) {
		const known = byId.get(row.id);
		if (known) {
			patchLiveFields(known, row);
			continue;
		}
		unknown.push(row.id);
		const convention = conventionCapability(models, row.id, api);
		byId.set(row.id, {
			id: row.id,
			name: stringOr(row.name) ?? row.id,
			reasoning: convention?.reasoning ?? false,
			...(convention?.thinkingLevelMap ? { thinkingLevelMap: convention.thinkingLevelMap } : {}),
			input: ["text"],
			contextWindow: numberOr(row.context_length ?? row.contextWindow) ?? FALLBACK_CONTEXT_WINDOW,
			maxTokens: FALLBACK_MAX_TOKENS,
			cost: { ...ZERO_COST },
		});
	}
	return { models: [...byId.values()], unknown };
}

/**
 * Merge pi's persisted snapshot into a model list. Unlike a `/models` answer, the store holds
 * what we registered last time (full definitions), so an id the base table has never seen is
 * restored *whole* instead of being rebuilt from the naming convention; an id the base table
 * knows still only takes the snapshot's live display name and context window.
 *
 * The store also holds what registration derived — `provider` plus the resolved `api`/`baseUrl`.
 * Those are dropped: an id the base table does not carry has no declared protocol (discovery
 * cannot choose one), so it must stay on the provider's default protocol, where a later
 * `providers.<id>.api`/`baseUrl` can still move it. A model on a second protocol is expressed by
 * the base table or by the user's `models.json`, not by a restored cache.
 */
export function mergeStoredSnapshot(models: readonly ModelEntry[], rows: readonly JsonObject[]): ModelEntry[] {
	const byId = cloneById(models);
	for (const row of rows) {
		const id = String(row.id);
		const known = byId.get(id);
		if (known) {
			patchLiveFields(known, row);
			continue;
		}
		const rest = { ...(row as Record<string, unknown>) };
		delete rest.provider;
		delete rest.api;
		delete rest.baseUrl;
		byId.set(id, {
			...rest,
			id,
			name: stringOr(row.name) ?? id,
			contextWindow: numberOr(row.context_length ?? row.contextWindow) ?? FALLBACK_CONTEXT_WINDOW,
			maxTokens: numberOr(row.maxTokens) ?? FALLBACK_MAX_TOKENS,
			input: Array.isArray(row.input) ? (row.input as string[]) : ["text"],
			// A registered model must always carry `cost` (pi's `calculateCost()` dereferences it).
			cost: isObject(row.cost) ? (row.cost as CatalogModel["cost"]) : { ...ZERO_COST },
		});
	}
	return [...byId.values()];
}

/**
 * This process's live list per endpoint. pi re-registers a provider by calling
 * `refreshModels` with `allowNetwork: false` right after every `registerProvider`
 * (`model-runtime.js` ends `registerProvider` with `void this.refresh({ allowNetwork: false })`),
 * so without this memo that cache-only round would overwrite the live values just registered.
 */
export const liveSnapshots = new Map<string, ModelEntry[]>();
/**
 * Base ids the last complete discovery round no longer returned, per vendor. Reported and,
 * with `sync --prune`, dropped from the base table — never dropped silently. Only a round in
 * which every discoverable endpoint answered non-empty updates it (see `refreshEntry`).
 */
export const vanishedByVendor = new Map<string, string[]>();
/** Last discovery failure per endpoint, so an offline round cannot erase it. */
export const lastErrors = new Map<string, string>();
export const endpointKey = (vendorId: string, api: string): string => `${vendorId}\u0000${api}`;

/** Every declared endpoint of a vendor: the default one plus each `apis.<api>`. */
export function vendorEndpoints(vendor: Vendor): { api: string; baseUrl: string; modelsPath?: string; headers?: JsonObject }[] {
	const { declaration } = vendor;
	return [
		{ api: declaration.api, baseUrl: declaration.baseUrl, ...(declaration.modelsPath ? { modelsPath: declaration.modelsPath } : {}), ...(declaration.headers ? { headers: declaration.headers } : {}) },
		...Object.entries(declaration.apis).map(([api, endpoint]) => ({
			api,
			baseUrl: endpoint.baseUrl,
			...(endpoint.modelsPath ?? declaration.modelsPath ? { modelsPath: endpoint.modelsPath ?? declaration.modelsPath } : {}),
			...(endpoint.headers ? { headers: endpoint.headers } : {}),
		})),
	];
}

export async function refreshEntry(
	entry: ProviderEntry,
	layer: JsonObject,
	builtin: BuiltinCatalog,
	options: { allowFetch: boolean; contextKey?: string; signal?: AbortSignal; stored?: readonly JsonObject[] },
): Promise<{ models: ModelEntry[]; live: boolean; unknown: string[]; vanished: string[]; issues: LoadIssue[] }> {
	const issues: LoadIssue[] = [];
	const models = synthesizeModels(entry, layer, builtin, issues);
	const credential = discoveryCredential(entry, layer, options.contextKey);
	// Report the missing credential before any request, naming the file and the built-in
	// variable so the fix is obvious (and never send the variable *name* as the token).
	const keyHint = `no API key: set it in custom-providers/${entry.vendor.id}/accounts.json, providers.${entry.id}.apiKey${entry.vendor.defaultAccount ? `, $${entry.vendor.defaultAccount.envVar}` : ""} or run /login ${entry.id}`;
	const storedRows = (options.stored ?? []).filter((row) => isObject(row) && typeof row.id === "string");
	let result = models;
	let live = false;
	const unknown: string[] = [];
	// Vanished tracking: the union of every *answerable* endpoint's ids, and whether any of
	// them failed or answered empty. An empty registry response is known to happen without
	// meaning deletion (SCNet quota exhaustion returns 200 + `data: []`), so it suppresses the
	// report rather than declaring the whole base table gone.
	const discoveredIds = new Set<string>();
	let attempted = 0;
	let discoverFailed = false;
	let emptyAnswer = false;

	for (const endpoint of vendorEndpoints(entry.vendor)) {
		const key = endpointKey(entry.vendor.id, endpoint.api);
		const memo = liveSnapshots.get(key);
		let list = memo ?? result;
		if (!memo && storedRows.length > 0) {
			// Restored from pi's own store: only rows that name this protocol (pi stamps `api`
			// on persisted models), plus rows that name none at all (older snapshots).
			const own = storedRows.filter((row) => row.api === undefined || row.api === endpoint.api);
			list = mergeStoredSnapshot(list, own);
		}
		if (!options.allowFetch) {
			result = list;
			live = live || memo !== undefined;
			continue;
		}
		try {
			if (!credential.key) throw new Error(keyHint);
			// The probe is per endpoint, but it only has to succeed once per process: the memo
			// keeps the result for the cache-only round pi runs right after registration.
			const rows = await discover(endpoint, mergeHeaders(endpoint.headers, entry.account?.headers) ?? {}, credential, options.signal);
			const applied = applyLiveModels(list, rows, endpoint.api);
			// Memoize unless the merged list is empty: an empty answer (a quota-exhausted wire
			// answers 200 + `[]`) over an empty base must not shadow the persisted snapshot on
			// the next round, while an empty answer over a known table is still worth keeping.
			if (applied.models.length > 0) liveSnapshots.set(key, applied.models);
			lastErrors.delete(key);
			result = applied.models;
			live = true;
			unknown.push(...applied.unknown);
			if (endpoint.modelsPath) {
				attempted += 1;
				if (rows.length === 0) emptyAnswer = true;
				for (const row of rows) discoveredIds.add(row.id);
			}
		} catch (error) {
			lastErrors.set(key, `${endpoint.api}: ${String(error)}`);
			// A failed probe keeps the list it had — this process's memo, pi's snapshot, or the
			// base table — and stays "live" when a memo is what it is serving.
			result = list;
			live = live || memo !== undefined;
			if (endpoint.modelsPath) discoverFailed = true;
		}
	}
	// Vendor-wide, not per wire: a model that moved protocol or is served only on the second
	// endpoint must not look gone just because one endpoint's registry omits it.
	let vanished: string[] = [];
	if (options.allowFetch && attempted > 0 && !discoverFailed && !emptyAnswer) {
		vanished = models.filter((model) => !discoveredIds.has(model.id)).map((model) => model.id);
		vanishedByVendor.set(entry.vendor.id, vanished);
	}
	return { models: result, live, unknown, vanished, issues };
}
