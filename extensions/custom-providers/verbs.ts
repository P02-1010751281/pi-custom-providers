/**
 * The `/providers` command surface: one verb table, one flag list per verb, one parser.
 *
 * The parser is the only reader of the argument string and the `Usage:` text is rendered from
 * these tables, so the accepted surface and the help text cannot drift apart. The first token is
 * a verb when it hits the table, otherwise it is a provider id for the default verb (`status`):
 * verbs win over provider ids, so a provider called `sync` is reached with `status sync`.
 *
 * This module is a leaf — no imports, no side effects. `index.ts` routes on `verb.name`.
 */

export type VerbName = "status" | "files" | "init" | "sync" | "rescan";

export interface FlagSpec {
	/** As typed, including the leading dashes. */
	name: string;
	/** The placeholder of the argument it takes (`<u>`); absent means a bare switch. */
	value?: string;
}

export interface VerbSpec {
	/** As typed, after the command name. */
	name: VerbName;
	/** The positional part of the usage line, verbatim (`[<id>]`, `<id>`, or the empty string). */
	positional: string;
	/** What a missing positional is called in the diagnostic (`a provider id`). */
	argHint?: string;
	/** Flags this verb accepts; any other flag is a `Usage:` error for this verb. */
	flags: readonly FlagSpec[];
	/** Flags that only mean something with an explicit positional (`--prune <id>`). */
	flagsRequiringPositional?: readonly string[];
	/** Inclusive positional range; `Infinity` means "no upper bound". */
	minPositionals: number;
	maxPositionals: number;
	/** One clause for the command description; the usage text itself is rendered from the fields above. */
	job: string;
}

/** The command as typed in the TUI (`/providers …`). */
export const COMMAND = "providers";
/** The verb a bare argument list runs. */
export const DEFAULT_VERB: VerbName = "status";

export const VERBS: readonly VerbSpec[] = [
	{
		name: "status",
		positional: "[<id>]",
		flags: [],
		minPositionals: 0,
		maxPositionals: 1,
		job: "overview, or one provider's detail",
	},
	{
		name: "files",
		positional: "",
		flags: [],
		minPositionals: 0,
		maxPositionals: 0,
		job: "what the provider directory holds (read-only scan)",
	},
	{
		name: "init",
		positional: "[<id>]",
		argHint: "a provider id",
		flags: [
			{ name: "--url", value: "<u>" },
			{ name: "--api", value: "<a>" },
			{ name: "--models-path", value: "<p>" },
			{ name: "--key", value: "<v>" },
			{ name: "--force" },
		],
		minPositionals: 0,
		maxPositionals: 1,
		job: "write <id>/provider.json (+ accounts.json when a key is given)",
	},
	{
		name: "sync",
		positional: "[<id>]",
		argHint: "a provider id",
		flags: [{ name: "--dry-run" }, { name: "--prune" }],
		flagsRequiringPositional: ["--prune"],
		minPositionals: 0,
		maxPositionals: 1,
		job: "fetch /models and write the base table (no id = every vendor)",
	},
	{
		name: "rescan",
		positional: "[<id>]",
		argHint: "a provider id",
		flags: [{ name: "--dry-run" }],
		minPositionals: 0,
		maxPositionals: 1,
		job: "re-read the provider directory and re-register (for hand edits; never writes)",
	},
];

export interface ParsedCommand {
	verb: VerbSpec;
	positionals: string[];
	flags: ReadonlySet<string>;
	/** The argument of each flag that takes one (`--url <u>`), by flag name. */
	values: ReadonlyMap<string, string>;
}

export interface ParseFailure {
	/** Human diagnosis; the usage line follows on the next line. */
	message: string;
	/** The token the diagnosis is about, when there is one. */
	token?: string;
}

export type ParseResult = { ok: true; command: ParsedCommand } | { ok: false; failure: ParseFailure };

/** `/providers [status] [<id>]` — the default verb is bracketed, the way it may be omitted. */
export function commandLine(verb: VerbSpec): string {
	const name = verb.name === DEFAULT_VERB ? `[${verb.name}]` : verb.name;
	const flags = verb.flags.map((flag) => `[${flag.name}${flag.value ? ` ${flag.value}` : ""}]`);
	return [`/${COMMAND}`, name, ...(verb.positional ? [verb.positional] : []), ...flags].join(" ");
}

export function usageLine(verb: VerbSpec): string {
	return `Usage: ${commandLine(verb)}`;
}

/** Every verb on one line — what `status` prints when the first token is neither. */
export function usageOverview(): string {
	return `Usage: /providers ${VERBS.map((verb) => commandLine(verb).slice(`/${COMMAND} `.length)).join(" | ")}`;
}

/** The description pi shows for the command: usage and job per verb. */
export function commandDescription(): string {
	return VERBS.map((verb) => `${commandLine(verb)} — ${verb.job}`).join("; ");
}

function failure(verb: VerbSpec, message: string, token?: string): ParseResult {
	return { ok: false, failure: { message: `${message}\n${usageLine(verb)}`, ...(token === undefined ? {} : { token }) } };
}

export function parseCommand(args: string): ParseResult {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const head = tokens.shift();
	// A token that is not a verb is this verb's first positional, not an error: a bare `demo`
	// means `status demo`.
	const verb =
		(head === undefined ? undefined : VERBS.find((candidate) => candidate.name === head)) ??
		VERBS.find((candidate) => candidate.name === DEFAULT_VERB)!;
	const rest = head !== undefined && verb.name !== head ? [head, ...tokens] : tokens;
	const positionals: string[] = [];
	const flags = new Set<string>();
	const values = new Map<string, string>();
	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index]!;
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const spec = verb.flags.find((flag) => flag.name === token);
		if (!spec) return failure(verb, `unknown flag "${token}" for "${verb.name}"`, token);
		flags.add(spec.name);
		if (spec.value) {
			const value = rest[index + 1];
			// A value that looks like a flag is not one: `--key --force` is a missing value, not a
			// key that happens to spell a flag.
			if (value === undefined || value.startsWith("--")) return failure(verb, `"${spec.name}" needs ${spec.value}`, spec.name);
			values.set(spec.name, value);
			index += 1;
		}
	}
	if (positionals.length < verb.minPositionals) return failure(verb, `"${verb.name}" needs ${verb.argHint ?? "an argument"}`);
	for (const flag of verb.flagsRequiringPositional ?? []) {
		if (flags.has(flag) && positionals.length === 0) return failure(verb, `"${flag}" needs ${verb.argHint ?? "an argument"}`, flag);
	}
	if (positionals.length > verb.maxPositionals) {
		const got = positionals.length === 1 ? `got "${positionals[0]}"` : `got ${positionals.length}`;
		const takes =
			verb.maxPositionals === 0
				? "takes no arguments"
				: `takes at most ${verb.maxPositionals === 1 ? "one argument" : `${verb.maxPositionals} arguments`}`;
		return failure(verb, `"${verb.name}" ${takes} (${got})`, positionals[verb.maxPositionals]);
	}
	return { ok: true, command: { verb, positionals, flags, values } };
}
