/**
 * `<id>/accounts.json` — credentials only (`apiKey`, `authHeader`, `headers`) plus the
 * `default` pointer that names the base account.
 *
 * An `apiKey` is a *reference*, not necessarily a secret: pi resolves it at request time
 * (`resolveConfigValue`), so the forms are exactly the ones pi knows — `sk-…` (plaintext, with
 * `$$`/`$!` to escape a literal leading `$`/`!`), `$VAR` / `${VAR}` / a bare `UPPER_SNAKE`
 * (environment variable), and `!command` (how a keyring or password manager is reached:
 * `!secret-tool lookup …`, `!pass show …`, `!op read …`). Nothing secret has to sit on disk, and
 * this package passes the reference through — it never resolves it into a literal that pi might
 * then persist.
 *
 * Read and written here, and nowhere else: `resolveAccounts` is the id policy that follows from
 * the file (design §3.3 ②/§8) — which account registers as the base id, and the case where the
 * base id is deliberately suppressed because the user declared accounts but named none — and
 * `writeAccountsFile` is `init`'s writer, the package's third and last write outlet.
 *
 * Credential *selection* lives here too, not at the callers: `registrationCredential` (what
 * `pi.registerProvider` is handed) and `discoveryCredential` (what this package's own `/models`
 * probe sends, in pi's order). Both callers used to decide a part of it themselves, which is how
 * the probe's auth shape and the shape pi really sends could drift apart.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { configValueForPi, resolveConfigValue } from "./env.ts";
import type { Account, LoadIssue } from "./types.ts";
import { isObject, readJson, serializeJson, stringOr, writeTextAtomic, type JsonObject } from "./util.ts";

/**
 * Credential keys this package accepts *only* in an account: meeting one in `provider.json` is a
 * misplacement, so the reader can say where it belongs. That is this package's policy, not a
 * pi limit — pi's own `ProviderConfigSchema` accepts provider-level `apiKey`/`authHeader` too;
 * here credentials have exactly one home.
 *
 * `headers` is an account key *and* a legitimate endpoint key (at both `provider.json` levels),
 * so it is no displacement signal.
 */
export const CREDENTIAL_KEYS = new Set(["apiKey", "authHeader"]);

/** What an account may hold — derived, so the displacement warning above cannot drift from it. */
const ACCOUNT_KEYS = new Set([...CREDENTIAL_KEYS, "headers"]);

const ACCOUNT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * `accounts.json`: credentials only — a model or endpoint key here is a misplacement. `label` is
 * how the file is named in messages; the path is still what gets read.
 */
