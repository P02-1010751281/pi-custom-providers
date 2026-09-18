/**
 * `custom-providers sync <id> [--write]` — the only code in this package that writes a
 * user file, and only with `--write`.
 *
 * What it writes is the *base table*: the vendor's model base (catalog or existing
 * `<id>/models.json`) merged with what discovery returned. The user layers (`providers.<id>`
 * and `modelOverrides` in pi's global `models.json`) are deliberately not baked in — a
 * single `sync --write` must not fossilize a user override into the base table.
 *
 * Ids that discovery no longer returns are kept and reported: whether a model is gone for
 * good is the user's call, not a truncated response's.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CatalogModel } from "./types.ts";

/** Field order of the written file — readable diffs, and the same order the generator emits. */
const FIELD_ORDER: (keyof CatalogModel)[] = ["id", "name", "api", "baseUrl", "reasoning", "input", "contextWindow", "maxTokens", "cost", "thinkingLevelMap", "headers", "compat"];

export function serializeBaseTable(models: readonly CatalogModel[]): string {
	const rows = models.map((model) => {
		const ordered: Record<string, unknown> = {};
		for (const key of FIELD_ORDER) {
			const value = model[key];
			if (value !== undefined) ordered[key] = value;
		}
		return ordered;
	});
	return `${JSON.stringify({ models: rows }, null, "\t")}\n`;
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
		...diff.removed.map((id) => `- ${id} (kept: discovery did not return it)`),
	];
}

/**
 * Write the base table: `models.json.bak` first (the previous file, byte for byte), then a
 * temp file in the same directory, then a rename — so an interrupted write leaves either
 * the old file or the new one, never half of either.
 */
export function writeBaseTable(file: string, models: readonly CatalogModel[]): { backup?: string } {
	const backup = existsSync(file) ? `${file}.bak` : undefined;
	if (backup) copyFileSync(file, backup);
	mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp-${process.pid}`;
	writeFileSync(temp, serializeBaseTable(models), "utf8");
	renameSync(temp, file);
	return backup ? { backup } : {};
}

/** Read the base table of a vendor directory; absent and broken are both non-fatal here. */
export function readBaseTable(file: string): { models: CatalogModel[]; present: boolean } {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		const rows = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { models?: unknown }).models) ? (parsed as { models: unknown[] }).models : [];
		return { models: rows as CatalogModel[], present: true };
	} catch {
		return { models: [], present: false };
	}
}
