/**
 * The directory layer: `~/.pi/agent/custom-providers/<id>/{provider.json,models.json,accounts.json}`.
 *
 * Discovery is a scan, not an index: every subdirectory that has a *parseable*
 * `provider.json` is one vendor; everything else is ignored and listed by the `files`
 * command. There is no index file — a second source of truth for the same fact.
 *
 * Failure is file-level (`fail-closed`): a `models.json` or `accounts.json` that does
 * not parse means the whole vendor is not registered, because a broken file would
 * otherwise silently shrink a provider's model list. Entry-level problems (a model
 * without an `id`, an account without a key, an unknown key) only skip that entry.
 *
 * Nothing here writes. The only writer in this package is `sync-models.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { BUILTIN_APIS, normalizeApi, type JsonObject, type ProviderDeclaration } from "./config.ts";
import type { Account, CatalogModel, LoadIssue, Vendor } from "./types.ts";

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** `provider.json` keys this package reads. Everything else is reported, never guessed at. */
const PROVIDER_KEYS = new Set(["name", "api", "baseUrl", "modelsPath", "headers", "apis", "override"]);
/** Keys that belong to `accounts.json`; seeing them here is a misplacement, not a style choice. */
const CREDENTIAL_KEYS = new Set(["apiKey", "envVar", "authHeader"]);
/** JSON cannot express these, so they are reported instead of being dropped in silence. */
const UNSUPPORTED_KEYS = new Set(["oauth", "streamSimple", "refreshModels"]);
/** One model entry = pi's `ModelDefinitionSchema` fields, and nothing else. */
const MODEL_KEYS = new Set(["id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "samplingParams", "headers", "compat"]);
const ACCOUNT_KEYS = new Set(["apiKey", "authHeader", "headers"]);
const ACCOUNT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

const stringOr = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const numberOr = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

type JsonRead = { value?: unknown; missing?: boolean; issue?: string };

function readJson(file: string): JsonRead {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { missing: true };
		return { issue: `cannot read ${file}: ${String(error)}` };
	}
	try {
		return { value: JSON.parse(raw) };
	} catch (error) {
		return { issue: `cannot parse ${file}: ${String(error)}` };
	}
}

/** The three files of one directory, each either absent, parsed, or broken. */
export interface DirectoryVendor {
	id: string;
	directory: string;
	name: string;
	declaration: ProviderDeclaration;
	/** The base model table from `models.json`; empty when the file is absent. */
	models: CatalogModel[];
	hasModelsFile: boolean;
	/** Parseable `provider.json` — a directory without one is not a vendor at all. */
	loadable: boolean;
	accounts: Account[];
	defaultPointer?: string;
	override: boolean;
	/** A file that exists but does not parse: do not register this vendor. */
	fatal: boolean;
	issues: LoadIssue[];
}

/**
 * One model entry, read field by field so a single bad value does not discard an
 * otherwise usable model. Unknown keys are warnings: this file is hand-written, and a
 * typo here is exactly the failure this package exists to prevent.
 */
function readModelEntry(raw: JsonObject, index: number, issues: LoadIssue[]): CatalogModel | undefined {
	const id = stringOr(raw.id);
	if (!id) {
		issues.push({ level: "warning", message: `model #${index} has no "id"` });
		return undefined;
	}
	for (const key of Object.keys(raw)) {
		if (!MODEL_KEYS.has(key)) issues.push({ level: "warning", message: `${id}: unknown key "${key}"` });
	}
	const input = Array.isArray(raw.input) ? raw.input.filter((value): value is "text" | "image" => value === "text" || value === "image") : [];
	const cost = isObject(raw.cost) ? raw.cost : undefined;
	return {
		id,
		name: stringOr(raw.name) ?? id,
		...(stringOr(raw.api) ? { api: raw.api as string } : {}),
		...(stringOr(raw.baseUrl) ? { baseUrl: raw.baseUrl as string } : {}),
		reasoning: raw.reasoning === true,
		input: input.length > 0 ? input : ["text"],
		contextWindow: numberOr(raw.contextWindow) ?? 128000,
		maxTokens: numberOr(raw.maxTokens) ?? 16384,
		cost: {
			input: numberOr(cost?.input) ?? 0,
			output: numberOr(cost?.output) ?? 0,
			cacheRead: numberOr(cost?.cacheRead) ?? 0,
			cacheWrite: numberOr(cost?.cacheWrite) ?? 0,
		},
		...(isObject(raw.thinkingLevelMap) ? { thinkingLevelMap: raw.thinkingLevelMap } : {}),
		...(isObject(raw.headers) ? { headers: raw.headers } : {}),
		...(isObject(raw.compat) ? { compat: raw.compat } : {}),
	};
}

/** `models.json`: either a bare array (accepted shorthand) or the canonical `{models: []}`. */
function readModelsFile(file: string, issues: LoadIssue[]): { models: CatalogModel[]; present: boolean; broken: boolean } {
	const { value, missing, issue } = readJson(file);
	if (missing) return { models: [], present: false, broken: false };
	if (issue) {
		issues.push({ level: "error", message: issue });
		return { models: [], present: true, broken: true };
	}
	const rows = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.models) ? value.models : undefined;
	if (!rows) {
		issues.push({ level: "error", message: `${file} must be an array or {"models": [...]}` });
		return { models: [], present: true, broken: true };
	}
	const models: CatalogModel[] = [];
	rows.forEach((row, index) => {
		if (!isObject(row)) {
			issues.push({ level: "warning", message: `model #${index}: must be an object` });
			return;
		}
		const model = readModelEntry(row, index, issues);
		if (model) models.push(model);
	});
	return { models, present: true, broken: false };
}

