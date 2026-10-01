/**
 * `<id>/provider.json` — the endpoint table: api, baseUrl, modelsPath, headers, apis, override.
 *
 * A directory without a parseable `provider.json` is not a vendor at all, which is why this
 * file also owns the one writer outside `sync` (`init`, design §10/§13).
 *
 * The reader reports, never guesses: an unknown key is a warning, and a credential key here is
 * a misplacement that names `accounts.json` — the two files are deliberately disjoint, and only
 * the message needs the other file's key vocabulary.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CREDENTIAL_KEYS } from "./accounts-json.ts";
import { BUILTIN_APIS, normalizeApi, type ProviderDeclaration } from "./config.ts";
import type { LoadIssue } from "./types.ts";
import { isObject, readJson, stringOr } from "./util.ts";

/** `provider.json` keys this package reads. Everything else is reported, never guessed at. */
const PROVIDER_KEYS = new Set(["name", "api", "baseUrl", "modelsPath", "headers", "apis", "override"]);

/** JSON cannot express these, so they are reported instead of being dropped in silence. */
const UNSUPPORTED_KEYS = new Set(["oauth", "streamSimple", "refreshModels"]);

/** `provider.json`: the endpoint table — no secrets, no compat, no functions. */
export function readProviderFile(file: string, issues: LoadIssue[]): { declaration: ProviderDeclaration; name?: string; override: boolean } | undefined {
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

/**
 * Write a vendor's `provider.json` from the shipped declaration — `custom-providers init`.
 * This is the one write outside `sync`, and it is deliberately narrow: the file is the
 * shipped endpoints plus the display name, and an existing file is left alone unless
 * `--force`. Returns the line the command reports (tests assert on it).
 */
export function writeProviderFile(dir: string, vendor: { id: string; name: string; declaration: ProviderDeclaration }, force: boolean): string {
	const file = path.join(dir, "provider.json");
	if (existsSync(file) && !force) return `${vendor.id}: provider.json exists (pass --force to overwrite)`;
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(file, `${JSON.stringify({ name: vendor.name, ...vendor.declaration }, null, "\t")}\n`);
		return `${vendor.id}: wrote provider.json`;
	} catch (error) {
		return `${vendor.id}: ${String(error)}`;
	}
}
