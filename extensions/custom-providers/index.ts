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
 * `status.ts` per-provider status and problem text, `builtin.ts` pi cross-check, `verbs.ts` the
 * `/providers` verb table and its parser, `util.ts` the JSON vocabulary.
 */
import { homedir } from "node:os";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeApi, BUILTIN_APIS } from "./apis.ts";
import { loadBuiltinCatalog, summarizeDrift, type BuiltinCatalog } from "./builtin.ts";
import { orphanProviderBlocks, preflightLayer, providerBlockFor, readModelsConfig } from "./config.ts";
import { isLiteralCredential, registrationCredential, writeAccountsFile } from "./credentials.ts";
import { collectVendors } from "./directory.ts";
import { loadEnvFile } from "./env.ts";
import { applyLiveModels, endpointKey, lastErrors, refreshEntry, vanishedByVendor, vendorEndpoints, type EndpointProbe } from "./live.ts";
import { diffBaseTable, summarizeDiff, writeBaseTable } from "./model-table.ts";
import { baseTableView, collectEntries, synthesizeModels, type ModelEntry, type ProviderEntry } from "./providers.ts";
import { writeProviderFile } from "./endpoints.ts";
import { apiSplit, problemLines, toastLines, type ProviderStatus } from "./status.ts";
import { COMMAND, VERBS, commandDescription, parseCommand, usageLine, usageOverview } from "./verbs.ts";
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

/** What one entry takes from the user's `models.json`: the patch, plus whether a block existed. */
type EntryLayer = { patch: JsonObject; configured: boolean };