export function readAccountsFile(file: string, issues: LoadIssue[], label = file): { accounts: Account[]; defaultPointer?: string; broken: boolean } {
	const { value, missing, issue } = readJson(file, label);
	if (missing) return { accounts: [], broken: false };
	if (issue) {
		issues.push({ level: "error", message: issue });
		return { accounts: [], broken: true };
	}
	if (!isObject(value)) {
		issues.push({ level: "error", message: `${label}: root must be a JSON object` });
		return { accounts: [], broken: true };
	}
	const accounts: Account[] = [];
	let defaultPointer: string | undefined;
	if (value.default !== undefined) {
		if (typeof value.default === "string") defaultPointer = value.default;
		else issues.push({ level: "warning", message: `${label}: "default" must be an account id string` });
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
			if (!ACCOUNT_KEYS.has(key)) issues.push({ level: "warning", message: `account "${id}": unknown key "${key}" (an account holds ${[...ACCOUNT_KEYS].join(", ")})` });
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

/**
 * Which account registers as the base id (design §3.3 ②, §8):
 *
 *   - accounts plus a `default` pointer that names one → that account is the base;
 *   - accounts but no usable pointer → the base id is *suppressed* (the accounts were
 *     declared explicitly);
 *   - no accounts at all → the base id is still registered, without credentials, so
 *     `/login`, `--api-key` and stored credentials can still rescue it.
 */
export function resolveAccounts(
	accounts: readonly Account[],
	pointer: string | undefined,
	options: { id?: string } = {},
): { accounts: Account[]; baseAccount?: Account; baseSuppressed: boolean; issues: LoadIssue[] } {
	const issues: LoadIssue[] = [];
	if (accounts.length === 0) return { accounts: [], baseSuppressed: false, issues };

	const pointerAccount = pointer ? accounts.find((account) => account.id === pointer) : undefined;
	if (pointer && !pointerAccount) issues.push({ level: "warning", message: `"default": "${pointer}" does not name an account` });
	if (pointerAccount) return { accounts: [...accounts], baseAccount: pointerAccount, baseSuppressed: false, issues };
	// Accounts were declared but none of them is the base one: the user is managing the ids
	// explicitly, so do not also register an id they did not ask for.
	const id = options.id ?? "this provider";
	issues.push({
		level: "warning",
		message: `${pointer ? "" : 'no "default" account: '}${id} is not registered (custom-providers/${id}/accounts.json)${pointer ? `: "default" names no account` : ""}`,
	});
	return { accounts: [...accounts], baseSuppressed: true, issues };
}

/**
 * The two places an account can come from: the vendor directory (one entry per account) and the
 * credential pi itself resolved for this session. Both functions below need nothing else from a
 * vendor entry.
 */
type CredentialSource = {
	id: string;
	account?: Account;
};

/**
 * The `authHeader` a provider asked for, from its account. `undefined` means nothing here declared
 * one, which leaves pi's own provider-level value in charge.
 */
function accountAuthHeader(entry: CredentialSource): boolean | undefined {
	return entry.account?.authHeader;
}

/** `readStoredCredential` returns whatever pi stores; only `{ key: string }` is a usable key. */
function storedKey(id: string): string | undefined {
	try {
		const credential = readStoredCredential(id);
		return credential && typeof credential === "object" && "key" in credential && typeof (credential as { key?: unknown }).key === "string" ? (credential as { key: string }).key : undefined;
	} catch {
		return undefined;
	}
}

/**
 * What `pi.registerProvider` is handed: the base account's `apiKey` as a *reference* (pi resolves
 * it at request time, so no secret is read or persisted here) plus the `authHeader` this provider
 * asked for. `authHeader` stays absent when nothing declared one, which is what lets a
 * provider-level value in pi's global `models.json` still decide (pi reads
 * `extension?.authHeader ?? config?.authHeader ?? false`).
 */
export function registrationCredential(entry: CredentialSource): { apiKey?: string; authHeader?: boolean } {
	const apiKey = configValueForPi(entry.account?.apiKey);
	const authHeader = accountAuthHeader(entry);
	return { ...(apiKey ? { apiKey } : {}), ...(authHeader !== undefined ? { authHeader } : {}) };
}

/**
 * The credential *this package's own* discovery request sends — pi has no API that answers "which
 * credential would you use for this provider?" — in pi's own order: a credential pi has stored
 * for it, the one pi is offering this session, the account's, then the provider layer of pi's
 * global `models.json`. The *shape* travels with it:
 * `authHeader` decides whether the key also goes out as `Authorization: Bearer`, so `live.ts`
 * builds the probe's headers from this one answer instead of deciding the shape itself.
 */
export function discoveryCredential(entry: CredentialSource, layer: JsonObject, contextKey?: string): { key?: string; authHeader: boolean } {
	const key =
		storedKey(entry.id) ??
		contextKey ??
		resolveConfigValue(entry.account?.apiKey) ??
		resolveConfigValue(stringOr(layer.apiKey));
	return { ...(key ? { key } : {}), authHeader: accountAuthHeader(entry) ?? false };
}

/** The account id `init` writes, and the `default` pointer to it. */
export const BASE_ACCOUNT_ID = "main";

/**
 * True when the stored text is a literal secret rather than a reference pi resolves at request
 * time (`$VAR` / `!cmd` / a bare environment-variable name). `init` warns about these — the file
 * is the one place a secret would sit in plain text — but never refuses one.
 */
export function isLiteralCredential(value: string): boolean {
	return !value.startsWith("$") && !value.startsWith("!") && !/^[A-Z][A-Z0-9_]*$/.test(value);
}

/**
 * Write `init`'s single-account `accounts.json`. The text is stored **verbatim**: it is a reference
 * or a literal key, and resolving it here would persist a secret pi would then own. An existing
 * file is never touched — it may hold several accounts, and a wizard must not silently reduce the
 * user to one. Returns the line the command reports.
 */
export function writeAccountsFile(dir: string, apiKey: string, id: string): string {
	const file = path.join(dir, "accounts.json");
	if (existsSync(file)) return `${id}: accounts.json exists (left alone)`;
	try {
		writeTextAtomic(file, serializeJson({ default: BASE_ACCOUNT_ID, [BASE_ACCOUNT_ID]: { apiKey } }));
		return `${id}: wrote accounts.json`;
	} catch (error) {
		return `${id}: ${String(error)}`;
	}
}
