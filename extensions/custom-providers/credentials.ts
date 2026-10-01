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
 * Read-only: this package never writes it. `resolveAccounts` is the id policy that follows from
 * the file (design §3.3 ②/§8) — which account registers as the base id, and the case where the
 * base id is deliberately suppressed because the user declared accounts but named none.
 */
import type { Account, LoadIssue } from "./types.ts";
import { isObject, readJson, stringOr } from "./util.ts";

/** Keys that belong to `accounts.json`; seeing them here is a misplacement, not a style choice. */
export const CREDENTIAL_KEYS = new Set(["apiKey", "envVar", "authHeader"]);

const ACCOUNT_KEYS = new Set(["apiKey", "authHeader", "headers"]);

const ACCOUNT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** `accounts.json`: credentials only — a model or endpoint key here is a misplacement. */
export function readAccountsFile(file: string, issues: LoadIssue[]): { accounts: Account[]; defaultPointer?: string; broken: boolean } {
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
