/**
 * Two layers of user configuration, both read-only:
 *
 *   1. The api vocabulary — pi's built-in protocol ids and our aliases for them. The
 *      endpoint a model lands on is decided here (§5.1/§5.2): the model's own `api`
 *      wins, otherwise the *effective default* api = `providers.<id>.api` ??
 *      `provider.json.api`, exactly like pi's own `model.api ?? provider.api`.
 *   2. pi's global `models.json` — provider-level settings and a `models[]` array, both
 *      re-applied here because pi's merge cannot reach models that an extension
 *      registers: `applyExtension()` rebuilds every declared model from the extension
 *      definition alone, so a `models.json` compat block or model entry for one of these
 *      providers is dropped before it is composed.
 *
 * `models.json` stays read-only: this package writes user files only through
 * `custom-providers sync --write` (`sync-models.ts`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type JsonObject = Record<string, any>;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * pi's built-in protocol ids — `BUILTIN_APIS` in `pi-ai/dist/compat.js:108`, which is a
 * private const pair-list, so the ids are repeated here. `tests/apis-test.mjs` asserts
 * this list against the registry pi actually populates (`getApiProviders()`), so a pi
 * build that adds or drops one fails a test instead of silently rejecting a protocol.
 * Registering or requesting any of them is pi's own job; nothing here implements one.
 */
export const BUILTIN_APIS = [
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"bedrock-converse-stream",
	"pi-messages",
] as const;

/**
 * Accepted spellings, lowercased: three short names plus pi's ids themselves (a
 * differently-cased pi id is a typo, not a different protocol). Anything else is
 * reported and skipped rather than passed through — pi would only fail later, at
 * registration, with a message that does not name the file it came from.
 */
const API_ALIASES: Record<string, string> = {
	openai: "openai-completions",
	chat: "openai-completions",
	anthropic: "anthropic-messages",
	messages: "anthropic-messages",
	responses: "openai-responses",
};

/** Resolve one `api` value to a pi protocol id, or undefined when pi has no such protocol. */
export function normalizeApi(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const api = value.trim().toLowerCase();
	if (api.length === 0) return undefined;
	const resolved = API_ALIASES[api] ?? api;
	return (BUILTIN_APIS as readonly string[]).includes(resolved) ? resolved : undefined;
}

/** One endpoint of one vendor: a protocol plus where it lives. */
export interface Endpoint {
	api: string;
	baseUrl: string;
	/** Path appended to `baseUrl` when listing models; absent = no discovery for this endpoint. */
	modelsPath?: string;
	headers?: JsonObject;
}

/**
 * The endpoint table of one vendor, in pi's own vocabulary: `api` + `baseUrl` is the
 * default endpoint, `apis` holds every additional protocol endpoint (key = pi api id).
 */
export interface ProviderDeclaration {
	api: string;
	baseUrl: string;
	modelsPath?: string;
	headers?: JsonObject;
	apis: Record<string, Omit<Endpoint, "api">>;
}

/** The endpoint table a model lands on, plus what must be stamped on its entry. */
export interface EndpointChoice {
	endpoint: Endpoint;
	/** Stamp `api` on the model entry: it is not on the effective default protocol. */
	stampApi: boolean;
	/** Stamp `baseUrl`: the model has its own, or its protocol is not the default one. */
	stampBaseUrl: boolean;
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

/**
 * Read `models.json`. A missing file is the normal state (all settings then come from
 * the environment), so it reports no issue; malformed JSON and a non-object root do,
 * because both would silently discard every override.
 */
export function readModelsConfig(): { config: JsonObject; issue?: string } {
	let raw: string;
	try {
		raw = readFileSync(path.join(getAgentDir(), "models.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { config: {} };
		return { config: {}, issue: `cannot read models.json: ${String(error)}` };
	}
	try {
		const parsed = JSON.parse(raw);
		if (!isObject(parsed)) return { config: {}, issue: "models.json must be a JSON object" };
		return { config: parsed };
	} catch (error) {
		return { config: {}, issue: `cannot parse models.json: ${String(error)}` };
	}
}

/**
 * The user's `providers.<id>` entry. `aliases` are the other keys the same vendor answers
 * to (a renamed provider id keeps reading the old key), in priority order after its own id.
 */
export function providerLayerFor(id: string, aliases: readonly string[], config: JsonObject): JsonObject {
	const providers = isObject(config.providers) ? config.providers : {};
	return [id, ...aliases].map((key) => providers[key]).find(isObject) ?? {};
}

/**
 * Apply one `models.json` entry onto a base model. Every field is a patch: what the entry
 * writes wins, what it omits keeps the base value (pi's own `modelOverrides` semantics).
 * `apiKey` / `authHeader` / `models` are provider-level fields, not model fields.
 */
export function applyModelPatch(base: JsonObject, row: JsonObject): JsonObject {
	const patch: JsonObject = {};
	for (const [key, value] of Object.entries(row)) {
		if (key === "id" || key === "provider" || value === undefined || value === null) continue;
		patch[key] = value;
	}
	return { ...base, ...patch };
}
