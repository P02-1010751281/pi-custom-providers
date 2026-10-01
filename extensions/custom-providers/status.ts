/**
 * Per-provider status, and the one place problem text is assembled.
 *
 * `ProviderStatus` is what a command or hook reports. `problemLines` orders everything worth
 * saying — file problems first (they are ours to fix and would otherwise be buried), then
 * failed refreshes, new ids, vanished ids, and the "no live data" note, which is expected
 * offline and only noise in quantity. Pure functions over the statuses the caller passes in.
 */
import type { DriftSummary } from "./builtin.ts";
import type { ModelEntry } from "./providers.ts";
import type { LoadIssue } from "./types.ts";

/** A compact, one-line-per-provider status, plus everything needed by the commands. */
export interface ProviderStatus {
	id: string;
	models: number;
	live: boolean;
	unknown: string[];
	/** Base ids the last complete discovery round no longer returned (kept, `sync --prune` drops). */
	vanished: string[];
	issues: LoadIssue[];
	error?: string;
	drift?: DriftSummary;
	apis: { api: string; models: number }[];
	accounts: string[];
}

export function apiSplit(models: readonly ModelEntry[], defaultApi: string, multiEndpoint: boolean): { api: string; models: number }[] {
	if (!multiEndpoint) return [{ api: defaultApi, models: models.length }];
	const counts = new Map<string, number>();
	for (const model of models) {
		const api = model.api ?? defaultApi;
		counts.set(api, (counts.get(api) ?? 0) + 1);
	}
	return [...counts.entries()].map(([api, models]) => ({ api, models })).sort((a, b) => a.api.localeCompare(b.api));
}

/** Trim a toast: the first lines plus a count, never a wall of text. */
export function toastLines(lines: readonly string[], limit = 8): string {
	const shown = lines.slice(0, limit).join("; ");
	return lines.length > limit ? `${shown} (+${lines.length - limit} more)` : shown;
}

/**
 * Everything worth reporting, most actionable first (see the file comment). Takes the
 * already-sorted statuses so the caller decides the order once per command.
 */
export function problemLines(statuses: readonly ProviderStatus[], globalIssues: readonly LoadIssue[]): string[] {
	// The directory layer reports an issue with its location in front (`custom-providers/<id>: …`)
	// while the provider's own status carries the bare message: one problem, two paths. Compare
	// without the location so only the first of the two is printed.
	const withoutLocation = (message: string): string => message.replace(/^custom-providers\/[^:]+: /, "");
	const alreadyReported = new Set(globalIssues.map((issue) => withoutLocation(issue.message)));
	return [
		...globalIssues.filter((issue) => issue.level === "error").map((issue) => issue.message),
		...globalIssues.filter((issue) => issue.level === "warning").map((issue) => issue.message),
		// Problems a provider's own synthesis reported (endpoint fallbacks, invalid model apis).
		...[...new Set(statuses.flatMap((status) => status.issues.map((issue) => issue.message)))].filter((message) => !alreadyReported.has(withoutLocation(message))),
		...statuses
			.filter((status) => status.error)
			.map((status) => `${status.id}: refresh failed, using ${status.models} model(s)${status.live ? " from the last successful fetch" : " from the base table"} (${status.error})`),
		...statuses
			.filter((status) => status.unknown.length > 0)
			.map((status) => `${status.id}: new model(s) not in models.json: ${status.unknown.join(", ")}`),
		...statuses
			.filter((status) => status.vanished.length > 0)
			.map((status) => `${status.id}: model(s) no longer returned by discovery (kept, sync --prune drops): ${status.vanished.join(", ")}`),
		...statuses
			.filter((status) => !status.error && !status.live)
			.map((status) => `${status.id}: live models unavailable (${status.models} model(s) from base)`),
	];
}