/** `accounts.json`: credentials only — a model or endpoint key here is a misplacement. */
function readAccountsFile(file: string, issues: LoadIssue[]): { accounts: Account[]; defaultPointer?: string; broken: boolean } {
	const { value, missing, issue } = readJson(file);
	if (missing) return { accounts: [], broken: false };
	if (issue) {
		issues.push({ level: "error", message: issue });
		return { accounts: [], broken: true };
	}
	if (!isObject(value)) {
		issues.push({ level: "error", message: `${file}: root must be a JSON object` });
		return { accounts: [], broken: true };
	}
	const accounts: Account[] = [];
	let defaultPointer: string | undefined;
	if (value.default !== undefined) {
		if (typeof value.default === "string") defaultPointer = value.default;
		else issues.push({ level: "warning", message: `${file}: "default" must be an account id string` });
	}
	for (const [id, entry] of Object.entries(value)) {
		if (id === "default") continue;
		if (!ACCOUNT_ID_RE.test(id)) {
			issues.push({ level: "warning", message: `account "${id}": invalid name (want ^[a-z][a-z0-9-]{0,31}$)` });
			continue;
		}
		if (!isObject(entry)) {
			issues.push({ level: "warning", message: `account "${id}": must be an object` });
			continue;
		}
		for (const key of Object.keys(entry)) {
			if (!ACCOUNT_KEYS.has(key)) issues.push({ level: "warning", message: `account "${id}": "${key}" is not an auth field; put model overrides in models.json` });
		}
		const apiKey = stringOr(entry.apiKey);
		if (!apiKey) {
			issues.push({ level: "warning", message: `account "${id}": needs "apiKey"` });
			continue;
		}
		if (entry.authHeader !== undefined && typeof entry.authHeader !== "boolean") issues.push({ level: "warning", message: `account "${id}": "authHeader" has the wrong type` });
		if (entry.headers !== undefined && !isObject(entry.headers)) issues.push({ level: "warning", message: `account "${id}": "headers" has the wrong type` });
		accounts.push({
			id,
			apiKey,
			...(typeof entry.authHeader === "boolean" ? { authHeader: entry.authHeader } : {}),
			...(isObject(entry.headers) ? { headers: entry.headers } : {}),
		});
	}
	return { accounts, ...(defaultPointer ? { defaultPointer } : {}), broken: false };
}

