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
import { existsSync } from "node:fs";
import path from "node:path";
import { BUILTIN_APIS, normalizeApi } from "./apis.ts";
import { CREDENTIAL_KEYS } from "./credentials.ts";
import type { Endpoint, EndpointChoice, LoadIssue, ProviderDeclaration } from "./types.ts";
import { isObject, readJson, serializeJson, stringOr, writeTextAtomic } from "./util.ts";

/** `provider.json` keys this package reads. Everything else is reported, never guessed at. */
const PROVIDER_KEYS = new Set(["name", "api", "baseUrl", "modelsPath", "headers", "apis", "override"]);

/** JSON cannot express these, so they are reported instead of being dropped in silence. */
const UNSUPPORTED_KEYS = new Set(["oauth", "streamSimple", "refreshModels"]);

/**
 * `provider.json`: the endpoint table — no secrets, no compat, no functions. `label` is how the
 * file is named in messages; the path is still what gets read.
 */
export function readProviderFile(file: string, issues: LoadIssue[], label = file): { declaration: ProviderDeclaration; name?: string; override: boolean } | undefined {
	const { value, issue } = readJson(file, label);
	if (issue) {
		issues.push({ level: "error", message: issue });
		return undefined;
	}
	if (!isObject(value)) {
		issues.push({ level: "error", message: `${label}: root must be a JSON object` });
		return undefined;
	}
	for (const key of Object.keys(value)) {
		if (PROVIDER_KEYS.has(key)) continue;
		if (CREDENTIAL_KEYS.has(key)) issues.push({ level: "warning", message: `${label}: "${key}" belongs in accounts.json` });
		else if (key === "compat") issues.push({ level: "warning", message: `${label}: "compat" belongs on model entries in models.json` });
		else if (UNSUPPORTED_KEYS.has(key)) issues.push({ level: "warning", message: `${label}: "${key}" is not supported in provider files` });
		else issues.push({ level: "warning", message: `${label}: unknown key "${key}"` });
	}

	const api = normalizeApi(value.api);
	if (!api) {
		issues.push({ level: "error", message: `${label}: unsupported api ${JSON.stringify(value.api)} (pi has ${BUILTIN_APIS.join(", ")})` });
		return undefined;
	}
	const baseUrl = stringOr(value.baseUrl);
	if (!baseUrl) {
		issues.push({ level: "error", message: `${label}: "baseUrl" is required` });
		return undefined;
	}
	if (value.modelsPath !== undefined && !stringOr(value.modelsPath)) issues.push({ level: "warning", message: `${label}: "modelsPath" has the wrong type` });
	if (value.headers !== undefined && !isObject(value.headers)) issues.push({ level: "warning", message: `${label}: "headers" has the wrong type` });
	if (value.override !== undefined && typeof value.override !== "boolean") issues.push({ level: "warning", message: `${label}: "override" has the wrong type` });

	const apis: ProviderDeclaration["apis"] = {};
	if (value.apis !== undefined && !isObject(value.apis)) {
		issues.push({ level: "warning", message: `${label}: "apis" has the wrong type` });
	} else if (isObject(value.apis)) {
		for (const [rawApi, entry] of Object.entries(value.apis)) {
			const extraApi = normalizeApi(rawApi);
			if (!extraApi) {
				issues.push({ level: "warning", message: `${label}: apis.${rawApi}: unsupported api` });
				continue;
			}
			if (extraApi === api) {
				issues.push({ level: "warning", message: `${label}: apis.${extraApi}: already the default endpoint` });
				continue;
			}
			if (apis[extraApi]) {
				// Two spellings of the same protocol (`anthropic` and `anthropic-messages`): the
				// first one wins instead of the file's key order deciding the endpoint.
				issues.push({ level: "warning", message: `${label}: apis.${extraApi}: already declared` });
				continue;
			}
			if (!isObject(entry)) {
				issues.push({ level: "warning", message: `${label}: apis.${extraApi}: must be an object` });
				continue;
			}
			for (const key of Object.keys(entry)) {
				if (key === "baseUrl" || key === "modelsPath" || key === "headers") continue;
				if (CREDENTIAL_KEYS.has(key)) issues.push({ level: "warning", message: `${label}: apis.${extraApi}.${key} belongs in accounts.json` });
				else if (key === "compat") issues.push({ level: "warning", message: `${label}: apis.${extraApi}: "compat" belongs on model entries in models.json` });
				else issues.push({ level: "warning", message: `${label}: apis.${extraApi}: unknown key "${key}"` });
			}
			const extraBaseUrl = stringOr(entry.baseUrl);
			if (!extraBaseUrl) {
				issues.push({ level: "warning", message: `${label}: apis.${extraApi}: "baseUrl" is required` });
				continue;
			}
			const modelsPath = stringOr(entry.modelsPath);
			if (entry.modelsPath !== undefined && !modelsPath) issues.push({ level: "warning", message: `${label}: apis.${extraApi}: "modelsPath" has the wrong type` });
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
		writeTextAtomic(file, serializeJson({ name: vendor.name, ...vendor.declaration }));
		return `${vendor.id}: wrote provider.json`;
	} catch (error) {
		return `${vendor.id}: ${String(error)}`;
	}
}

/**
 * Decide a model's endpoint (design §5.1/§5.2). Two steps, no preference chain:
 *
 *   1. the model's own `api` when it names a pi protocol, else the effective default;
 *   2. that protocol's declared endpoint — `apis.<api>` for a non-default protocol.
 *
 * A model on the default protocol gets neither `api` nor `baseUrl` stamped (unless it
 * carries its own `baseUrl`), which keeps `providers.<id>.baseUrl` able to redirect the
 * default endpoint. A model on another protocol gets both, or pi would speak the default
 * protocol to the right host. When no endpoint can be resolved for a declared protocol
 * the model falls back to the default one and the caller reports it.
 */
export function resolveModelEndpoint(
	decl: ProviderDeclaration,
	layer: JsonObject,
	model: { id: string; api?: unknown; baseUrl?: unknown },
): EndpointChoice & { issues: string[] } {
	const issues: string[] = [];
	if (layer.api !== undefined && normalizeApi(layer.api) === undefined) {
		issues.push(`providers api ${JSON.stringify(layer.api)} is not a pi api; using "${decl.api}"`);
	}
	const defaultApi = normalizeApi(layer.api) ?? decl.api;
	const layerBaseUrl = typeof layer.baseUrl === "string" && layer.baseUrl.length > 0 ? layer.baseUrl : undefined;
	const declared = (api: string): Endpoint | undefined => {
		if (api === decl.api) return { api, baseUrl: decl.baseUrl, ...(decl.modelsPath ? { modelsPath: decl.modelsPath } : {}), ...(decl.headers ? { headers: decl.headers } : {}) };
		const extra = decl.apis[api];
		return extra ? { api, ...extra } : undefined;
	};

	// The default endpoint: the declared one, unless the user's layer moved the default
	// protocol (a flipped default keeps its own `apis.<api>` endpoint) or redirected it.
	let defaultEndpoint = declared(defaultApi);
	if (!defaultEndpoint && layerBaseUrl) {
		// A layer `baseUrl` *is* the endpoint for the flipped protocol (§4): keep the declared
		// discovery path/headers, and do not warn about a missing `apis.<api>`.
		defaultEndpoint = {
			api: defaultApi,
			baseUrl: layerBaseUrl,
			...(decl.modelsPath ? { modelsPath: decl.modelsPath } : {}),
			...(decl.headers ? { headers: decl.headers } : {}),
		};
	}
	if (!defaultEndpoint) {
		const moved = declared(decl.api);
		issues.push(`no endpoint for the default api "${defaultApi}"; using "${decl.api}"`);
		defaultEndpoint = { ...(moved ?? { api: decl.api, baseUrl: decl.baseUrl }), api: decl.api };
	}
	const defaultBaseUrl = layerBaseUrl ?? defaultEndpoint.baseUrl;

	const requestedApi = normalizeApi(model.api);
	if (requestedApi === undefined && model.api !== undefined) {
		issues.push(`${model.id}: api ${JSON.stringify(model.api)} is not a pi api; using "${defaultApi}"`);
	}
	const api = requestedApi ?? defaultApi;
	const own = typeof model.baseUrl === "string" && model.baseUrl.length > 0 ? model.baseUrl : undefined;

	if (api === defaultApi) {
		return {
			endpoint: { api: defaultApi, baseUrl: own ?? defaultBaseUrl, ...(defaultEndpoint.modelsPath ? { modelsPath: defaultEndpoint.modelsPath } : {}), ...(defaultEndpoint.headers ? { headers: defaultEndpoint.headers } : {}) },
			stampApi: false,
			stampBaseUrl: own !== undefined,
			issues,
		};
	}

	const endpoint = declared(api);
	const baseUrl = own ?? endpoint?.baseUrl ?? layerBaseUrl;
	if (!baseUrl) {
		issues.push(`${model.id}: no endpoint for api "${api}" (declare it under "apis" or set "baseUrl"); using "${defaultApi}"`);
		return { endpoint: { api: defaultApi, baseUrl: defaultBaseUrl }, stampApi: false, stampBaseUrl: false, issues };
	}
	return {
		endpoint: { api, baseUrl, ...(endpoint?.modelsPath ? { modelsPath: endpoint.modelsPath } : {}), ...(endpoint?.headers ? { headers: endpoint.headers } : {}) },
		stampApi: true,
		stampBaseUrl: true,
		issues,
	};
}
