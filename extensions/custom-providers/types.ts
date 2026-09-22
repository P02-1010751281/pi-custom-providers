/**
 * Shared domain types.
 *
 * Hand-written on purpose: `catalog.ts` is generated and holds data only, so the
 * schema lives here and the generator emits no declarations at all.
 *
 * The vocabulary is pi's own wherever pi has one (`api`, `baseUrl`, `headers`,
 * `compat`, `models[]`). Four things are ours because pi has no word for them:
 * `apis` (a second protocol endpoint), `modelsPath` (discovery path), `override`
 * (taking over a built-in provider id) and `accounts.json`.
 */
import type { JsonObject, ProviderDeclaration } from "./config.ts";

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
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	thinkingLevelMap?: Partial<Record<CatalogThinkingLevel, string | null>>;
	/** Per-model endpoint override (a `models.json` entry, or the loader's own stamp). */
	baseUrl?: string;
	/** A whole vendor's models can share compat, but only per model entry (pi's rule). */
	compat?: ModelCompat;
	headers?: JsonObject;
}

/** One vendor: a directory under `custom-providers/` (the shipped `sources.ts` defaults only seed one). */
export type VendorId = string;

/** One credential set. It only ever carries authentication — never endpoints or models. */
export interface Account {
	id: string;
	/** Suffix in the display name; the account registered as the base id has none. */
	name?: string;
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
	/** Other `models.json` provider keys this vendor answers to (its own id first). */
	aliases: readonly string[];
	declaration: ProviderDeclaration;
	/** The base model table: from `<id>/models.json`, or the shipped default for this id. */
	models: readonly CatalogModel[];
	origin: VendorOrigin;
	/** The shipped default account (`envVar` + `authHeader`) for this vendor id, used when the directory declares no accounts. */
	defaultAccount?: Account & { envVar: string };
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
	supported_endpoints?: string[];
}

export type { JsonObject, ProviderDeclaration };
