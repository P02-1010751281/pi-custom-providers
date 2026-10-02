/**
 * Vendor directories → the pi providers we register.
 *
 * `ProviderEntry` is the registration unit (one vendor × one account). `synthesizeModels` runs
 * the layer chain (base table ⊕ `provider.json` ⊕ pi's `models.json`) and stamps each model
 * with the endpoint and headers it ends up on; `baseTableView` is the derived-free view
 * `sync --write` stores (design §4/§5.2/§5.3).
 */
import { absorbCompat, type BuiltinCatalog, type CatalogCompat } from "./builtin.ts";
import { FALLBACK_CONTEXT_WINDOW, FALLBACK_MAX_TOKENS, inertCompatKeys } from "./apis.ts";
import { applyModelPatch } from "./config.ts";
import { resolveModelEndpoint } from "./endpoints.ts";
import type { Account, CatalogModel, LoadIssue, ModelCompat, ProviderDeclaration, Vendor } from "./types.ts";
import { isObject, stringOr, type JsonObject } from "./util.ts";

/** Cost of a model we know nothing about. pi dereferences `cost` on every request. */
export const ZERO_COST: CatalogModel["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** One registrable pi provider: a vendor, plus the account that supplies its credentials. */
export interface ProviderEntry {
	id: string;
	name: string;
	vendor: Vendor;
	account?: Account;
	/** True for the entry that registers as `<vendor id>`. */
	base: boolean;
}

/**
 * One entry per vendor, plus one per extra account (`<vendor>-<account>`).
 *
 * `taken` is every provider id pi already has (its built-ins and the user's own `models.json`
 * declarations); every scanned vendor id is reserved on top of it, so the result does not
 * depend on scan order.
 */
export function collectEntries(vendors: readonly Vendor[], taken: Iterable<string>): { entries: ProviderEntry[]; issues: LoadIssue[] } {
	const claimed = new Set(taken);
	for (const vendor of vendors) if (!vendor.baseSuppressed) claimed.add(vendor.id);
	const entries: ProviderEntry[] = [];
	const issues: LoadIssue[] = [];
	for (const vendor of vendors) {
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
			const id = `${vendor.id}-${account.id}`;
			// pi keys registrations by provider id, so a collision merges into whichever provider
			// registered first; skip and report instead (design §7/§10 #13).
			if (claimed.has(id)) {
				issues.push({ level: "warning", message: `${vendor.id}: account "${account.id}" would register as "${id}", which another provider already uses; skipping it` });
				continue;
			}
			claimed.add(id);
			entries.push({ id, name: `${vendor.name} (${account.id})`, vendor, account, base: false });
		}
	}
	return { entries, issues };
}

/** One model, after the layer chain ran: the shape handed to `registerProvider`. */
export type ModelEntry = CatalogModel & { compat?: CatalogCompat & ModelCompat };

/** Merge header layers left to right; a later layer wins per key. */
export function mergeHeaders(...layers: (JsonObject | undefined)[]): JsonObject | undefined {
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
export function synthesizeModels(entry: ProviderEntry, layer: JsonObject, builtin: BuiltinCatalog, issues: LoadIssue[]): ModelEntry[] {
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
		base.set(id, { id, name: id, reasoning: false, input: ["text"], contextWindow: FALLBACK_CONTEXT_WINDOW, maxTokens: FALLBACK_MAX_TOKENS, cost: { ...ZERO_COST } });
	}

	const multiEndpoint = Object.keys(declaration.apis).length > 0;
	const models: ModelEntry[] = [];
	/** compat keys pi's request builder will not read, per protocol — collected, named once. */
	const noEffect = new Map<string, Set<string>>();
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

		// A key the target protocol's request builder never reads is accepted by pi and then
		// silently dropped — a warning, never a refusal (pi itself validates types, not
		// membership). `modelOverrides[M]` is pi's *top* layer, applied after this list, so a key
		// written only there is reported too.
		const overrideRow = isObject(layer.modelOverrides) && isObject((layer.modelOverrides as JsonObject)[id]) ? ((layer.modelOverrides as JsonObject)[id] as JsonObject) : undefined;
		const overrideCompat = overrideRow && isObject(overrideRow.compat) ? (overrideRow.compat as Record<string, unknown>) : undefined;
		for (const key of [...inertCompatKeys(endpoint.api, compat), ...inertCompatKeys(endpoint.api, overrideCompat)]) {
			const keys = noEffect.get(endpoint.api) ?? new Set<string>();
			keys.add(key);
			noEffect.set(endpoint.api, keys);
		}

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
	for (const [api, keys] of noEffect) {
		const list = [...keys].sort().map((key) => `"${key}"`).join(", ");
		const one = keys.size === 1;
		issues.push({
			level: "warning",
			message: `${entry.id}: compat ${one ? "key" : "keys"} ${list} ${one ? "has" : "have"} no effect on ${api} (its request builder never reads ${one ? "it" : "them"})`,
		});
	}
	return models;
}

/**
 * The *base* view of a model list: what `sync --write` stores and what a vendor's
 * `models.json` holds.
 * Derived products stay out of it — the protocol suffix on the display name and the
 * endpoint's base URL are computed at registration time (design §4/§5.2), so writing them
 * back would freeze a layer-2 computation into the layer-1 table.
 */
export function baseTableView(models: readonly CatalogModel[], declaration: ProviderDeclaration, issues: LoadIssue[]): CatalogModel[] {
	return models.map((model) => {
		const choice = resolveModelEndpoint(declaration, {}, model);
		for (const issue of choice.issues) issues.push({ level: "warning", message: issue });
		// A model on the default protocol carries no `api` at all: that is what keeps
		// `providers.<id>.api`/`baseUrl` able to redirect it later.
		return choice.stampApi ? { ...model, api: choice.endpoint.api } : model;
	});
}