/** `provider.json`: the endpoint table — no secrets, no compat, no functions. */
function readProviderFile(file: string, issues: LoadIssue[]): { declaration: ProviderDeclaration; name?: string; override: boolean } | undefined {
	const { value, issue } = readJson(file);
	if (issue) {
		issues.push({ level: "error", message: issue });
		return undefined;
	}
	if (!isObject(value)) {
		issues.push({ level: "error", message: `${file}: root must be a JSON object` });
		return undefined;
	}
	for (const key of Object.keys(value)) {
		if (PROVIDER_KEYS.has(key)) continue;
		if (CREDENTIAL_KEYS.has(key)) issues.push({ level: "warning", message: `${file}: "${key}" belongs in accounts.json` });
		else if (key === "compat") issues.push({ level: "warning", message: `${file}: "compat" belongs on model entries in models.json` });
		else if (UNSUPPORTED_KEYS.has(key)) issues.push({ level: "warning", message: `${file}: "${key}" is not supported in provider files` });
		else issues.push({ level: "warning", message: `${file}: unknown key "${key}"` });
	}

	const api = normalizeApi(value.api);
	if (!api) {
		issues.push({ level: "error", message: `${file}: unsupported api ${JSON.stringify(value.api)} (pi has ${BUILTIN_APIS.join(", ")})` });
		return undefined;
	}
	const baseUrl = stringOr(value.baseUrl);
	if (!baseUrl) {
		issues.push({ level: "error", message: `${file}: "baseUrl" is required` });
		return undefined;
	}
	if (value.modelsPath !== undefined && !stringOr(value.modelsPath)) issues.push({ level: "warning", message: `${file}: "modelsPath" has the wrong type` });
	if (value.headers !== undefined && !isObject(value.headers)) issues.push({ level: "warning", message: `${file}: "headers" has the wrong type` });
	if (value.override !== undefined && typeof value.override !== "boolean") issues.push({ level: "warning", message: `${file}: "override" has the wrong type` });

	const apis: ProviderDeclaration["apis"] = {};
	if (value.apis !== undefined && !isObject(value.apis)) {
		issues.push({ level: "warning", message: `${file}: "apis" has the wrong type` });
	} else if (isObject(value.apis)) {
		for (const [rawApi, entry] of Object.entries(value.apis)) {
			const extraApi = normalizeApi(rawApi);
			if (!extraApi) {
				issues.push({ level: "warning", message: `${file}: apis.${rawApi}: unsupported api` });
				continue;
			}
			if (extraApi === api) {
				issues.push({ level: "warning", message: `${file}: apis.${extraApi}: already the default endpoint` });
				continue;
			}
			if (apis[extraApi]) {
				// Two spellings of the same protocol (`anthropic` and `anthropic-messages`): the
				// first one wins instead of the file's key order deciding the endpoint.
				issues.push({ level: "warning", message: `${file}: apis.${extraApi}: already declared` });
				continue;
			}
			if (!isObject(entry)) {
				issues.push({ level: "warning", message: `${file}: apis.${extraApi}: must be an object` });
				continue;
			}
			for (const key of Object.keys(entry)) {
				if (key === "baseUrl" || key === "modelsPath" || key === "headers") continue;
				if (CREDENTIAL_KEYS.has(key)) issues.push({ level: "warning", message: `${file}: apis.${extraApi}.${key} belongs in accounts.json` });
				else if (key === "compat") issues.push({ level: "warning", message: `${file}: apis.${extraApi}: "compat" belongs on model entries in models.json` });
				else issues.push({ level: "warning", message: `${file}: apis.${extraApi}: unknown key "${key}"` });
			}
			const extraBaseUrl = stringOr(entry.baseUrl);
			if (!extraBaseUrl) {
				issues.push({ level: "warning", message: `${file}: apis.${extraApi}: "baseUrl" is required` });
				continue;
			}
			const modelsPath = stringOr(entry.modelsPath);
			if (entry.modelsPath !== undefined && !modelsPath) issues.push({ level: "warning", message: `${file}: apis.${extraApi}: "modelsPath" has the wrong type` });
			apis[extraApi] = {
				baseUrl: extraBaseUrl,
				// Absent = inherit `provider.json.modelsPath`; the endpoint resolver decides.
				...(modelsPath ? { modelsPath } : {}),
				...(isObject(entry.headers) ? { headers: entry.headers } : {}),
			};
		}
	}

	const modelsPath = stringOr(value.modelsPath);
	return {
		declaration: {
			api,
			baseUrl,
			...(modelsPath ? { modelsPath } : {}),
			...(isObject(value.headers) ? { headers: value.headers } : {}),
			apis,
		},
		...(stringOr(value.name) ? { name: value.name as string } : {}),
		override: value.override === true,
	};
}

