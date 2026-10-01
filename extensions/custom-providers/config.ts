/**
 * pi's global `~/.pi/agent/models.json` — one layer, read-only: the `providers.<id>` entry
 * and its `models[]` patches, re-applied by this package because pi's own merge cannot reach
 * models an extension registers (`applyExtension()` rebuilds every declared model from the
 * extension definition alone, so a `models.json` compat block or model entry for one of these
 * providers is dropped before it is composed).
 *
 * It stays read-only: the package's only writers are `init` (`provider.json`) and
 * `sync --write` (`<id>/models.json`).
 */
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isObject, readJson, type JsonObject } from "./util.ts";

/**
 * Read `models.json`. A missing file is the normal state (all settings then come from
 * the environment), so it reports no issue; malformed JSON and a non-object root do,
 * because both would silently discard every override. It goes through the same reader the
 * payload files use — "read a JSON file" is one problem, with one set of answers
 * (absent / unreadable / unparseable).
 */
export function readModelsConfig(): { config: JsonObject; issue?: string } {
	const { value, issue } = readJson(path.join(getAgentDir(), "models.json"), "models.json");
	if (issue) return { config: {}, issue };
	if (value === undefined) return { config: {} };
	if (!isObject(value)) return { config: {}, issue: "models.json must be a JSON object" };
	return { config: value };
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
