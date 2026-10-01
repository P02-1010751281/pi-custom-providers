/**
 * The JSON vocabulary every layer shares: reading a file into JSON (`readJson` + `JsonRead`),
 * writing one back out (`serializeJson`, `writeTextAtomic`), and the object type plus the three
 * guards used while reading untyped JSON. One definition each — they were previously duplicated
 * per module (`numberOr` even differed between callers), and the two writers each restated the
 * same serialization and the same temp-file-plus-rename dance.
 *
 * This is the leaf of the import graph: it imports no local module, so the modules that hand
 * the JSON shape back (`config.ts`, `types.ts`) can use these without forming a cycle.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A JSON object: what pi's schema means by `object` (never `null`, never an array). */
export type JsonObject = Record<string, any>;

/** A JSON object (pi rejects `null` and arrays where an object is expected). */
export const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** A non-empty string, or undefined. */
export const stringOr = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** A finite positive number, or undefined (callers supply their own fallback). */
export const numberOr = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

/** A file read as JSON: its value, or why it could not be read/parsed. `missing` is a fact, not an error. */
export type JsonRead = { value?: unknown; missing?: boolean; issue?: string };

/** Read a file as JSON. Absent, unreadable and unparseable are three different answers. */
export function readJson(file: string): JsonRead {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { missing: true };
		return { issue: `cannot read ${file}: ${String(error)}` };
	}
	try {
		return { value: JSON.parse(raw) };
	} catch (error) {
		return { issue: `cannot parse ${file}: ${String(error)}` };
	}
}

/** JSON as this package writes it: one tab of indentation and a trailing newline, so diffs are readable. */
export const serializeJson = (value: unknown): string => `${JSON.stringify(value, null, "\t")}\n`;

/**
 * Write text to a file atomically: a temp file in the same directory, then a rename, so an
 * interrupted write leaves either the old file or the new one, never half of either. With
 * `backup: true` the previous file is kept byte for byte as `<file>.bak` first (only when
 * there is one to keep). The temp file is removed if the write fails.
 */
export function writeTextAtomic(file: string, text: string, options: { backup?: boolean } = {}): { backup?: string } {
	mkdirSync(path.dirname(file), { recursive: true });
	const backup = options.backup && existsSync(file) ? `${file}.bak` : undefined;
	if (backup) copyFileSync(file, backup);
	const temp = `${file}.tmp-${process.pid}`;
	try {
		writeFileSync(temp, text, "utf8");
		renameSync(temp, file);
	} catch (error) {
		try {
			rmSync(temp, { force: true });
		} catch {
			// The temp file may already be gone; the original failure is the one worth reporting.
		}
		throw error;
	}
	return backup ? { backup } : {};
}
