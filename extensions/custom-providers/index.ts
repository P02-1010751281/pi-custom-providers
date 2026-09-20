/**
 * custom-providers — register reseller/gateway LLM endpoints (Command Code / GOAT and
 * SCNet, OpenAI-shaped and Anthropic-shaped) using a versioned, in-repo model catalog plus
 * an optional per-vendor directory of configuration files.
 *
 * Why this lives in a package instead of `~/.pi/agent/models.json`:
 *   - The resellers' `/models` endpoints carry little or no metadata (SCNet returns ids
 *     only), so model parameters have to be curated. Keeping them in a gitignored
 *     `models.json` made them drift and silently fall back to pi's defaults.
 *   - pi requires `cost` on every registered model; omitting it makes `calculateCost()`
 *     throw on the first turn that reports usage.
 *   - A vendor often has two protocol endpoints serving the same ids, which pi's file layer
 *     cannot express (one provider id holds a given model id only once, and `model.id` is
 *     the value sent to the gateway, so a per-request protocol switch is impossible).
 *
 * What this extension adds, in pi's own vocabulary: `apis` (a second protocol endpoint),
 * `modelsPath` (discovery path), `override` (taking over a built-in provider id) and
 * `accounts.json` (more than one credential for the same product).
 *
 * The layer chain is four deep and every step is a per-field patch (design §4):
 *
 *   1. base model table — `catalog.ts` for a built-in vendor, `<id>/models.json` otherwise
 *   2. `provider.json` — the default protocol + endpoint (`api` / `baseUrl`) and `apis`
 *   3. pi's global `models.json` — `providers.<id>` (provider fields) and `models[]` entries
 *   4. `modelOverrides` — pi applies this one itself, last; we neither read nor fight it
 *
 * pi drops a provider-level `baseUrl` / `api` / `name` / `compat` for extension providers
 * (`applyExtension()` rebuilds every model from the extension definition alone), so layers
 * 1–3 are re-applied here. Two consequences are deliberate: compat is assembled per model
 * entry, and `baseUrl` keeps pi's own meaning (`config.baseUrl ?? model.baseUrl`) by being
 * passed as the provider-level base URL rather than stamped onto every model.
 *
 * Live refresh runs from pi's `refreshModels` hook, so `pi update --models` and credential
 * changes refresh these providers too, and results are persisted to
 * `~/.pi/agent/models-store.json` for offline restore. `models.json` is never written; the
 * only writer in this package is `custom-providers sync --write`.
 *
 * Files: `sources.ts` built-in vendors (shared with the catalog generator), `config.ts` pi's
 * api vocabulary + the `models.json` layer, `provider-files.ts` the directory layer,
 * `sync-models.ts` the one writer, `catalog.ts` generated data, `builtin.ts` pi cross-check.
 */
