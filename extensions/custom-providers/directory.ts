/**
 * The directory layer: one subdirectory of `~/.pi/agent/custom-providers/` is one vendor.
 *
 * Discovery is a scan, not an index: every subdirectory with a *parseable* `provider.json` is
 * one vendor; everything else is ignored and listed by the `files` command. There is no index
 * file — a second source of truth for the same fact.
 *
 * Failure is file-level (`fail-closed`): a `models.json` or `accounts.json` that does not parse
 * means the whole vendor is not registered, because a broken file would otherwise silently
 * shrink a provider's model list. Entry-level problems (a model without an `id`, an account
 * without a key, an unknown key) only skip that entry — that grading lives in the three payload
 * readers; this file owns the assembly of their results, the takeover whitelist and the id
 * namespace.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readAccountsFile, resolveAccounts } from "./credentials.ts";
import type { ProviderDeclaration } from "./config.ts";
import { readModelsFile } from "./model-table.ts";
import { readProviderFile } from "./endpoints.ts";
import type { Account, CatalogModel, LoadIssue, Vendor } from "./types.ts";
import { readJson } from "./util.ts";

/** The three files of one directory, each either absent, parsed, or broken. */
export interface DirectoryVendor {
	id: string;
	directory: string;
	name: string;
	declaration: ProviderDeclaration;
	/** The base model table from `models.json`; empty when the file is absent. */
	models: CatalogModel[];
	/** Parseable `provider.json` — a directory without one is not a vendor at all. */
	loadable: boolean;
	accounts: Account[];
	defaultPointer?: string;
	override: boolean;
	/** A file that exists but does not parse: do not register this vendor. */
	fatal: boolean;
	issues: LoadIssue[];
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
	// The readers stamp their messages with the file they read. Name it relative to the vendor
	// directory: the report already says *which* directory it is talking about, and an absolute
	// path would make the same problem read differently in the scan's list and in the
	// provider's own status (`problemLines` compares the two).
	const provider = readProviderFile(path.join(directory, "provider.json"), issues, "provider.json");
	if (!provider) {
		return { id, directory, name: id, declaration: { api: "", baseUrl: "", apis: {} }, models: [], loadable: false, accounts: [], override: false, fatal: true, issues };
	}
	const models = readModelsFile(path.join(directory, "models.json"), issues, "models.json");
	const accounts = readAccountsFile(path.join(directory, "accounts.json"), issues, "accounts.json");
	return {
		id,
		directory,
		name: provider.name ?? id,
		declaration: provider.declaration,
		models: models.models,
		loadable: true,
		accounts: accounts.accounts,
		...(accounts.defaultPointer ? { defaultPointer: accounts.defaultPointer } : {}),
		override: provider.override,
		fatal: models.broken || accounts.broken,
		issues,
	};
}

/** Turn one parsed directory into a `Vendor`, reporting whatever it had to fall back on. */
function vendorFromDirectory(loaded: DirectoryVendor, shipped: Vendor | undefined, issues: LoadIssue[]): Vendor {
	const resolved = resolveAccounts(loaded.accounts, loaded.defaultPointer, {
		...(shipped?.defaultAccount ? { defaultAccount: shipped.defaultAccount } : {}),
		id: loaded.id,
	});
	issues.push(...resolved.issues);
	// A directory only has to speak where it differs: the shipped default for the same id
	// fills in the endpoints the directory leaves out.
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
		// The extension ships no model table: empty until a directory `models.json` or discovery
		// fills it (and a later `sync --write` can persist that).
		models: loaded.models,
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
 * the matching directory (endpoints, env-var account). `piProviderIds` are pi's
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
		// The scan reports the same text the vendor's own status carries, with the location in
		// front — one problem, one wording, so `problemLines` can dedupe the two.
		issues.push(...loaded.issues.map((issue) => ({ ...issue, message: `custom-providers/${dir}: ${issue.message}` })));
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
		byId.set(dir, vendor);
	}
	return { vendors: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), ignored, issues };
}
