/**
 * The three guards every layer uses while reading untyped JSON. One definition each: they
 * were previously duplicated per module, with `numberOr` even differing between callers.
 */
import type { JsonObject } from "./config.ts";

/** A JSON object (pi rejects `null` and arrays where an object is expected). */
export const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** A non-empty string, or undefined. */
export const stringOr = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** A finite positive number, or undefined (callers supply their own fallback). */
export const numberOr = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
