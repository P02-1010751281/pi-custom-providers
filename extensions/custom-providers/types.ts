/**
 * Shared domain types.
 *
 * Hand-written on purpose: this is the only place the model/vendor schema is declared —
 * the extension ships no generated data file.
 *
 * The vocabulary is pi's own wherever pi has one (`api`, `baseUrl`, `headers`,
 * `compat`, `models[]`). Four things are ours because pi has no word for them:
 * `apis` (a second protocol endpoint), `modelsPath` (discovery path), `override`
 * (taking over a built-in provider id) and `accounts.json`.
 */
import type { JsonObject } from "./util.ts";

export type CatalogThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** pi's per-model compatibility flags. Keys are validated by pi, not by this package. */
export type ModelCompat = Record<string, unknown>;

export interface CatalogModel {
	id: string;
	name: string;
	/**
	 * The protocol this model speaks when it is *not* the provider's effective default
	 * one; the loader decides whether such an entry needs its own `baseUrl` too (§5.2).
	 * Absent = the default protocol, which keeps `providers.<id>.baseUrl` able to
	 * redirect the default endpoint.
	 */
	api?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	/** pi's per-model input limits: request size, and the image resize/count profile. */
	inputLimits?: JsonObject;
	contextWindow: number;
	maxTokens: number;
	/** Default sampling parameters for this model; per-request keys override them. */
	samplingParams?: JsonObject;
	/**
	 * pi's cost record: the four rates are normalized (defaulted to 0 — `calculateCost`
	 * dereferences `cost` on every request), while anything else pi knows (`tiers`) or gains
	 * later travels with it instead of being dropped by a `sync --write`.
	 */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number } & JsonObject;
	/** pi's prompt-cache hints for this model (how long an entry is expected to live). */
	promptCache?: JsonObject;
	thinkingLevelMap?: Partial<Record<CatalogThinkingLevel, string | null>>;
	/** Per-model endpoint override (a `models.json` entry, or the loader's own stamp). */
	baseUrl?: string;
	/** A whole vendor's models can share compat, but only per model entry (pi's rule). */
	compat?: ModelCompat;
	headers?: JsonObject;
}

/** One vendor: a directory under `custom-providers/`. The directory name is its provider id. */
export type VendorId = string;

/** One credential set. It only ever carries authentication — never endpoints or models. */
export interface Account {
	id: string;
	/** pi value syntax (`$VAR` / `${VAR}` / `!command` / `$$` / `$!` / literal). */
	apiKey?: string;
	authHeader?: boolean;
	headers?: JsonObject;
}

/** A validation finding, reported through `ctx.ui.notify` and the `files` command. */
export interface LoadIssue {
	level: "error" | "warning";
	message: string;
}

export type VendorOrigin = "directory";

/** A loadable vendor: one provider id, one endpoint table, N accounts. */
export interface Vendor {
	id: VendorId;
	name: string;
	declaration: ProviderDeclaration;
	/** The base model table: `<id>/models.json`, empty until that file or discovery fills it. */
	models: readonly CatalogModel[];
	origin: VendorOrigin;
	/** Resolved accounts. The one that registers as `<id>` is `baseAccount`, if any. */
	accounts: readonly Account[];
	/**
	 * The account that registers as `<id>`. Absent means the vendor still registers the
	 * base id but without credentials (design §3.3 ②: `/login` / `--api-key` can still
	 * rescue it) — or, for a directory vendor with accounts but no usable `default`
	 * pointer, that the base id is not registered at all (`baseSuppressed`).
	 */
	baseAccount?: Account;
	/** True when the base id must not be registered (directory vendor, accounts, no `default`). */
	baseSuppressed?: boolean;
	/** `provider.json` set `"override": true`: allowed to take over a built-in pi provider id. */
	override?: boolean;
	directory?: string;
	issues: readonly LoadIssue[];
}

/** The subset of a `GET /models` row this package understands. */
export interface LiveModelRow {
	id: string;
	name?: string;
	context_length?: number;
	contextWindow?: number;
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
