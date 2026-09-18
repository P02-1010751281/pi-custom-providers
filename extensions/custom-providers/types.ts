/**
 * Shared domain types.
 *
 * Hand-written on purpose: `catalog.ts` is generated and holds data only, so the
 * schema lives here and the generator emits no declarations at all.
 */

export type CatalogThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** pi's per-model compatibility flags. Keys are validated by pi, not by this package. */
export type ModelCompat = Record<string, unknown>;

export interface CatalogModel {
	id: string;
	name: string;
	api?: "openai-completions" | "anthropic-messages";
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	thinkingLevelMap?: Partial<Record<CatalogThinkingLevel, string | null>>;
	/**
	 * Per-model base URL override. Set by `models.json` `models[]` entries, or derived
	 * from `Source.anthropicBaseUrl` for models on the Anthropic wire (whose client
	 * appends `/v1/messages` itself, see `Source.anthropicBaseUrl`).
	 */
	baseUrl?: string;
	/**
	 * Merged from, lowest priority first: the whitelist absorbed from pi's built-in
	 * catalog, `Source.compat`, a `models.json` model entry, then the `models.json`
	 * provider-level `compat`. pi only honors per-model compat here — a provider-level
	 * `compat` passed to `registerProvider` is dropped by `applyExtension()`.
	 */
	compat?: ModelCompat;
}

export type SourceId = "codecommand" | "scnet" | "scnet-anthropic";

/**
 * A pi provider id. Deliberately not the same namespace as `SourceId`: one provider id may
 * be served by several wires when they serve the same model ids (`Source.providerId`).
 */
export type ProviderId = string;

/** One reseller endpoint on one wire. It registers under `providerId ?? id`. */
export interface Source {
	id: SourceId;
	/**
	 * pi provider id to register under; defaults to `id`. Set when two wires of one vendor
	 * serve the same model ids (SCNet): one provider id can hold a given model id only once,
	 * so the wires are merged into one provider and the user picks the wire per model via
	 * `models.json` (`providers.<id>.wire`). Leaving it unset keeps the wire a provider of
	 * its own — the only shape that can switch protocol per request.
	 */
	providerId?: ProviderId;
	name: string;
	/** `models.json` provider keys that configure this source, its own id first. */
	aliases: readonly string[];
	baseUrl: string;
	api: "openai-completions" | "anthropic-messages";
	/**
	 * Base URL for this source's models that speak the Anthropic wire, when it differs
	 * from `baseUrl`. pi hands `model.baseUrl` straight to the Anthropic SDK, which
	 * appends `/v1/messages` itself — so a gateway whose OpenAI base already ends in
	 * `/v1` needs the shorter root here, or every Anthropic request doubles it
	 * (measured: `POST /provider/v1/v1/messages` -> 404 "not a registered API route").
	 */
	anthropicBaseUrl?: string;
	/** Appended to baseUrl when listing models; defaults to "/models". */
	modelsPath?: string;
	envVar: string;
	authHeader: boolean;
	/**
	 * Set when this wire belongs to the same vendor as another one: only credentials
	 * (`apiKey` / `authHeader`) are inherited from that wire's `models.json` entry. The model
	 * list, endpoint, wire and `compat` are not — an OpenAI-shaped compat key on the Anthropic
	 * wire breaks it (see `INHERITED_KEYS` in `config.ts`).
	 */
	siblingId?: SourceId;
	/** Wire-wide compat merged onto every model of this source (see `CatalogModel.compat`). */
	compat?: ModelCompat;
}

/** The subset of a `GET /models` row this package understands. */
export interface LiveModelRow {
	id: string;
	name?: string;
	context_length?: number;
	contextWindow?: number;
	supported_endpoints?: string[];
}
