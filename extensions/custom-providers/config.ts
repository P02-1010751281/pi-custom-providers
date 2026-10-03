/**
 * pi's global `~/.pi/agent/models.json` — one layer, read-only: the `providers.<id>` entry
 * and its `models[]` patches, re-applied by this package because pi's own merge cannot reach
 * models an extension registers (`applyExtension()` rebuilds every declared model from the
 * extension definition alone, so a `models.json` compat block or model entry for one of these
 * providers is dropped before it is composed).
 *
 * It stays read-only: the package's three writers are `init` (`provider.json`, `accounts.json`)
 * and `sync` (`<id>/models.json`).
 */
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { LoadIssue } from "./types.ts";
import { isObject, readJson, stringOr, type JsonObject } from "./util.ts";

/**
 * The shape pi's `ModelsConfigSchema` accepts, for the keys this package reads. pi validates the
 * whole file and drops **all** of it on any type error, so reading a file pi ignored would make
 * the two sides disagree about the same bytes (the drift class this package exists to avoid):
 * a failure here is treated as the file-wide issue pi reports, and nothing is read from it.
 */
export function validateModelsConfig(value: JsonObject): string[] {
	const providers = value.providers;
	if (!isObject(providers)) return ['"providers" must be an object'];
	const issues: string[] = [];
	for (const [id, block] of Object.entries(providers)) {
		if (!isObject(block)) {
			issues.push(`providers.${id} must be an object`);
			continue;
		}
		for (const key of ["name", "baseUrl", "apiKey", "api"]) {
			const field = block[key];
			if (field !== undefined && (typeof field !== "string" || field.length === 0)) issues.push(`providers.${id}.${key} must be a non-empty string`);
		}
		if (block.oauth !== undefined && block.oauth !== "radius") issues.push(`providers.${id}.oauth must be the literal "radius"`);
		if (block.authHeader !== undefined && typeof block.authHeader !== "boolean") issues.push(`providers.${id}.authHeader must be a boolean`);
		for (const key of ["headers", "compat"]) if (block[key] !== undefined && !isObject(block[key])) issues.push(`providers.${id}.${key} must be an object`);
		if (block.modelOverrides !== undefined && !isObject(block.modelOverrides)) issues.push(`providers.${id}.modelOverrides must be an object`);
		if (block.models !== undefined && !Array.isArray(block.models)) {
			issues.push(`providers.${id}.models must be an array`);
			continue;
		}
		for (const [index, row] of (Array.isArray(block.models) ? block.models : []).entries()) {
			if (!isObject(row)) issues.push(`providers.${id}.models[${index}] must be an object`);
			else if (!stringOr(row.id)) issues.push(`providers.${id}.models[${index}].id is required`);
		}
	}
	return issues;
}

/**
 * The `models.json` shapes pi rejects at **registration** time (measured in
 * `provider-composer.js`: `applyModelsJson` for the empty block, `modelFromJson` for the missing
 * api). Reported before `pi.registerProvider` is called, so one bad block is a message instead of
 * an exception that takes out every provider registered after it.
 */