function registerEntry(
	pi: ExtensionAPI,
	entry: ProviderEntry,
	layer: EntryLayer,
	builtin: BuiltinCatalog,
	record: (status: ProviderStatus, options?: { keepExisting?: boolean }) => void,
	issues: LoadIssue[],
): { refresh: (context: RefreshContext) => Promise<CatalogModel[]> } | undefined {
	const { declaration } = entry.vendor;
	const patch = layer.patch;
	const defaultApi = normalizeApi(patch.api) ?? declaration.api;
	// A flipped default protocol keeps its own `apis.<api>` endpoint, and if that is missing
	// there is nothing to point the provider at: report and refuse (design §4).
	const flipped = declaration.apis[defaultApi];
	const providerBaseUrl = stringOr(patch.baseUrl) ?? flipped?.baseUrl ?? declaration.baseUrl;
	if (defaultApi !== declaration.api && !flipped && !stringOr(patch.baseUrl)) {
		issues.push({ level: "error", message: `${entry.id}: providers api "${defaultApi}" has no endpoint; declare apis.${defaultApi} or a baseUrl` });
		return undefined;
	}
	const resolved = synthesizeModels(entry, patch, builtin, issues);
	const { apiKey: accountKey, authHeader } = registrationCredential(entry);
	const name = entry.name;
	// What pi would reject, reported before the call instead of as an exception: pi validates the
	// user's `providers.<id>` block inside `registerProvider` (`applyModelsJson`), so an error there
	// must not become "every provider after this one is missing".
	const preflight = preflightLayer(entry.id, patch, { configured: layer.configured, builtin: builtin.providers.has(entry.id) });
	issues.push(...preflight);
	if (preflight.some((issue) => issue.level === "error")) return undefined;

	// The model table is the single home for model content: pi only *validates* a user `models[]`
	// array for a provider an extension registers and never applies it, so reading those entries
	// would make the config layer a second home for the same fact. Reported, not read.
	if (Array.isArray(patch.models) && patch.models.length > 0) {
		issues.push({
			level: "warning",
			message: `providers.${entry.id}.models[] is not read for a provider this extension registers (pi only validates it); models live in ${entry.vendor.id}/models.json and a per-model tweak belongs in modelOverrides`,
		});
	}

	// The startup status: what this provider looks like before any network I/O, so the status
	// command has something to report even if pi never runs a refresh in this session.
	record(statusOf(entry, builtin, defaultApi, { models: resolved, live: false, unknown: [], vanished: vanishedByVendor.get(entry.vendor.id) ?? [], issues }));

	const refresh = async (context: RefreshContext): Promise<CatalogModel[]> => {
		const result = await refreshEntry(entry, patch, builtin, {
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

	try {
		pi.registerProvider(entry.id, {
			name,
			baseUrl: providerBaseUrl,
			api: defaultApi,
			...(accountKey ? { apiKey: accountKey } : {}),
			...(authHeader !== undefined ? { authHeader } : {}),
			models: resolved as unknown as CatalogModel[],
			refreshModels: refresh,
		});
	} catch (error) {
		// The backstop: anything pi rejects that the pre-report above did not name (a pi build with
		// stricter rules, a bad model field) is one provider's problem, not the loop's.
		issues.push({ level: "error", message: `${entry.id}: pi refused the registration (${String(error)})` });
		return undefined;
	}
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

	const root = PROVIDER_ROOT();
	const scanned = collectVendors(root, piProviderIds);
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
	// A block under an id nothing answers to is inert (pi registers the id itself), so saying so is
	// the only way the user learns it stopped being read. The check needs pi's id list; without it
	// it stays quiet rather than guessing (the function decides).
	globalIssues.push(...orphanProviderBlocks(config, collected.entries.map((entry) => entry.id), builtin));
	const statuses = new Map<string, ProviderStatus>();
	const record = (status: ProviderStatus, options: { keepExisting?: boolean } = {}): void => {
		if (options.keepExisting && statuses.has(status.id)) return;
		statuses.set(status.id, status);
	};

	// Startup path: register the base tables, no network I/O. `registerAll` is the one place that
	// turns a scan into registered providers, so `rescan` cannot drift from startup.
	type Registered = { entry: ProviderEntry; layer: EntryLayer; vendorIssues: LoadIssue[]; refresh?: (context: RefreshContext) => Promise<CatalogModel[]> };
	/**
	 * The layer chain for one entry: the vendor id's block, plus the account id's block for an extra
	 * account. `configured` is per *id* — the block pi validates when it registers `<id>`.
	 */
	const layerFor = (entry: ProviderEntry): EntryLayer => {
		const vendorBlock = providerBlockFor(entry.vendor.id, config);
		const accountBlock = entry.base ? undefined : providerBlockFor(entry.id, config);
		return { patch: { ...(vendorBlock ?? {}), ...(accountBlock ?? {}) }, configured: vendorBlock !== undefined || accountBlock !== undefined };
	};
	/**
	 * Register one scan's entries. A refused provider never reaches `record()`, so its own issues
	 * are surfaced here instead of letting it disappear silently from every command.
	 */
	const registerAll = (vendors: readonly Vendor[]): Registered[] =>
		collectEntries(vendors, piProviderIds).entries.map((entry) => {
			const layer = layerFor(entry);
			// Rebuilt per registration: model-level warnings are this provider's own, and
			// re-registering must not pile them up in a shared list.
			const vendorIssues: LoadIssue[] = [...(entry.vendor.directory ? entry.vendor.issues : [])];
			const reported = vendorIssues.length;
			const registered = registerEntry(pi, entry, layer, builtin, record, vendorIssues);
			if (!registered) globalIssues.push(...vendorIssues.slice(reported));
			return { entry, layer, vendorIssues, ...(registered ? { refresh: registered.refresh } : {}) };
		});
	let entries: Registered[] = registerAll(scanned.vendors);
	/** Ids this instance registered — the only ones `rescan` is allowed to unregister. */
	const registeredIds = new Set(entries.map((item) => item.entry.id));
	/**
	 * Turn one fresh scan into registered providers, in place, and unregister what it no longer
	 * contains. `scope` is the provider id the round was limited to (`undefined` = the whole
	 * directory), which is what `removed` compares against: a one-provider round must not read
	 * another provider's ids as gone.
	 *
	 * Startup, `rescan` and the write verbs (`sync`, `init`) all funnel through here, so
	 * "disk changed → session changed" has one implementation and a write verb cannot drift from
	 * `rescan`. A dry run computes the same counts and changes nothing.
	 */
	const applyVendors = (fresh: readonly Vendor[], scope: string | undefined, options: { dryRun?: boolean } = {}): { total: number; added: string[]; removed: string[]; dropped: string[]; failures: { id: string; error: string }[] } => {
		const next = collectEntries(fresh, piProviderIds).entries;
		const nextIds = new Set(next.map((entry) => entry.id));
		const added = [...nextIds].filter((candidate) => !registeredIds.has(candidate));
		// A one-provider round compares against that provider's own ids; a full scan compares
		// against everything registered, which is also how a deleted directory is noticed.
		const known = scope === undefined ? [...registeredIds] : entries.filter((item) => item.entry.vendor.id === scope).map((item) => item.entry.id);
		const removed = known.filter((registeredId) => !nextIds.has(registeredId));
		if (options.dryRun) return { total: nextIds.size, added, removed, dropped: [], failures: [] };
		// Replace only the entries of the vendors this round touched: `entries` backs the startup
		// refresh, so a one-provider round must not drop the others from it.
		const scanned = new Set(fresh.map((vendor) => vendor.id));
		entries = [...entries.filter((item) => !scanned.has(item.entry.vendor.id)), ...registerAll(fresh)];
		for (const candidate of next) registeredIds.add(candidate.id);
		const dropped: string[] = [];
		const failures: { id: string; error: string }[] = [];
		for (const registeredId of removed) {
			// pi's `unregisterProvider` is not scoped to the calling extension, so only ids this
			// instance registered are ever passed to it.
			try {
				pi.unregisterProvider(registeredId);
				registeredIds.delete(registeredId);
				statuses.delete(registeredId);
				dropped.push(registeredId);
			} catch (error) {
				failures.push({ id: registeredId, error: String(error) });
			}
		}
		return { total: nextIds.size, added, removed, dropped, failures };
	};

	const sortedStatuses = (): ProviderStatus[] => [...statuses.values()].sort((a, b) => a.id.localeCompare(b.id));

	// The command surface. Each branch is one job; the dispatcher only routes to them.
	/** What `init`'s wizard needs from pi's command context: the dialogs, and whether there is one. */
	type WizardContext = {
		hasUI: boolean;
		ui: {
			input(title: string, placeholder?: string): Promise<string | undefined>;
			select(title: string, options: string[]): Promise<string | undefined>;
			confirm(title: string, message: string): Promise<boolean>;
		};
	};

	/**
	 * `init [<id>] [--url <u>] [--api <a>] [--models-path <p>] [--key <v>] [--force]`
	 *
	 * With a UI the wizard asks for whatever the flags did not answer; without one the flags are
	 * the whole interface and anything missing is a `Usage:` error. It writes `provider.json` and
	 * — only when a key was given and no `accounts.json` exists yet — `accounts.json`, then registers
	 * the vendor: a verb that wrote the directory applies its own write. `rescan` stays for the
	 * out-of-band case (files edited by hand, a directory added or deleted outside pi).
	 */
	const runInit = async (notify: Notify, ctx: WizardContext, positionals: string[], flags: ReadonlySet<string>, values: ReadonlyMap<string, string>): Promise<void> => {
		const ask = async (title: string, placeholder?: string): Promise<string | undefined> =>
			ctx.hasUI ? (await ctx.ui.input(title, placeholder))?.trim() || undefined : undefined;
		const id = positionals[0] ?? (await ask("Provider id (a directory under custom-providers/)", "my-relay"));
		const api = values.get("--api") ?? (ctx.hasUI ? await ctx.ui.select("Protocol (api)", [...BUILTIN_APIS]) : undefined);
		const url = values.get("--url") ?? (await ask("Base URL", "https://api.example.com/v1"));
		const init = VERBS.find((verb) => verb.name === "init")!;
		if (!id || !api || !url) {
			notify(`${ctx.hasUI ? "init: cancelled" : "init: needs an id, a base URL and a protocol"}\n${usageLine(init)}`, "warning");
			return;
		}
		const normalized = normalizeApi(api);
		if (!normalized) {
			notify(`init: unsupported api ${JSON.stringify(api)} (pi has ${BUILTIN_APIS.join(", ")})`, "warning");
			return;
		}
		const modelsPath = values.get("--models-path") ?? (await ask("Discovery path for the /models endpoint (blank = none)", "/models"));
		const offered = values.get("--key") ?? (ctx.hasUI && (await ctx.ui.confirm("Store an API key in accounts.json now?", "It is written verbatim: $VAR / !cmd keeps the secret out of the file.")) ? await ask("API key or reference", "$MY_VENDOR_KEY") : undefined);
		// `init` never resolves or echoes the value: it is a reference as often as it is a key.
		const lines = [writeProviderFile(path.join(root, id), { id, name: id, declaration: { api: normalized, baseUrl: url, ...(modelsPath ? { modelsPath } : {}) } }, flags.has("--force"))];
		if (offered) {
			lines.push(writeAccountsFile(path.join(root, id), offered, id));
			if (isLiteralCredential(offered)) lines.push(`${id}: the key is a literal, kept in the file as written (use $VAR or !cmd to keep it out of accounts.json)`);
		}
		// The directory is on disk now: register it here instead of handing the user a command to run.
		const applied = applyVendors(collectVendors(root, piProviderIds).vendors.filter((vendor) => vendor.id === id), id);
		const status = statuses.get(id);
		lines.push(
			applied.total === 0
				? `${id}: written, but nothing registered (check the files)`
				: status && status.models > 0
					? `registered ${id} in this session (${status.models} models)`
					: `registered ${id} in this session; no model table yet (\`sync ${id}\` fetches the live list)`,
		);
		for (const failure of applied.failures) lines.push(`could not unregister "${failure.id}" (${failure.error}); run pi's /reload to drop it`);
		notify(`init: ${toastLines(lines)}`, applied.failures.length > 0 ? "warning" : "info");
	};

	/**
	 * `drift` is not a verb any more: the count is one number on the `status` line, the detail one
	 * line in `status <id>`. Reported, never applied — `<id>/models.json` stays authoritative.
	 */
	const driftLines = (status: ProviderStatus): string[] => {
		const drift = status.drift;
		return drift ? [...drift.reasoning, ...drift.input, ...drift.maxTokens, ...drift.contextWindow] : [];
	};

	const runFiles = (notify: Notify): void => {
		// Re-scan: `init` may have written a provider.json after startup.
		const vendorFiles = collectVendors(root, piProviderIds);
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

	/** One vendor's sync: fetch every endpoint, apply only what answered, write the base table. */
	const syncVendor = async (vendor: Vendor, flags: ReadonlySet<string>): Promise<{ text: string; wrote: boolean; warning: boolean }> => {
		const entry = collectEntries([vendor], piProviderIds).entries.find((candidate) => candidate.base);
		if (!entry) return { text: `${vendor.id}: nothing to sync (nothing would register under that id)`, wrote: false, warning: false };
		const result = await refreshEntry(entry, layerFor(entry).patch, builtin, { allowFetch: true, signal: new AbortController().signal });
		const skipped = result.endpoints.filter((probe) => probe.skipped !== undefined || probe.empty === true);
		const notes = skipped.map((probe) => (probe.empty ? `${probe.api}: empty answer (skipped)` : `${probe.api}: ${(probe.skipped ?? "skipped").replace(/^Error: /, "")}`));
		// Nothing answered: there is no new data to apply, so rewriting the same bytes would only
		// touch the file (and its `.bak`) for no reason. Every endpoint missing its credential is the
		// one case worth a warning: the directory looks configured while the probe is skipped.
		if (result.endpoints.length === 0 || skipped.length === result.endpoints.length) {
			const uncredentialed = result.endpoints.length > 0 && result.endpoints.every((probe) => probe.reason === "no-credential");
			return { text: `${vendor.id}: no endpoint answered${notes.length > 0 ? ` (${notes.join("; ")})` : ""} — nothing written`, wrote: false, warning: uncredentialed };
		}
		// The file is the base table: only the endpoints that answered may patch it, and the user's
		// `models.json` layer is never an input (a sync must not bake an override into its base).
		let models = vendor.models;
		for (const probe of result.endpoints) {
			if (!probe.rows || probe.empty) continue;
			models = applyLiveModels(models, probe.rows, probe.api).models;
		}
		const prune = flags.has("--prune");
		if (prune && result.vanished.length > 0) {
			const gone = new Set(result.vanished);
			models = models.filter((model) => !gone.has(model.id));
		}
		const merged = baseTableView(models, vendor.declaration, []);
		const file = path.join(vendor.directory!, "models.json");
		const diff = diffBaseTable(vendor.id, file, merged, vendor.models);
		const report = [
			...summarizeDiff(diff),
			...(!prune && result.vanished.length > 0 ? [`vanished (kept, pass --prune to drop): ${result.vanished.join(", ")}`] : []),
			...notes.map((note) => `skipped ${note}`),
		];
		if (flags.has("--dry-run")) return { text: `${vendor.id} (dry run): ${report.length > 0 ? report.join("; ") : "base table already current"}`, wrote: false, warning: false };
		if (!diff.dirty) return { text: `${vendor.id}: base table already current${report.length > 0 ? `; ${report.join("; ")}` : ""}`, wrote: false, warning: false };
		const { backup } = writeBaseTable(file, merged);
		return { text: `${vendor.id}: wrote ${merged.length} model(s)${backup ? ` (backup: ${path.basename(backup)})` : ""}${report.length > 0 ? `; ${report.join("; ")}` : ""}`, wrote: true, warning: false };
	};

	const runSync = async (notify: Notify, id: string | undefined, flags: ReadonlySet<string>): Promise<void> => {
		// Re-scan: `init` (or the user) may have written a directory after startup.
		const vendors = collectVendors(root, piProviderIds).vendors.filter((vendor) => vendor.directory && (id === undefined || vendor.id === id));
		if (vendors.length === 0) {
			notify(id ? `No provider directory named "${id}" under custom-providers/` : "No provider directory under custom-providers/", "warning");
			return;
		}
		const reports: string[] = [];
		const written: string[] = [];
		let warning = false;
		for (const vendor of vendors) {
			const report = await syncVendor(vendor, flags);
			reports.push(report.text);
			warning = warning || report.warning;
			if (report.wrote) written.push(vendor.id);
		}
		// The write changed the disk, so apply it here: `rescan` stays for edits made outside pi, and
		// the probe this round just ran is what the fresh registration serves (no second round trip).
		if (written.length > 0) {
			const fresh = collectVendors(root, piProviderIds).vendors;
			for (const vendorId of written) {
				const applied = applyVendors(fresh.filter((vendor) => vendor.id === vendorId), vendorId);
				for (const failure of applied.failures) notify(`sync: could not unregister "${failure.id}" (${failure.error}); run pi's /reload to drop it`, "warning");
			}
		}
		notify(`sync: ${toastLines(reports)}${written.length > 0 ? `\nregistered ${written.join(", ")} in this session` : ""}`, warning ? "warning" : "info");
	};

	/**
	 * `rescan [<id>] [--dry-run]` — apply a *hand-made* change to the session: a hand-edited
	 * `provider.json` / `models.json` / `accounts.json`, or a directory added or deleted outside pi.
	 * The verbs that write (`sync`, `init`) apply their own write; this one is for what no verb of
	 * ours knows about, which is also why it is the only verb that moves registration without
	 * touching the directory.
	 */
	const runRescan = async (notify: Notify, id: string | undefined, flags: ReadonlySet<string>): Promise<void> => {
		const vendors = collectVendors(root, piProviderIds).vendors.filter((vendor) => id === undefined || vendor.id === id);
		if (id !== undefined && vendors.length === 0) {
			notify(`No provider directory named "${id}" under custom-providers/`, "warning");
			return;
		}
		const result = applyVendors(vendors, id, { dryRun: flags.has("--dry-run") });
		if (flags.has("--dry-run")) {
			notify(`rescan (dry run): ${result.total} provider(s), ${result.added.length} new, ${result.removed.length} to unregister${result.removed.length > 0 ? ` (${result.removed.join(", ")})` : ""}`);
			return;
		}
		for (const failure of result.failures) notify(`rescan: could not unregister "${failure.id}" (${failure.error}); run pi's /reload to drop it`, "warning");
		notify(`rescan: registered ${result.total} provider(s)${result.added.length > 0 ? `, ${result.added.length} new (${result.added.join(", ")})` : ""}${result.dropped.length > 0 ? `, unregistered ${result.dropped.join(", ")}` : ""}`);
	};

	/** One provider's detail, or the list when no id is given. */
	const runStatus = (notify: Notify, id?: string): void => {
		if (id) {
			const status = statuses.get(id);
			if (!status) {
				notify(`Unknown provider "${id}" (known: ${sortedStatuses().map((entry) => entry.id).join(", ") || "none"})\n${usageOverview()}`, "warning");
				return;
			}
			const drift = driftLines(status);
			const detail = [
				`${status.models} models (${status.live ? "live" : "base"})`,
				`apis: ${status.apis.map((entry) => `${entry.api} ${entry.models}`).join(", ")}`,
				`accounts: ${status.accounts.length > 0 ? status.accounts.join(", ") : "none"}`,
				...(status.error ? [`error: ${status.error}`] : []),
				...status.unknown.map((id) => `new: ${id}`),
				...(drift.length > 0 ? [`built-in catalog (reported, not applied): ${toastLines(drift, 8)}`] : []),
				...[...new Set(status.issues.map((issue) => `${issue.level}: ${issue.message}`))],
			];
			notify(`${status.id}: ${toastLines(detail)}`, status.error ? "warning" : "info");
			return;
		}
		const lines = sortedStatuses().map((status) => {
			const origin = status.live ? "live" : "base";
			const apis = status.apis.length > 1 ? ` [${status.apis.map((entry) => `${entry.api} ${entry.models}`).join(", ")}]` : "";
			const drift = driftLines(status).length;
			return `${status.id}: ${status.models} models (${origin})${apis}${status.unknown.length > 0 ? `, new: ${status.unknown.length}` : ""}${status.error ? ", refresh failed" : ""}${drift > 0 ? `, drift ${drift}` : ""}`;
		});
		const problems = problemLines(sortedStatuses(), globalIssues);
		notify(`Providers: ${toastLines(lines)}${problems.length > 0 ? `; issues: ${toastLines(problems)}` : ""}`, problems.length > 0 ? "warning" : "info");
	};

	pi.registerCommand(COMMAND, {
		description: commandDescription(),
		handler: async (args, ctx) => {
			const notify: Notify = (message, level = "info") => ctx.ui.notify(message, level);
			const parsed = parseCommand(args);
			if (!parsed.ok) return notify(parsed.failure.message, "warning");
			const { verb, positionals, flags, values } = parsed.command;
			if (verb.name === "files") return runFiles(notify);
			if (verb.name === "init") return runInit(notify, ctx, positionals, flags, values);
			if (verb.name === "sync") return runSync(notify, positionals[0], flags);
			if (verb.name === "rescan") return runRescan(notify, positionals[0], flags);
			return runStatus(notify, positionals[0]);
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
