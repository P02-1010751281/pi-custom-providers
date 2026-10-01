/**
 * custom-providers — register reseller/gateway LLM endpoints (Command Code / GOAT and
 * SCNet, OpenAI-shaped and Anthropic-shaped) from an optional per-vendor directory of
 * configuration files.
 *
 * Why this lives in a package instead of `~/.pi/agent/models.json`:
 *   - The resellers' `/models` endpoints carry little or no metadata (SCNet returns ids
 *     only), so model parameters have to be curated somewhere. They live in the vendor's own
 *     `models.json`; this package ships no table, and live discovery only fills id / name /
 *     contextWindow.
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
 *   1. base model table — `<id>/models.json`; empty until it exists or discovery fills it
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
 * `~/.pi/agent/models-store.json` for offline restore. pi's global `models.json` is never
 * written; the only writers in this package are `init` (a vendor's `provider.json`) and
 * `sync --write` (a vendor's `models.json`).
 *
 * Files: `sources.ts` built-in vendor endpoints, `config.ts` pi's api vocabulary + the
 * `models.json` layer + pi's model-size fallbacks, `directory.ts` the directory scan and id
 * namespace, `endpoints.ts`/`model-table.ts`/`credentials.ts` the three payloads (their
 * readers, and the two writers), `providers.ts` the vendor → registered-provider composition
 * (entries and the layer chain), `live.ts` discovery and the merge rules for a wire's answer,
 * `status.ts` per-provider status and problem text, `builtin.ts` pi cross-check, `util.ts` the
 * JSON vocabulary.
 */
import { homedir } from "node:os";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeApi } from "./apis.ts";
import { loadBuiltinCatalog, summarizeDrift, type BuiltinCatalog } from "./builtin.ts";
import { providerLayerFor, readModelsConfig } from "./config.ts";
import { registrationCredential } from "./credentials.ts";
import { collectVendors } from "./directory.ts";
import { loadEnvFile } from "./env.ts";
import { applyLiveModels, endpointKey, lastErrors, liveSnapshots, refreshEntry, vanishedByVendor, vendorEndpoints } from "./live.ts";
import { diffBaseTable, summarizeDiff, writeBaseTable } from "./model-table.ts";
import { baseTableView, collectEntries, synthesizeModels, type ModelEntry, type ProviderEntry } from "./providers.ts";
import { writeProviderFile } from "./endpoints.ts";
import { DEFAULTS } from "./sources.ts";
import { apiSplit, problemLines, toastLines, type ProviderStatus } from "./status.ts";
import type { CatalogModel, LoadIssue, Vendor } from "./types.ts";
import { isObject, stringOr, type JsonObject } from "./util.ts";

const PROVIDER_ROOT = () => path.join(getAgentDir(), "custom-providers");

/** pi's refresh context: what the model runtime hands a `refreshModels` round. */
/**
 * What our `refreshModels` needs from pi's `RefreshModelsContext` (a structural subset, so
 * pi's own object fits). `publish` is optional because our own refresh rounds — the command
 * and session start — do not persist: pi owns the store and re-publishes a refresh it
 * started itself, and a hand-built `publish` stub would be a lie about what happens.
 */
type RefreshContext = { allowNetwork: boolean; signal: AbortSignal; publish?: (options: { persist: unknown }) => Promise<unknown>; credential?: { type?: string; key?: string }; stored?: { models?: unknown[] } };

/** How a command reports: pi's `ctx.ui.notify`, with its two levels. */
type Notify = (message: string, level?: "info" | "warning") => void;

/**
 * The status one provider reports. Shared by the startup path (no network: the base table)
 * and every refresh round, so the two cannot drift apart in what they report.
 */