export function preflightLayer(id: string, layer: JsonObject, options: { configured: boolean; builtin: boolean }): LoadIssue[] {
	if (!options.configured) return [];
	const issues: LoadIssue[] = [];
	if (layer.oauth !== undefined && !stringOr(layer.baseUrl)) issues.push({ level: "error", message: `providers.${id}: pi throws when "oauth" is set without "baseUrl"` });
	if (stringOr(layer.oauth)) {
		issues.push({
			level: "warning",
			message: `providers.${id}: "oauth" installs no OAuth method here (only an extension or base oauth is read) and is not this package's word; its only legal value is the literal "radius"`,
		});
	}
	const models = Array.isArray(layer.models) ? layer.models : [];
	const overrides = isObject(layer.modelOverrides) && Object.keys(layer.modelOverrides).length > 0;
	const specifies = models.length > 0 || Boolean(stringOr(layer.baseUrl)) || isObject(layer.headers) || isObject(layer.compat) || overrides || Boolean(stringOr(layer.apiKey)) || layer.oauth !== undefined || layer.authHeader !== undefined;
	if (!specifies) {
		issues.push({
			level: "error",
			message: `providers.${id}: pi rejects this block ('must specify "baseUrl", "headers", "compat", "modelOverrides", or "models"') — "api" on its own is not enough`,
		});
	}
	// pi validates a `models[]` entry against the **built-in** models of that id. One of our own
	// providers has no built-in base, so pi reads the entry as a brand-new custom model that must
	// define `api` and `baseUrl` itself (measured: 'no "api" specified. Set at provider or model
	// level.' and '"baseUrl" is required when defining custom models'). To patch a model of ours,
	// `modelOverrides` is the key pi actually applies last.
	if (!options.builtin) {
		for (const [index, row] of models.entries()) {
			if (!isObject(row)) continue;
			const where = `providers.${id}.models[${index}]`;
			if (!stringOr(row.api) && !stringOr(layer.api)) issues.push({ level: "error", message: `${where}: pi needs an "api" for a new custom model (no built-in model to inherit from)` });
			if (!stringOr(row.baseUrl) && !stringOr(layer.baseUrl)) issues.push({ level: "error", message: `${where}: pi needs a "baseUrl" for a new custom model` });
		}
	}
	return issues;
}

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
	// pi drops the whole file on a schema error; read nothing from a file it would ignore.
	const problems = validateModelsConfig(value);
	if (problems.length > 0) return { config: {}, issue: `pi discards the whole models.json on a schema error (${problems.join("; ")})` };
	return { config: value };
}

/**
 * The user's `providers.<id>` entry — and only that key. pi resolves a provider's config by the
 * **registered id** (`providers[id]` in `models.json`), so a block written under one of the
 * vendor's old spellings is not that provider's config over there: pi registers it as a separate
 * config-only provider of its own. Reading it here as this provider's layer would therefore apply
 * config pi never applies — the two sides would disagree about the same file. Alias keys are a
 * rename to be reported (see the migration notes), not a second place to look.
 */
export function providerLayerFor(id: string, config: JsonObject): JsonObject {
	return providerBlockFor(id, config) ?? {};
}

/**
 * The raw `providers.<id>` block, or `undefined` when the user declared none. pi tells the two
 * apart — an absent block is fine, an *empty* one is a config it rejects — so this package must
 * not collapse them either.
 */
export function providerBlockFor(id: string, config: JsonObject): JsonObject | undefined {
	const providers = isObject(config.providers) ? config.providers : {};
	const block = providers[id];
	return isObject(block) ? block : undefined;
}

/**
 * `providers.<key>` blocks whose id nothing here answers to. This package registers ids that have
 * a directory (or an account under one) and pi has models for its built-in ids; a key outside both
 * sets is a config-only id — pi registers it itself, this package never reads it — so a block left
 * under a former, aliased or mistyped id looks applied and does nothing: the "configured but
 * ineffective" class #18 was about. Reported, never dropped silently. The two sets are what this
 * package can know; an id another extension registers is beyond them.
 *
 * Without pi's catalog (`available: false` — a build whose pi-ai has no `getProviders`) the second
 * set is unknown, so a built-in id cannot be told from an orphan and nothing is claimed: same rule
 * as `drift` in `index.ts`.
 */
export function orphanProviderBlocks(config: JsonObject, registered: Iterable<string>, builtin: { available: boolean; providers: Iterable<string> }): LoadIssue[] {
	if (!builtin.available) return [];
	const providers = isObject(config.providers) ? config.providers : {};
	const known = new Set([...registered, ...builtin.providers]);
	return Object.keys(providers)
		.filter((id) => !known.has(id))
		.sort()
		.map((id) => ({
			level: "warning" as const,
			message: `providers.${id}: no directory for this id and no pi built-in provider; nothing here reads this block (a former key, or a typo?)`,
		}));
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
