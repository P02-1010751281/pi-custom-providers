import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
/**
 * Load `KEY=VALUE` lines from a `.env` file into `process.env`, never overwriting a
 * variable that is already set. A missing or unreadable file is not an error: pi's
 * agent dir may not exist yet on first run, and the keys may come from the shell.
 *
 * Quotes are stripped, `export ` is tolerated and `#` starts a comment.
 */
export function loadEnvFile(file: string): void {
	try {
		const text = readFileSync(file, "utf8");
		for (const rawLine of text.split(/\r?\n/)) {
			const line = rawLine.trim().replace(/^export\s+/, "");
			if (!line || line.startsWith("#")) continue;
			const separator = line.indexOf("=");
			if (separator < 1) continue;
			const key = line.slice(0, separator).trim();
			const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
			if (!process.env[key]) process.env[key] = value;
		}
	} catch {
		// Optional.
	}
}

/** Resolve one pi value expression (`$VAR` / `${VAR}` / `$$` / `$!` / `!command` / literal). */
export function resolveConfigValue(value: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (value === undefined) return undefined;
	if (value.startsWith("$$")) return value.slice(1);
	if (value.startsWith("$!")) return value.slice(1);
	const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
	if (braced) return env[braced[1]] || undefined;
	const plain = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
	if (plain) return env[plain[1]] || undefined;
	if (value.startsWith("!")) {
		try {
			return execSync(value.slice(1), { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
		} catch {
			return undefined;
		}
	}
	// A bare UPPER_SNAKE value is an environment variable *name*: pi would send the name
	// itself as the token (`resolve-config-value.js` treats a bare string as a literal).
	if (/^[A-Z][A-Z0-9_]*$/.test(value)) return env[value] || undefined;
	return value;
}

/** The value we hand pi: bare `UPPER_SNAKE` becomes `$VAR`, since pi only interpolates `$…`. */
export const configValueForPi = (value: string | undefined): string | undefined =>
	value === undefined ? undefined : /^[A-Z][A-Z0-9_]*$/.test(value) ? `$${value}` : value;
