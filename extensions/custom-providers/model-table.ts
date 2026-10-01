/**
 * `<id>/models.json` — the model base table: pi's `ModelDefinitionSchema` fields, and nothing else.
 *
 * Hand-written, so an unknown key is a warning rather than an error: a typo here is exactly the
 * failure this package exists to prevent. Reader and writer live in one file because they speak
 * one vocabulary — `MODEL_KEYS` for reading, `FIELD_ORDER` for writing; a reader in one file and
 * a writer in another is how one file ends up parsed twice, under two sets of rules.
 *
 * `writeBaseTable` and `init`'s `provider.json` are the package's only two writers (§10/§13).
 * Both go through `util.ts`'s shared codec and atomic write.
 */
import { FALLBACK_CONTEXT_WINDOW, FALLBACK_MAX_TOKENS } from "./config.ts";
import type { CatalogModel, LoadIssue } from "./types.ts";
import { isObject, numberOr, readJson, serializeJson, stringOr, writeTextAtomic, type JsonObject } from "./util.ts";

/** One model entry = pi's `ModelDefinitionSchema` fields, and nothing else — in its own order. */
const MODEL_KEYS = new Set(["id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "inputLimits", "cost", "promptCache", "contextWindow", "maxTokens", "samplingParams", "headers", "compat"]);

/**
 * One model entry, read field by field so a single bad value does not discard an
 * otherwise usable model. Unknown keys are warnings: this file is hand-written, and a
 * typo here is exactly the failure this package exists to prevent.
 */
function readModelEntry(raw: JsonObject, index: number, issues: LoadIssue[]): CatalogModel | undefined {
	const id = stringOr(raw.id);
	if (!id) {
		issues.push({ level: "warning", message: `model #${index} has no "id"` });
		return undefined;
	}
	for (const key of Object.keys(raw)) {
		if (!MODEL_KEYS.has(key)) issues.push({ level: "warning", message: `${id}: unknown key "${key}"` });
	}
	const input = Array.isArray(raw.input) ? raw.input.filter((value): value is "text" | "image" => value === "text" || value === "image") : [];
	const cost = isObject(raw.cost) ? raw.cost : undefined;
	return {
		id,
		name: stringOr(raw.name) ?? id,
		...(stringOr(raw.api) ? { api: raw.api as string } : {}),
		...(stringOr(raw.baseUrl) ? { baseUrl: raw.baseUrl as string } : {}),
		reasoning: raw.reasoning === true,
		input: input.length > 0 ? input : ["text"],
		contextWindow: numberOr(raw.contextWindow) ?? FALLBACK_CONTEXT_WINDOW,
		maxTokens: numberOr(raw.maxTokens) ?? FALLBACK_MAX_TOKENS,
		cost: {
			// The four rates are pi's required ones, normalized here (a bad value becomes 0);
			// everything else in the user's object (`tiers`) rides along untouched.
			...cost,
			input: numberOr(cost?.input) ?? 0,
			output: numberOr(cost?.output) ?? 0,
			cacheRead: numberOr(cost?.cacheRead) ?? 0,
			cacheWrite: numberOr(cost?.cacheWrite) ?? 0,
		},
		...(isObject(raw.thinkingLevelMap) ? { thinkingLevelMap: raw.thinkingLevelMap } : {}),
		...(isObject(raw.inputLimits) ? { inputLimits: raw.inputLimits } : {}),
		...(isObject(raw.promptCache) ? { promptCache: raw.promptCache } : {}),
		...(isObject(raw.samplingParams) ? { samplingParams: raw.samplingParams } : {}),
		...(isObject(raw.headers) ? { headers: raw.headers } : {}),
		...(isObject(raw.compat) ? { compat: raw.compat } : {}),
	};
}

/**
 * `models.json`: either a bare array (accepted shorthand) or the canonical `{models: []}`.
 * `label` is how the file is named in messages; the path is still what gets read.
 */
export function readModelsFile(file: string, issues: LoadIssue[], label = file): { models: CatalogModel[]; broken: boolean } {
	const { value, missing, issue } = readJson(file, label);
	if (missing) return { models: [], broken: false };
	if (issue) {
		issues.push({ level: "error", message: issue });
		return { models: [], broken: true };
	}
	const rows = Array.isArray(value) ? value : isObject(value) && Array.isArray(value.models) ? value.models : undefined;
	if (!rows) {
		issues.push({ level: "error", message: `${label} must be an array or {"models": [...]}` });
		return { models: [], broken: true };
	}
	const models: CatalogModel[] = [];
	rows.forEach((row, index) => {
		if (!isObject(row)) {
			issues.push({ level: "warning", message: `model #${index}: must be an object` });
			return;
		}
		const model = readModelEntry(row, index, issues);
		if (model) models.push(model);
	});
	return { models, broken: false };
}

/*
 * `custom-providers sync <id> [--write] [--prune]` — the only code in this package that
 * writes a user file, and only with `--write`.
 *
 * What it writes is the *base table*: the vendor's model base read above (an existing
 * `<id>/models.json`, or empty) merged with what discovery returned. The user layers
 * (`providers.<id>` and `modelOverrides` in pi's global `models.json`) are deliberately not
 * baked in — a single `sync --write` must not fossilize a user override into the base table.
 *
 * Ids that a complete discovery round no longer returns are kept and reported by default;
 * `--prune` is the explicit call to drop them. Whether a model is gone for good is the user's
 * call, not a truncated or failed response's.
 */

/** Field order of the written file — readable diffs, id first, then pi's own model fields. */
const FIELD_ORDER: (keyof CatalogModel)[] = ["id", "name", "api", "baseUrl", "reasoning", "input", "inputLimits", "contextWindow", "maxTokens", "samplingParams", "cost", "promptCache", "thinkingLevelMap", "headers", "compat"];

export function serializeBaseTable(models: readonly CatalogModel[]): string {
	const rows = models.map((model) => {
		const ordered: Record<string, unknown> = {};
		for (const key of FIELD_ORDER) {
			const value = model[key];
			if (value !== undefined) ordered[key] = value;
		}
		return ordered;
	});
	return serializeJson({ models: rows });
}

export interface BaseTableDiff {
	id: string;
	file: string;
	added: string[];
	removed: string[];
	changed: { id: string; fields: string[] }[];
	/** True when the file on disk differs from what `sync --write` would write. */
	dirty: boolean;
}

/**
 * Compare the merged table with the file on disk. Field-by-field, so a summary says
 * which fields moved instead of dumping two models.
 */
export function diffBaseTable(id: string, file: string, next: readonly CatalogModel[], current: readonly CatalogModel[]): BaseTableDiff {
	const currentById = new Map(current.map((model) => [model.id, model]));
	const nextById = new Map(next.map((model) => [model.id, model]));
	const added = next.filter((model) => !currentById.has(model.id)).map((model) => model.id);
	const removed = current.filter((model) => !nextById.has(model.id)).map((model) => model.id);
	const changed: { id: string; fields: string[] }[] = [];
	for (const model of next) {
		const before = currentById.get(model.id);
		if (!before) continue;
		const fields = FIELD_ORDER.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(model[key]));
		if (fields.length > 0) changed.push({ id: model.id, fields: fields.map(String) });
	}
	return { id, file, added, removed, changed, dirty: added.length > 0 || changed.length > 0 || removed.length > 0 };
}

/** One summary line per change, capped by the caller (toasts cannot hold a full diff). */
export function summarizeDiff(diff: BaseTableDiff): string[] {
	return [
		...diff.added.map((id) => `+ ${id}`),
		...diff.changed.map((entry) => `~ ${entry.id} (${entry.fields.join(", ")})`),
		...diff.removed.map((id) => `- ${id} (removed: discovery did not return it)`),
	];
}

/**
 * Write the base table: `models.json.bak` first (the previous file, byte for byte), then a
 * temp file in the same directory, then a rename — so an interrupted write leaves either
 * the old file or the new one, never half of either.
 */
export function writeBaseTable(file: string, models: readonly CatalogModel[]): { backup?: string } {
	return writeTextAtomic(file, serializeBaseTable(models), { backup: true });
}
