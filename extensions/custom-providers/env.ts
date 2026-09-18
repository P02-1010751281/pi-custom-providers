import { readFileSync } from "node:fs";

/**
 * Load `KEY=VALUE` lines from a `.env` file into `process.env`, never overwriting a
 * variable that is already set. A missing or unreadable file is not an error: pi's
 * agent dir may not exist yet on first run, and the keys may come from the shell.
 *
 * Shared by the extension and `scripts/refresh-catalog.mjs` so both parse `.env`
 * identically (quotes stripped, `export ` prefix tolerated, `#` comments skipped).
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