function statusOf(
	entry: ProviderEntry,
	builtin: BuiltinCatalog,
	defaultApi: string,
	parts: { models: readonly ModelEntry[]; live: boolean; unknown: string[]; vanished: string[]; issues: LoadIssue[]; error?: string },
): ProviderStatus {
	return {
		id: entry.id,
		models: parts.models.length,
		live: parts.live,
		unknown: parts.unknown,
		vanished: parts.vanished,
		issues: [...parts.issues],
		apis: apiSplit(parts.models, defaultApi, Object.keys(entry.vendor.declaration.apis).length > 0),
		accounts: entry.vendor.accounts.map((account) => account.id),
		...(parts.error ? { error: parts.error } : {}),
		...(builtin.available ? { drift: summarizeDrift(parts.models, builtin) } : {}),
	};
}

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
	if (defaultApi !== declaration.api && !flipped && !stringOr(layer.baseUrl)) {
		issues.push({ level: "error", message: `${entry.id}: providers api "${defaultApi}" has no endpoint; declare apis.${defaultApi} or a baseUrl` });
		return undefined;
	}
	const resolved = synthesizeModels(entry, layer, builtin, issues);
	const { apiKey: accountKey, authHeader } = registrationCredential(entry);
	const name = entry.name;

	// The startup status: what this provider looks like before any network I/O, so the status
	// command has something to report even if pi never runs a refresh in this session.
	record(statusOf(entry, builtin, defaultApi, { models: resolved, live: false, unknown: [], vanished: vanishedByVendor.get(entry.vendor.id) ?? [], issues }));

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
			statusOf(entry, builtin, defaultApi, {
				models: result.models,
				live: result.live,
				unknown: result.unknown,
				vanished: result.vanished,
				issues: [...issues, ...result.issues],
				...(errors.length > 0 ? { error: errors.join("; ") } : {}),
			}),
			// pi re-registers with `allowNetwork: false` after every registerProvider: that
			// round adds no information and must not erase a recorded failure.
			{ keepExisting: !context.allowNetwork },
		);
		if (context.allowNetwork && context.publish && !context.signal.aborted) {
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
		...(accountKey ? { apiKey: accountKey } : {}),
		...(authHeader !== undefined ? { authHeader } : {}),
		models: resolved as unknown as CatalogModel[],
		refreshModels: refresh,
	});
	return { refresh };
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
	const defaults: Vendor[] = DEFAULTS.map((vendor) => ({
		id: vendor.id,
		name: vendor.name,
		aliases: vendor.aliases,
		declaration: vendor.declaration,
		models: [],
		origin: "directory" as const,
		defaultAccount: vendor.defaultAccount,
		accounts: [],
		issues: [],
	}));

	const root = PROVIDER_ROOT();
	const scanned = collectVendors(root, defaults, piProviderIds);
	// Ids already spoken for: pi's own providers and every scanned vendor id. An account id
	// colliding with one of them would silently merge — skip and report instead. Ids the *user*
	// declared in `models.json` are deliberately not on this list: `providers.<vendor>-<account>`
	// is exactly how an account is configured, not a conflict (design §7/§10 #13).
	const collected = collectEntries(scanned.vendors, piProviderIds);
	const globalIssues: LoadIssue[] = [
		...(configIssue ? [{ level: "warning" as const, message: configIssue }] : []),
		...scanned.issues,
		...collected.issues,
	];
	const statuses = new Map<string, ProviderStatus>();
	const record = (status: ProviderStatus, options: { keepExisting?: boolean } = {}): void => {
		if (options.keepExisting && statuses.has(status.id)) return;
		statuses.set(status.id, status);
	};

	// Startup path: register the base tables, no network I/O.
	const entries: { entry: ProviderEntry; layer: JsonObject; vendorIssues: LoadIssue[]; refresh?: (context: RefreshContext) => Promise<CatalogModel[]> }[] = [];
	for (const entry of collected.entries) {
		const layer = { ...providerLayerFor(entry.vendor.id, entry.vendor.aliases, config), ...(entry.base ? {} : providerLayerFor(entry.id, [], config)) };
		// Rebuilt per registration: model-level warnings are this provider's own, and
		// re-registering must not pile them up in a shared list.
		const vendorIssues: LoadIssue[] = [...(entry.vendor.directory ? entry.vendor.issues : [])];
		const reported = vendorIssues.length;
		const registered = registerEntry(pi, entry, layer, builtin, record, vendorIssues);
		// A refused provider never reaches `record()`, so surface its error here instead of
		// letting the provider disappear silently from every command.
		if (!registered) globalIssues.push(...vendorIssues.slice(reported));
		entries.push({ entry, layer, vendorIssues, ...(registered ? { refresh: registered.refresh } : {}) });
	}

	const sortedStatuses = (): ProviderStatus[] => [...statuses.values()].sort((a, b) => a.id.localeCompare(b.id));

	pi.registerCommand("refresh-custom-models", {
		description: "Refresh the Command Code and SCNet model lists",
		handler: async (_args, ctx) => {
			for (const item of entries) registerEntry(pi, item.entry, item.layer, builtin, record, item.vendorIssues);
			for (const item of entries) if (item.refresh) await item.refresh({ allowNetwork: true, signal: new AbortController().signal });
			const failed = sortedStatuses().filter((status) => status.error);
			ctx.ui.notify(
				`Refreshed ${sortedStatuses().reduce((sum, status) => sum + status.models, 0)} subscription models${failed.length > 0 ? `; failed: ${failed.map((status) => status.id).join(", ")}` : ""}`,
				failed.length > 0 ? "warning" : "info",
			);
		},
	});

	// The command surface. Each branch is one job; the dispatcher only routes to them.
	const runInit = (notify: Notify, rest: string[]): void => {
		const force = rest.includes("--force");
		const ids = rest.filter((arg) => !arg.startsWith("--"));
		const results = (ids.length > 0 ? ids : DEFAULTS.map((vendor) => vendor.id)).map((id) => {
			const shipped = DEFAULTS.find((vendor) => vendor.id === id);
			if (!shipped) return `${id}: unknown (known: ${DEFAULTS.map((vendor) => vendor.id).join(", ")})`;
			return writeProviderFile(path.join(root, id), shipped, force);
		});
		notify(`init: ${toastLines(results)}`);
	};

	const runDrift = (notify: Notify): void => {
		const lines = sortedStatuses().flatMap((status) => {
			const drift = status.drift;
			return drift ? [...drift.reasoning, ...drift.input, ...drift.maxTokens, ...drift.contextWindow] : [];
		});
		const compared = [...statuses.values()].reduce((sum, status) => sum + (status.drift?.matched ?? 0), 0);
		if (lines.length > 0) {
			notify(`Built-in catalog drift (reported, not applied): ${toastLines(lines, 8)}`);
			return;
		}
		const registered = [...statuses.values()].reduce((sum, status) => sum + status.models, 0);
		if (!builtin.available) {
			notify("pi's built-in catalog is unavailable; nothing to compare", "warning");
			return;
		}
		if (registered === 0) {
			notify("No registered models to compare with pi's built-in catalog");
			return;
		}
		notify(compared > 0 ? "No differences from pi's built-in catalog" : "No registered model matched pi's built-in catalog");
	};

	const runFiles = (notify: Notify): void => {
		// Re-scan: `init` may have written a provider.json after startup.
		const vendorFiles = collectVendors(root, defaults, piProviderIds);
		const files = vendorFiles.vendors.map((vendor) => {
			const dir = vendor.directory ? path.relative(root, vendor.directory) : "-";
			const accounts = vendor.accounts.length > 0 ? vendor.accounts.map((account) => account.id).join(",") : "none";
			return `${vendor.id} [${vendor.origin}] dir=${dir} models=${vendor.models.length} accounts=${accounts}`;
		});
		const ignored = vendorFiles.ignored.length > 0 ? `ignored dirs: ${vendorFiles.ignored.join(", ")}` : "no ignored dirs";
		// `vendorFiles.issues` already carries a prefixed copy of each vendor's own issues.
		const problems = [...new Set(vendorFiles.issues.map((issue) => `${issue.level}: ${issue.message}`))];
		notify(`Provider files: ${toastLines(files)}; ${ignored}${problems.length > 0 ? `; problems: ${toastLines(problems)}` : ""}`);
	};

	const runSync = (notify: Notify, rest: string[]): void => {
		const id = rest[0];
		// Re-scan: `init` may have written the directory after startup.
		const vendor = collectVendors(root, defaults, piProviderIds).vendors.find((candidate) => candidate.id === id);
		if (!vendor || !vendor.directory) {
			notify(id ? `No provider directory named "${id}" under custom-providers/` : "Usage: custom-providers sync <id> [--write]", "warning");
			return;
		}
		const file = path.join(vendor.directory, "models.json");
		// `collectVendors` above re-read the directory inside this command, so this is the base
		// table as it is on disk right now: one parse per command, not a second one with its own
		// rules (an unparsable `models.json` already fails the vendor above).
		const current = vendor.models;
		// The base + discovery, without the user's `models.json` layer: syncing must not bake a
		// user override into the base table. Discovery is this process's memo — what
		// `refresh-custom-models` last fetched — never a fresh network call.
		let models = current;
		for (const endpoint of vendorEndpoints(vendor)) {
			const memo = liveSnapshots.get(endpointKey(vendor.id, endpoint.api));
			if (memo) models = applyLiveModels(models, memo, endpoint.api).models;
		}
		// Ids the last complete discovery no longer returns. Default: keep them and say so.
		// `--prune` is the explicit call to drop them from the base table.
		const vanished = vanishedByVendor.get(vendor.id) ?? [];
		const prune = rest.includes("--prune");
		if (prune && vanished.length > 0) {
			const gone = new Set(vanished);
			models = models.filter((model) => !gone.has(model.id));
		}
		const merged = baseTableView(models, vendor.declaration, []);
		const diff = diffBaseTable(id, file, merged, current);
		const summary = summarizeDiff(diff);
		const kept = !prune && vanished.length > 0 ? [`vanished (kept, pass --prune to drop): ${vanished.join(", ")}`] : [];
		const report = [...summary, ...kept];
		if (!rest.includes("--write")) {
			notify(report.length > 0 ? `sync ${id} (dry run, pass --write to apply): ${toastLines(report)}` : `sync ${id}: base table already current`);
			return;
		}
		if (!diff.dirty) {
			notify(`sync ${id}: base table already current${report.length > 0 ? `; ${toastLines(report)}` : ""}`);
			return;
		}
		const { backup } = writeBaseTable(file, merged);
		notify(`sync ${id}: wrote ${merged.length} model(s)${backup ? ` (backup: ${path.basename(backup)})` : ""}${report.length > 0 ? `; ${toastLines(report)}` : ""}`);
	};

	/** One provider's detail, or the list when no id is given. */
	const runStatus = (notify: Notify, id?: string): void => {
		if (id) {
			const status = statuses.get(id);
			if (!status) {
				notify(`Unknown provider "${id}" (known: ${sortedStatuses().map((entry) => entry.id).join(", ") || "none"})`, "warning");
				return;
			}
			const detail = [
				`${status.models} models (${status.live ? "live" : "base"})`,
				`apis: ${status.apis.map((entry) => `${entry.api} ${entry.models}`).join(", ")}`,
				`accounts: ${status.accounts.length > 0 ? status.accounts.join(", ") : "none"}`,
				...(status.error ? [`error: ${status.error}`] : []),
				...status.unknown.map((id) => `new: ${id}`),
				...[...new Set(status.issues.map((issue) => `${issue.level}: ${issue.message}`))],
			];
			notify(`${status.id}: ${toastLines(detail)}`, status.error ? "warning" : "info");
			return;
		}
		const lines = sortedStatuses().map((status) => {
			const origin = status.live ? "live" : "base";
			const apis = status.apis.length > 1 ? ` [${status.apis.map((entry) => `${entry.api} ${entry.models}`).join(", ")}]` : "";
			return `${status.id}: ${status.models} models (${origin})${apis}${status.unknown.length > 0 ? `, new: ${status.unknown.length}` : ""}${status.error ? ", refresh failed" : ""}`;
		});
		const problems = problemLines(sortedStatuses(), globalIssues);
		notify(`Providers: ${toastLines(lines)}${problems.length > 0 ? `; issues: ${toastLines(problems)}` : ""}`, problems.length > 0 ? "warning" : "info");
	};

	pi.registerCommand("custom-providers", {
		description: "Provider status; add `init [<id>...]`, `drift`, `files`, `sync <id> [--write] [--prune]` or a provider id",
		handler: async (args, ctx) => {
			const [head, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const notify: Notify = (message, level = "info") => ctx.ui.notify(message, level);
			if (head === "init") return runInit(notify, rest);
			if (head === "drift") return runDrift(notify);
			if (head === "files") return runFiles(notify);
			if (head === "sync") return runSync(notify, rest);
			return runStatus(notify, head);
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
				await item.refresh({ allowNetwork: true, signal: new AbortController().signal });
			} catch {
				// refreshModels never throws by design; a throw here must still not kill startup.
			}
		}
		const problems = problemLines(sortedStatuses(), globalIssues);
		if (problems.length > 0 && ctx.hasUI) ctx.ui.notify(`custom-providers: ${toastLines(problems)}`, "warning");
	});
}
