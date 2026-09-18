/**
 * The `models.json` layer (read-only): pi's user-config override surface.
 *
 * Only two things are read from it — provider-level settings and a `models[]` array —
 * and both are re-applied here because pi's own merge cannot reach models that an
 * extension registers: `applyExtension()` rebuilds every declared model from the
 * extension definition alone, so a `models.json` compat block or model entry for one
 * of these providers is dropped before it is composed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Source } from "./types.ts";

export type JsonObject = Record<string, any>;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Keys a source may inherit from its sibling wire. Credentials are vendor-wide (SCNet's
 * two wires share one key). Everything else is wire-specific and must NOT be inherited:
 * `models` would register OpenAI-only ids on the Anthropic wire, `baseUrl`/`api` would
 * point requests at the wrong endpoint, and `compat` flags describe one wire's request
 * shape — they belong under that wire's own `models.json` entry.
 */
const INHERITED_KEYS = ["apiKey", "authHeader"] as const;

/**
 * Wire names accepted in `models.json`: the short protocol name and pi's own `api` id.
 * Anything else is passed through unchanged so a typo is reported rather than ignored.
 */
export function normalizeWire(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const wire = value.trim().toLowerCase();
	if (wire === "openai" || wire === "openai-completions" || wire === "chat") return "openai";
	if (wire === "anthropic" || wire === "anthropic-messages" || wire === "messages") return "anthropic";
	return wire.length > 0 ? wire : undefined;
}

/** Wire preference for one provider: a default, plus per-model entries that win over it. */
export type WireSelection = { default?: string; models: Record<string, string> };

/**
 * Read the wire selection of one provider entry. Two accepted shapes:
 *
 *     "wire": "anthropic"                                            // whole provider
 *     "wire": { "default": "anthropic", "models": { "MiniMax-M2.5": "openai" } }
 *
 * `wire` is this package's own provider key, not pi's: pi validates `models.json`
 * type-strictly but tolerates unknown provider keys (measured), so nothing has to change on
 * pi's side for this to be read.
 */
export function wireSelectionFor(providerConfig: JsonObject): WireSelection {
	const raw = providerConfig.wire;
	if (typeof raw === "string") {
		const fallback = normalizeWire(raw);
		return { ...(fallback ? { default: fallback } : {}), models: {} };
	}
	if (!isObject(raw)) return { models: {} };
	const models: Record<string, string> = {};
	if (isObject(raw.models)) {
		for (const [id, value] of Object.entries(raw.models)) {
			const wire = normalizeWire(value);
			if (wire) models[id] = wire;
		}
	}
	const fallback = normalizeWire(raw.default);
	return { ...(fallback ? { default: fallback } : {}), models };
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

/** Provider settings for a source: its own `models.json` entry over its sibling's. */
export function sourceConfigFor(source: Source, config: JsonObject): JsonObject {
	const providers = isObject(config.providers) ? config.providers : {};
	const explicit = source.aliases.map((alias) => providers[alias]).find(isObject) ?? {};
	const sibling = source.siblingId && isObject(providers[source.siblingId]) ? (providers[source.siblingId] as JsonObject) : {};
	const inherited = Object.fromEntries(INHERITED_KEYS.filter((key) => sibling[key] !== undefined).map((key) => [key, sibling[key]]));
	return { ...inherited, ...explicit };
}
