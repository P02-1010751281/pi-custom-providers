/**
 * The JSON vocabulary every layer shares: reading a file into JSON (`readJson` + `JsonRead`),
 * and the object type plus the three guards used while reading untyped JSON. One definition
 * each — they were previously duplicated per module, with `numberOr` even differing between
 * callers.
 *
 * This is the leaf of the import graph: it imports no local module, so the modules that hand
 * the JSON shape back (`config.ts`, `types.ts`) can use these without forming a cycle.
 */
import { readFileSync } from "node:fs";

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