import { homedir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { getAgentDir, readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { absorbCompat, loadBuiltinCatalog, summarizeDrift, type BuiltinCatalog, type CatalogCompat, type DriftSummary } from "./builtin.ts";
import { CATALOG } from "./catalog.ts";
import { applyModelPatch, normalizeApi, providerLayerFor, readModelsConfig, resolveModelEndpoint, type JsonObject } from "./config.ts";
import { loadEnvFile } from "./env.ts";
import { collectVendors } from "./provider-files.ts";
import { SOURCES } from "./sources.ts";
import { diffBaseTable, readBaseTable, summarizeDiff, writeBaseTable } from "./sync-models.ts";
import type { Account, CatalogModel, LiveModelRow, LoadIssue, ModelCompat, Vendor } from "./types.ts";

const ZERO_COST: CatalogModel["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PROVIDER_ROOT = () => path.join(getAgentDir(), "custom-providers");

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const stringOr = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const numberOr = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);

/** Resolve one pi value expression (`$VAR` / `${VAR}` / `$$` / `$!` / `!command` / literal). */
export function resolveConfigValue(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (value === undefined) return undefined;
	if (value.startsWith("$$")) return value.slice(1);
	if (value.startsWith("$!")) return value.slice(1);
	const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
	if (braced) return env[braced[1]] || undefined;
	const plain = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
	if (plain) return env[plain[1]] || undefined;
	if (value.startsWith("!")) {
		try {
			return execSync(value.slice(1), { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
		} catch {
			return undefined;
		}
	}
	// A bare UPPER_SNAKE value is an environment variable *name*: pi would send the name
	// itself as the token (`resolve-config-value.js` treats a bare string as a literal).
	if (/^[A-Z][A-Z0-9_]*$/.test(value)) return env[value] || undefined;
	return value;
}

/** The value we hand pi: bare `UPPER_SNAKE` becomes `$VAR`, since pi only interpolates `$…`. */
const configValueForPi = (value: string | undefined): string | undefined =>
	value === undefined ? undefined : /^[A-Z][A-Z0-9_]*$/.test(value) ? `$${value}` : value;

/** One registrable pi provider: a vendor, plus the account that supplies its credentials. */
interface ProviderEntry {
	id: string;
	name: string;
	vendor: Vendor;
	account?: Account;
	/** True for the entry that registers as `<vendor id>`. */
	base: boolean;
}

function entriesFor(vendor: Vendor): ProviderEntry[] {
	const entries: ProviderEntry[] = [];
	if (!vendor.baseSuppressed) {
		entries.push({
			id: vendor.id,
			name: vendor.name,
			vendor,
			...(vendor.baseAccount ? { account: vendor.baseAccount } : {}),
			base: true,
		});
	}
	for (const account of vendor.accounts) {
		if (vendor.baseAccount && account.id === vendor.baseAccount.id) continue;
		entries.push({ id: `${vendor.id}-${account.id}`, name: `${vendor.name} (${account.id})`, vendor, account, base: false });
	}
	return entries;
}

/** One model, after the layer chain ran: the shape handed to `registerProvider`. */
type ModelEntry = CatalogModel & { compat?: CatalogCompat & ModelCompat };

/** Fields of the model entry, in the order the layer chain writes them. */
function mergeHeaders(...layers: (JsonObject | undefined)[]): JsonObject | undefined {
	const merged: JsonObject = {};
	for (const layer of layers) {
		if (!layer) continue;
		for (const [key, value] of Object.entries(layer)) merged[key] = value;
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Synthesize one provider entry's model list: base table ⊕ `models.json` patches, with the
 * endpoint, headers and compat of the layer the model ends up on (design §4/§5.2/§5.3).
 * `issues` collects everything that had to be reported instead of applied.
 */
function synthesizeModels(entry: ProviderEntry, layer: JsonObject, builtin: BuiltinCatalog, issues: LoadIssue[]): ModelEntry[] {
	const { vendor } = entry;
	const declaration = vendor.declaration;
	const patches = new Map<string, JsonObject>();
	for (const row of Array.isArray(layer.models) ? (layer.models as unknown[]) : []) {
		if (!isObject(row)) continue;
		const id = stringOr(row.id);
		if (!id) {
			issues.push({ level: "warning", message: `${entry.id}: models[] entry has no "id"` });
			continue;
		}
		patches.set(id, row);
	}
	const base = new Map<string, CatalogModel>();
	for (const model of vendor.models) base.set(model.id, { ...model, input: [...model.input], cost: { ...model.cost } });
	for (const [id, row] of patches) {
		if (base.has(id)) continue;
		// An id only the user declares still needs a complete entry for pi: `registerProvider`
		// throws on a model without cost, and pi's request path dereferences it.
		base.set(id, { id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384, cost: { ...ZERO_COST } });
	}

	const multiEndpoint = Object.keys(declaration.apis).length > 0;
	const models: ModelEntry[] = [];
	for (const [id, raw] of base) {
		const patch = patches.get(id);
		const merged = applyModelPatch(raw as unknown as JsonObject, patch ?? {}) as unknown as CatalogModel;
		const choice = resolveModelEndpoint(declaration, layer, merged);
		for (const issue of choice.issues) issues.push({ level: "warning", message: `${entry.id}: ${issue}` });
		const endpoint = choice.endpoint;

		// Compat is a model property (pi only reads it per model), layered lowest first: the
		// whitelist absorbed from pi's built-in catalog, the model entry, then the user's
		// provider-level block — which only reaches models on the effective default protocol
		// (design §5.3, decision 17: moving an OpenAI-shaped compat onto an Anthropic endpoint
		// is a cross-family copy pi itself would not make).
		const absorbed = absorbCompat({ id, api: endpoint.api }, builtin);
		const compat: ModelCompat = {
			...absorbed,
			...(merged.compat ?? {}),
			...(choice.stampApi ? {} : isObject(layer.compat) ? layer.compat : {}),
		};

		const accountSuffix = entry.base || !entry.account ? "" : ` (${entry.account.id})`;
		const protocolSuffix = multiEndpoint && choice.stampApi ? ` (${endpoint.api})` : "";
		models.push({
			...merged,
			id,
			name: `${merged.name}${accountSuffix}${protocolSuffix}`,
			...(choice.stampApi ? { api: endpoint.api } : {}),
			...(choice.stampBaseUrl ? { baseUrl: endpoint.baseUrl } : {}),
			headers: mergeHeaders(declaration.headers, endpoint.headers, entry.account?.headers, merged.headers),
			...(Object.keys(compat).length > 0 ? { compat } : {}),
		});
	}
	return models;
}

/**
 * The *base* view of a model list: what `sync --write` stores and what `catalog.ts` holds.
 * Derived products stay out of it — the protocol suffix on the display name and the
 * endpoint's base URL are computed at registration time (design §4/§5.2), so writing them
 * back would freeze a layer-2 computation into the layer-1 table.
 */
function baseTableView(models: readonly CatalogModel[], declaration: ProviderDeclaration, issues: LoadIssue[]): CatalogModel[] {
	return models.map((model) => {
		const choice = resolveModelEndpoint(declaration, {}, model);
		for (const issue of choice.issues) issues.push({ level: "warning", message: issue });
		// A model on the default protocol carries no `api` at all: that is what keeps
		// `providers.<id>.api`/`baseUrl` able to redirect it later.
		return choice.stampApi ? { ...model, api: choice.endpoint.api } : model;
	});
}

/** Fetch one endpoint's model list. The auth shape follows the protocol, not the account. */
async function discover(endpoint: { api: string; baseUrl: string; modelsPath?: string }, headers: JsonObject, apiKey: string | undefined, signal?: AbortSignal): Promise<LiveModelRow[]> {
	if (!endpoint.modelsPath) throw new Error("no modelsPath: no discovery for this endpoint");
	if (!apiKey) throw new Error("no API key resolved");
	const url = `${endpoint.baseUrl.replace(/\/+$/, "")}${endpoint.modelsPath.startsWith("/") ? endpoint.modelsPath : `/${endpoint.modelsPath}`}`;
	const timeout = AbortSignal.timeout(10_000);
	const auth = endpoint.api === "anthropic-messages" ? { "anthropic-version": "2023-06-01", "x-api-key": apiKey } : { Authorization: `Bearer ${apiKey}` };
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
 * Apply discovery to a model list: the id set, display name and context window only. Every
 * other field stays base-owned — a reseller's bare-id registry must not silently downgrade
 * a curated model to pi's defaults, and capability flags are decided at generation time
 * (decision 18). Ids that vanish are kept: removing a model is a reviewable catalog change.
 */
export function applyLiveModels(models: readonly ModelEntry[], rows: readonly LiveModelRow[]): { models: ModelEntry[]; unknown: string[] } {
	const byId = new Map(models.map((model) => [model.id, { ...model, input: [...model.input], cost: { ...model.cost } }]));
	const unknown: string[] = [];
	for (const row of rows) {
		const ctx = row.context_length ?? row.contextWindow;
		const known = byId.get(row.id);
		if (known) {
			if (typeof ctx === "number" && ctx > 0) known.contextWindow = ctx;
			if (stringOr(row.name)) known.name = row.name as string;
			continue;
		}
		unknown.push(row.id);
		byId.set(row.id, {
			id: row.id,
			name: stringOr(row.name) ?? row.id,
			reasoning: false,
			input: ["text"],
			contextWindow: numberOr(ctx, 128000),
			maxTokens: 16384,
			cost: { ...ZERO_COST },
		});
	}
	return { models: [...byId.values()], unknown };
}

/**
 * This process's live list per endpoint. pi re-registers a provider by calling
 * `refreshModels` with `allowNetwork: false` right after every `registerProvider`
 * (`model-runtime.js` ends `registerProvider` with `void this.refresh({ allowNetwork: false })`),
 * so without this memo that cache-only round would overwrite the live values just registered.
 */
const liveSnapshots = new Map<string, ModelEntry[]>();
/** Last discovery failure per endpoint, so an offline round cannot erase it. */
const lastErrors = new Map<string, string>();
const endpointKey = (vendorId: string, api: string): string => `${vendorId}\u0000${api}`;

/** Every declared endpoint of a vendor: the default one plus each `apis.<api>`. */
function vendorEndpoints(vendor: Vendor): { api: string; baseUrl: string; modelsPath?: string; headers?: JsonObject }[] {
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

/** Credential for one endpoint, in pi's own order: stored → context → account → layer → env. */
function endpointCredential(entry: ProviderEntry, layer: JsonObject, contextKey: string | undefined): string | undefined {
	let stored: string | undefined;
	try {
		const credential = readStoredCredential(entry.id);
		stored = credential && typeof credential === "object" && "key" in credential && typeof (credential as { key?: unknown }).key === "string" ? (credential as { key: string }).key : undefined;
	} catch {
		stored = undefined;
	}
	return (
		stored ??
		contextKey ??
		resolveConfigValue(entry.account?.apiKey) ??
		resolveConfigValue(stringOr(layer.apiKey)) ??
		(entry.vendor.builtinAccount ? resolveConfigValue(`$${entry.vendor.builtinAccount.envVar}`) : undefined)
	);
}

async function refreshEntry(
	entry: ProviderEntry,
	layer: JsonObject,
	builtin: BuiltinCatalog,
	options: { allowFetch: boolean; contextKey?: string; signal?: AbortSignal; stored?: readonly JsonObject[] },
): Promise<{ models: ModelEntry[]; live: boolean; unknown: string[]; issues: LoadIssue[] }> {
	const issues: LoadIssue[] = [];
	const models = synthesizeModels(entry, layer, builtin, issues);
	const apiKey = endpointCredential(entry, layer, options.contextKey);
	// Report the missing credential before any request, naming the file and the built-in
	// variable so the fix is obvious (and never send the variable *name* as the token).
	const keyHint = `no API key: set it in custom-providers/${entry.vendor.id}/accounts.json, providers.${entry.id}.apiKey${entry.vendor.builtinAccount ? `, $${entry.vendor.builtinAccount.envVar}` : ""} or run /login ${entry.id}`;
	const storedRows = (options.stored ?? []).filter((row) => isObject(row) && typeof row.id === "string");
	let result = models;
	let live = false;
	const unknown: string[] = [];

	for (const endpoint of vendorEndpoints(entry.vendor)) {
		const key = endpointKey(entry.vendor.id, endpoint.api);
		const memo = liveSnapshots.get(key);
		let list = memo ?? result;
		if (!memo && storedRows.length > 0) {
			// Restored from pi's own store: only rows that name this protocol (pi stamps `api`
			// on persisted models), plus rows that name none at all (older snapshots).
			const own = storedRows.filter((row) => row.api === undefined || row.api === endpoint.api) as unknown as LiveModelRow[];
			list = applyLiveModels(list, own).models;
		}
		if (!options.allowFetch) {
			result = list;
			live = live || memo !== undefined;
			continue;
		}
		try {
			if (!apiKey) throw new Error(keyHint);
			// The probe is per endpoint, but it only has to succeed once per process: the memo
			// keeps the result for the cache-only round pi runs right after registration.
			const rows = await discover(endpoint, mergeHeaders(endpoint.headers, entry.account?.headers) ?? {}, apiKey, options.signal);
			const applied = applyLiveModels(list, rows);
			liveSnapshots.set(key, applied.models);
			lastErrors.delete(key);
			result = applied.models;
			live = true;
			unknown.push(...applied.unknown);
		} catch (error) {
			lastErrors.set(key, `${endpoint.api}: ${String(error)}`);
			// A failed probe keeps the list it had — this process's memo, pi's snapshot, or the
			// base table — and stays "live" when a memo is what it is serving.
			result = list;
			live = live || memo !== undefined;
		}
	}
	return { models: result, live, unknown, issues };
}

/** A compact, one-line-per-provider status, plus everything needed by the commands. */
export interface ProviderStatus {
	id: string;
	models: number;
	live: boolean;
	unknown: string[];
	issues: LoadIssue[];
	error?: string;
	drift?: DriftSummary;
	apis: { api: string; models: number }[];
	accounts: string[];
}

function apiSplit(models: readonly ModelEntry[], defaultApi: string, multiEndpoint: boolean): { api: string; models: number }[] {
	if (!multiEndpoint) return [{ api: defaultApi, models: models.length }];
	const counts = new Map<string, number>();
	for (const model of models) {
		const api = model.api ?? defaultApi;
		counts.set(api, (counts.get(api) ?? 0) + 1);
	}
	return [...counts.entries()].map(([api, models]) => ({ api, models })).sort((a, b) => a.api.localeCompare(b.api));
}

type RefreshContext = { allowNetwork: boolean; signal: AbortSignal; publish: (options: { persist: unknown }) => Promise<unknown>; credential?: { type?: string; key?: string }; stored?: { models?: unknown[] } };

function registerEntry(
	pi: ExtensionAPI,
	entry: ProviderEntry,
	layer: JsonObject,
	builtin: BuiltinCatalog,
	record: (status: ProviderStatus, options?: { keepExisting?: boolean }) => void,
	issues: LoadIssue[],
): { refresh: (context: RefreshContext) => Promise<CatalogModel[]> } | undefined {
	const { declaration } = entry.vendor;
	const defaultApi = normalizeApi(layer.api) ?? declaration.api;
	// A flipped default protocol keeps its own `apis.<api>` endpoint, and if that is missing
	// there is nothing to point the provider at: report and refuse (design §4).
	const flipped = declaration.apis[defaultApi];
	const providerBaseUrl = stringOr(layer.baseUrl) ?? flipped?.baseUrl ?? declaration.baseUrl;
	if (defaultApi !== declaration.api && !flipped) {
		issues.push({ level: "error", message: `${entry.id}: providers api "${defaultApi}" has no endpoint; declare apis.${defaultApi} or a baseUrl` });
		return undefined;
	}
	const resolved = synthesizeModels(entry, layer, builtin, issues);
	const accountKey = configValueForPi(entry.account?.apiKey);
	const envKey = entry.vendor.builtinAccount ? `$${entry.vendor.builtinAccount.envVar}` : undefined;
	const authHeader = entry.account?.authHeader ?? entry.vendor.builtinAccount?.authHeader;
	const name = entry.name;

	// The startup status: what this provider looks like before any network I/O, so the status
	// command has something to report even if pi never runs a refresh in this session.
	record({
		id: entry.id,
		models: resolved.length,
		live: false,
		unknown: [],
		issues: [...issues],
		apis: apiSplit(resolved, defaultApi, Object.keys(declaration.apis).length > 0),
		accounts: entry.vendor.accounts.map((account) => account.id),
		...(builtin.available ? { drift: summarizeDrift(resolved, builtin) } : {}),
	});

	const refresh = async (context: RefreshContext): Promise<CatalogModel[]> => {
		const result = await refreshEntry(entry, layer, builtin, {
			allowFetch: context.allowNetwork,
			...(context.credential?.type === "api_key" && context.credential.key ? { contextKey: context.credential.key } : {}),
			signal: context.signal,
			stored: (context.stored?.models ?? []) as unknown as JsonObject[],
		});
		const errors = vendorEndpoints(entry.vendor)
			.map((endpoint) => lastErrors.get(endpointKey(entry.vendor.id, endpoint.api)))
			.filter((error): error is string => Boolean(error));
		record(
			{
				id: entry.id,
				models: result.models.length,
				live: result.live,
				unknown: result.unknown,
				issues: [...issues, ...result.issues],
				apis: apiSplit(result.models, defaultApi, Object.keys(declaration.apis).length > 0),
				accounts: entry.vendor.accounts.map((account) => account.id),
				...(errors.length > 0 ? { error: errors.join("; ") } : {}),
				...(builtin.available ? { drift: summarizeDrift(result.models, builtin) } : {}),
			},
			// pi re-registers with `allowNetwork: false` after every registerProvider: that
			// round adds no information and must not erase a recorded failure.
			{ keepExisting: !context.allowNetwork },
		);
		if (context.allowNetwork && !context.signal.aborted) {
			await context.publish({
				persist: {
					models: result.models.map((model) => ({ ...model, provider: entry.id, api: model.api ?? defaultApi, baseUrl: model.baseUrl ?? providerBaseUrl })),
					checkedAt: Date.now(),
				},
			});
		}
		return result.models as unknown as CatalogModel[];
	};

	pi.registerProvider(entry.id, {
		name,
		baseUrl: providerBaseUrl,
		api: defaultApi,
		...(accountKey ?? envKey ? { apiKey: accountKey ?? envKey } : {}),
		...(authHeader !== undefined ? { authHeader } : {}),
		models: resolved as unknown as CatalogModel[],
		refreshModels: refresh,
	});
	return { refresh };
}

/** Trim a toast: the first lines plus a count, never a wall of text. */
function toastLines(lines: readonly string[], limit = 8): string {
	const shown = lines.slice(0, limit).join("; ");
	return lines.length > limit ? `${shown} (+${lines.length - limit} more)` : shown;
}

export default async function customProviders(pi: ExtensionAPI) {
	// Never write to stderr: raw output corrupts the TUI. Report through the session UI.
	loadEnvFile(path.join(getAgentDir(), ".env"));
	loadEnvFile(path.join(homedir(), ".omp", "agent", ".env"));

	const { config, issue: configIssue } = readModelsConfig();
	const builtin = await loadBuiltinCatalog();
	const userProviderIds = new Set(Object.keys(isObject(config.providers) ? config.providers : {}));
	// A provider declared only in the user's `models.json` is their own layer, not something
	// to take over: pi registers it itself, and the takeover rule does not apply (design §8).
	const piProviderIds = new Set([...builtin.providers].filter((id) => !userProviderIds.has(id)));
	const builtins: Vendor[] = SOURCES.map((vendor) => ({
		id: vendor.id,
		name: vendor.name,
		aliases: vendor.aliases,
		declaration: vendor.declaration,
		models: CATALOG[vendor.id] ?? [],
		origin: "builtin" as const,
		builtinAccount: vendor.builtinAccount,
		accounts: [],
		issues: [],
	}));

	const root = PROVIDER_ROOT();
	const scanned = collectVendors(root, builtins, piProviderIds);
	const globalIssues: LoadIssue[] = [
		...(configIssue ? [{ level: "warning" as const, message: configIssue }] : []),
		...scanned.issues,
	];
	const statuses = new Map<string, ProviderStatus>();
	const record = (status: ProviderStatus, options: { keepExisting?: boolean } = {}): void => {
		if (options.keepExisting && statuses.has(status.id)) return;
		statuses.set(status.id, status);
	};

	// Startup path: register the base tables, no network I/O.
	const entries: { entry: ProviderEntry; layer: JsonObject; vendorIssues: LoadIssue[]; refresh?: (context: RefreshContext) => Promise<CatalogModel[]> }[] = [];
	for (const vendor of scanned.vendors) {
		for (const entry of entriesFor(vendor)) {
			// An account's own `models.json` block layers over the base provider's (§4 layer 3).
			const layer = { ...providerLayerFor(vendor.id, vendor.aliases, config), ...(entry.base ? {} : providerLayerFor(entry.id, [], config)) };
			// Rebuilt per registration: model-level warnings are this provider's own, and
			// re-registering must not pile them up in a shared list.
			const vendorIssues: LoadIssue[] = [...(vendor.directory ? vendor.issues : [])];
			const registered = registerEntry(pi, entry, layer, builtin, record, vendorIssues);
			entries.push({ entry, layer, vendorIssues, ...(registered ? { refresh: registered.refresh } : {}) });
		}
	}

	const sortedStatuses = (): ProviderStatus[] => [...statuses.values()].sort((a, b) => a.id.localeCompare(b.id));

	/**
	 * Everything worth reporting, most actionable first: file/validation problems (they are
	 * ours to fix and would otherwise be buried), then failed refreshes, then new ids, then
	 * the "no live data" note — which is expected offline and only noise in quantity.
	 */
	const problemLines = (): string[] => [
		...globalIssues.filter((issue) => issue.level === "error").map((issue) => issue.message),
		...globalIssues.filter((issue) => issue.level === "warning").map((issue) => issue.message),
		// Problems a provider's own synthesis reported (endpoint fallbacks, invalid model apis).
		...[...new Set(sortedStatuses().flatMap((status) => status.issues.map((issue) => issue.message)))].filter(
			(message) => !globalIssues.some((issue) => issue.message === message),
		),
		...sortedStatuses()
			.filter((status) => status.error)
			.map((status) => `${status.id}: refresh failed, using ${status.models} model(s)${status.live ? " from the last successful fetch" : " from the base table"} (${status.error})`),
		...sortedStatuses()
			.filter((status) => status.unknown.length > 0)
			.map((status) => `${status.id}: new model(s) not in catalog: ${status.unknown.join(", ")}`),
		...sortedStatuses()
			.filter((status) => !status.error && !status.live)
			.map((status) => `${status.id}: live catalog unavailable (${status.models} model(s) from base)`),
	];

	pi.registerCommand("refresh-custom-models", {
		description: "Refresh the Command Code and SCNet model lists",
		handler: async (_args, ctx) => {
			for (const item of entries) registerEntry(pi, item.entry, item.layer, builtin, record, item.vendorIssues);
			for (const item of entries) if (item.refresh) await item.refresh({ allowNetwork: true, signal: new AbortController().signal, publish: async () => true });
			const failed = sortedStatuses().filter((status) => status.error);
			ctx.ui.notify(
				`Refreshed ${sortedStatuses().reduce((sum, status) => sum + status.models, 0)} subscription models${failed.length > 0 ? `; failed: ${failed.map((status) => status.id).join(", ")}` : ""}`,
				failed.length > 0 ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("custom-providers", {
		description: "Provider status; add `drift`, `files`, `sync <id> [--write]` or a provider id",
		handler: async (args, ctx) => {
			const [head, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const notify = (message: string, level: "info" | "warning" = "info") => ctx.ui.notify(message, level);

			if (head === "drift") {
				const lines = sortedStatuses().flatMap((status) => {
					const drift = status.drift;
					return drift ? [...drift.reasoning, ...drift.input, ...drift.maxTokens, ...drift.contextWindow] : [];
				});
				notify(lines.length > 0 ? `Built-in catalog drift (reported, not applied): ${toastLines(lines, 8)}` : "No differences from pi's built-in catalog");
				return;
			}
			if (head === "files") {
				const files = scanned.vendors.map((vendor) => {
					const dir = vendor.directory ? path.relative(root, vendor.directory) : "-";
					const accounts = vendor.accounts.length > 0 ? vendor.accounts.map((account) => account.id).join(",") : "none";
					return `${vendor.id} [${vendor.origin}] dir=${dir} models=${vendor.models.length} accounts=${accounts}`;
				});
				const ignored = scanned.ignored.length > 0 ? `ignored dirs: ${scanned.ignored.join(", ")}` : "no ignored dirs";
				notify(`Provider files: ${toastLines(files)}; ${ignored}`);
				return;
			}
			if (head === "sync") {
				const id = rest[0];
				const vendor = scanned.vendors.find((candidate) => candidate.id === id);
				if (!vendor || !vendor.directory) {
					notify(id ? `No provider directory named "${id}" under custom-providers/` : "Usage: custom-providers sync <id> [--write]", "warning");
					return;
				}
				const file = path.join(vendor.directory, "models.json");
				const current = readBaseTable(file).models;
				// The base ⊕ discovery, without the user's `models.json` layer: syncing must not
				// bake a user override into the base table. Discovery is this process's memo —
				// what `refresh-custom-models` last fetched — never a fresh network call.
				let models = current.length > 0 ? current : vendor.models;
				for (const endpoint of vendorEndpoints(vendor)) {
					const memo = liveSnapshots.get(endpointKey(vendor.id, endpoint.api));
					if (memo) models = applyLiveModels(models, memo).models;
				}
				const merged = baseTableView(models, vendor.declaration, []);
				const diff = diffBaseTable(id, file, merged, current);
				const summary = summarizeDiff(diff);
				if (!rest.includes("--write") || !diff.dirty) {
					notify(summary.length > 0 ? `sync ${id} (dry run, pass --write to apply): ${toastLines(summary)}` : `sync ${id}: base table already current`);
					return;
				}
				const { backup } = writeBaseTable(file, merged);
				notify(`sync ${id}: wrote ${merged.length} model(s)${backup ? ` (backup: ${path.basename(backup)})` : ""}${summary.length > 0 ? `; ${toastLines(summary)}` : ""}`);
				return;
			}
			if (head) {
				const status = statuses.get(head);
				if (!status) {
					notify(`Unknown provider "${head}" (known: ${sortedStatuses().map((entry) => entry.id).join(", ") || "none"})`, "warning");
					return;
				}
				const detail = [
					`${status.models} models (${status.live ? "live" : "base"})`,
					`apis: ${status.apis.map((entry) => `${entry.api} ${entry.models}`).join(", ")}`,
					`accounts: ${status.accounts.length > 0 ? status.accounts.join(", ") : "none"}`,
					...(status.error ? [`error: ${status.error}`] : []),
					...status.unknown.map((id) => `new: ${id}`),
					...status.issues.map((issue) => `${issue.level}: ${issue.message}`),
				];
				notify(`${status.id}: ${toastLines(detail)}`, status.error ? "warning" : "info");
				return;
			}

			const lines = sortedStatuses().map((status) => {
				const origin = status.live ? "live" : "base";
				const apis = status.apis.length > 1 ? ` [${status.apis.map((entry) => `${entry.api} ${entry.models}`).join(", ")}]` : "";
				return `${status.id}: ${status.models} models (${origin})${apis}${status.unknown.length > 0 ? `, new: ${status.unknown.length}` : ""}${status.error ? ", refresh failed" : ""}`;
			});
			notify(`Providers: ${toastLines(lines)}${problemLines().length > 0 ? `; issues: ${toastLines(problemLines())}` : ""}`, problemLines().length > 0 ? "warning" : "info");
		},
	});

	// The online refresh runs after startup so a slow network never delays the TUI, and the
	// report goes out with it (a toast from the factory body would be lost before the UI exists).
	pi.on("session_start", async (_event, ctx) => {
		// Re-register (cheap, no network) and then refresh live: the network round is deferred
		// to here so a slow endpoint never delays the TUI.
		for (const item of entries) registerEntry(pi, item.entry, item.layer, builtin, record, item.vendorIssues);
		for (const item of entries) {
			if (!item.refresh) continue;
			try {
				await item.refresh({ allowNetwork: true, signal: new AbortController().signal, publish: async () => true });
			} catch {
				// refreshModels never throws by design; a throw here must still not kill startup.
			}
		}
		const problems = problemLines();
		if (problems.length > 0 && ctx.hasUI) ctx.ui.notify(`custom-providers: ${toastLines(problems)}`, "warning");
	});
}