/** Directories under the provider root: the ones with a `provider.json`, and the rest. */
export function scanProviderRoot(rootDir: string): { dirs: string[]; ignored: string[] } {
	let entries: string[];
	try {
		entries = readdirSync(rootDir);
	} catch {
		return { dirs: [], ignored: [] };
	}
	const dirs: string[] = [];
	const ignored: string[] = [];
	for (const name of entries.sort()) {
		if (name.startsWith(".")) continue;
		try {
			if (!statSync(path.join(rootDir, name)).isDirectory()) continue;
		} catch {
			continue;
		}
		if (readJson(path.join(rootDir, name, "provider.json")).value !== undefined) dirs.push(name);
		else ignored.push(name);
	}
	return { dirs, ignored };
}

/**
 * Parse one vendor directory. `loadable` is false when there is no usable
 * `provider.json` (not a vendor at all); `fatal` is true when a file that exists does
 * not parse, which makes the vendor unregisterable but is still reported.
 */
export function loadDirectory(rootDir: string, id: string): DirectoryVendor {
	const directory = path.join(rootDir, id);
	const issues: LoadIssue[] = [];
	const provider = readProviderFile(path.join(directory, "provider.json"), issues);
	if (!provider) {
		return { id, directory, name: id, declaration: { api: "", baseUrl: "", apis: {} }, models: [], hasModelsFile: false, loadable: false, accounts: [], override: false, fatal: true, issues };
	}
	const models = readModelsFile(path.join(directory, "models.json"), issues);
	const accounts = readAccountsFile(path.join(directory, "accounts.json"), issues);
	return {
		id,
		directory,
		name: provider.name ?? id,
		declaration: provider.declaration,
		models: models.models,
		hasModelsFile: models.present,
		loadable: true,
		accounts: accounts.accounts,
		...(accounts.defaultPointer ? { defaultPointer: accounts.defaultPointer } : {}),
		override: provider.override,
		fatal: models.broken || accounts.broken,
		issues,
	};
}

/**
 * Which account registers as the base id (design §3.3 ②, §8):
 *
 *   - accounts plus a `default` pointer that names one → that account is the base;
 *   - accounts but no usable pointer → the base id is *suppressed* (the accounts were
 *     declared explicitly);
 *   - a shipped default account (env var) → it becomes the base and the declared
 *     accounts are added as extras;
 *   - no accounts at all → the base id is still registered, without credentials, so
 *     `/login`, `--api-key` and stored credentials can still rescue it.
 */
export function resolveAccounts(
	accounts: readonly Account[],
	pointer: string | undefined,
	options: { defaultAccount?: Account & { envVar: string }; id?: string } = {},
): { accounts: Account[]; baseAccount?: Account; baseSuppressed: boolean; issues: LoadIssue[] } {
	const issues: LoadIssue[] = [];
	const fallback: Account | undefined = options.defaultAccount
		? {
				id: options.defaultAccount.id,
				apiKey: options.defaultAccount.apiKey ?? `$${options.defaultAccount.envVar}`,
				...(options.defaultAccount.authHeader !== undefined ? { authHeader: options.defaultAccount.authHeader } : {}),
				...(options.defaultAccount.headers ? { headers: options.defaultAccount.headers } : {}),
			}
		: undefined;
	if (accounts.length === 0) return { accounts: fallback ? [fallback] : [], ...(fallback ? { baseAccount: fallback } : {}), baseSuppressed: false, issues };

	const pointerAccount = pointer ? accounts.find((account) => account.id === pointer) : undefined;
	if (pointer && !pointerAccount) issues.push({ level: "warning", message: `"default": "${pointer}" does not name an account` });
	if (pointerAccount) return { accounts: [...accounts], baseAccount: pointerAccount, baseSuppressed: false, issues };
	const id = options.id ?? "this provider";
	if (!fallback) {
		// Accounts were declared but none of them is the base one: the user is managing the ids
		// explicitly, so do not also register an id they did not ask for.
		issues.push({
			level: "warning",
			message: `${pointer ? "" : 'no "default" account: '}${id} is not registered (custom-providers/${id}/accounts.json)${pointer ? `: "default" names no account` : ""}`,
		});
	}
	return {
		accounts: fallback ? [...accounts, fallback] : [...accounts],
		...(fallback ? { baseAccount: fallback } : {}),
		baseSuppressed: !fallback,
		issues,
	};
}

/** Turn one parsed directory into a `Vendor`, or into issues when it must not register. */
function vendorFromDirectory(loaded: DirectoryVendor, shipped: Vendor | undefined, issues: LoadIssue[]): Vendor | undefined {
	const resolved = resolveAccounts(loaded.accounts, loaded.defaultPointer, {
		...(shipped?.defaultAccount ? { defaultAccount: shipped.defaultAccount } : {}),
		id: loaded.id,
	});
	issues.push(...resolved.issues);
	// A directory only has to speak where it differs: the shipped default for the same id
	// fills in the endpoints and the model table the directory leaves out.
	const declaration: ProviderDeclaration = !shipped
		? loaded.declaration
		: {
				api: loaded.declaration.api || shipped.declaration.api,
				baseUrl: loaded.declaration.baseUrl || shipped.declaration.baseUrl,
				...(loaded.declaration.modelsPath || shipped.declaration.modelsPath ? { modelsPath: loaded.declaration.modelsPath ?? shipped.declaration.modelsPath } : {}),
				...(loaded.declaration.headers || shipped.declaration.headers ? { headers: loaded.declaration.headers ?? shipped.declaration.headers } : {}),
				apis: { ...shipped.declaration.apis, ...loaded.declaration.apis },
			};
	return {
		id: loaded.id,
		name: loaded.name,
		aliases: shipped?.aliases ?? [loaded.id],
		declaration,
		// The shipped model table stands in when the directory declares none.
		models: loaded.hasModelsFile ? loaded.models : (shipped?.models ?? []),
		origin: "directory",
		...(shipped?.defaultAccount ? { defaultAccount: shipped.defaultAccount } : {}),
		accounts: resolved.accounts,
		...(resolved.baseAccount ? { baseAccount: resolved.baseAccount } : {}),
		...(resolved.baseSuppressed ? { baseSuppressed: true } : {}),
		override: loaded.override || (shipped?.override ?? false),
		directory: loaded.directory,
		issues: loaded.issues,
	};
}

/**
 * Every vendor this extension registers: one per `custom-providers/<id>/provider.json`.
 * The shipped `defaults` in `sources.ts` are never registered on their own — they only seed
 * the matching directory (endpoints, model table, env-var account). `piProviderIds` are pi's
 * own provider ids: a directory may only take one of those over with `"override": true` (§8).
 */
export function collectVendors(
	rootDir: string,
	defaults: readonly Vendor[],
	piProviderIds: ReadonlySet<string>,
): { vendors: Vendor[]; ignored: string[]; issues: LoadIssue[] } {
	const { dirs, ignored } = scanProviderRoot(rootDir);
	const issues: LoadIssue[] = [];
	const byId = new Map<string, Vendor>();
	const defaultById = new Map(defaults.map((vendor) => [vendor.id, vendor]));
	const reserved = new Set([...defaults.map((vendor) => vendor.id), ...defaults.flatMap((vendor) => vendor.aliases)]);

	for (const dir of dirs) {
		if (reserved.has(dir) && !defaultById.has(dir)) {
			issues.push({ level: "warning", message: `directory "${dir}" collides with an alias of another vendor; skipping it` });
			continue;
		}
		const loaded = loadDirectory(rootDir, dir);
		issues.push(...loaded.issues.map((issue) => ({ ...issue, message: `custom-providers/${dir}: ${issue.message.replace(/^\/.*\//, "")}` })));
		if (loaded.fatal) {
			issues.push({ level: "error", message: `custom-providers/${dir}: not registered (fix the file above)` });
			continue;
		}
		if (piProviderIds.has(dir) && !loaded.override) {
			issues.push({ level: "warning", message: `provider ${dir} exists in pi; set "override": true to take it over` });
			continue;
		}
		// Same array, not a copy: `resolveAccounts` reports into it too.
		const vendor = vendorFromDirectory(loaded, defaultById.get(dir), issues);
		if (!vendor) continue;
		byId.set(dir, vendor);
	}
	return { vendors: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), ignored, issues };
}
