/**
 * pi's value grammar, mirrored: a credential this package only *checks for* has to resolve
 * exactly as pi will resolve it at request time, or the two disagree about whether a
 * credential exists. pi exports neither its resolver nor its grammar, so the grammar is
 * repeated here — and `tests/env-test.mjs` pins it against pi's own `resolveConfigValue`,
 * which is also where the shell for a `!command` comes from (`getShellConfig()`).
 */
import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

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

/**
 * Run a `!command` the way pi runs one. pi uses the platform shell (`/bin/sh -c`) everywhere
 * except Windows, where it prefers its own bash — Git Bash if it is installed, otherwise the
 * platform shell again — because Node's default shell there is `cmd.exe`, which is not the
 * shell a user's command was written for. Running it through anything else would make this
 * package's answer to "is there a credential?" differ from pi's.
 */
function runCommand(command: string): string | undefined {
	if (process.platform === "win32") {
		const configured = runWithPiShell(command);
		if (configured.executed) return configured.value;
	}
	return runWithPlatformShell(command);
}

function runWithPlatformShell(command: string): string | undefined {
	try {
		return execSync(command, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * pi's `executeWithConfiguredShell`: `executed: false` means the shell itself was not found
 * (no bash on Windows), which is the one case where pi falls back to the platform shell.
 */
function runWithPiShell(command: string): { executed: boolean; value?: string } {
	try {
		const { shell, args, commandTransport } = getShellConfig();
		const fromStdin = commandTransport === "stdin";
		const result = spawnSync(shell, fromStdin ? args : [...args, command], {
			encoding: "utf8",
			input: fromStdin ? command : undefined,
			timeout: 10_000,
			stdio: [fromStdin ? "pipe" : "ignore", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
		});
		if (result.error) return { executed: result.error.code !== "ENOENT" };
		if (result.status !== 0) return { executed: true };
		return { executed: true, value: (result.stdout ?? "").trim() || undefined };
	} catch {
		// `getShellConfig()` throws when the platform has no bash at all.
		return { executed: false };
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
	if (value.startsWith("!")) return runCommand(value.slice(1));
	// A bare UPPER_SNAKE value is an environment variable *name*: pi would send the name
	// itself as the token (`resolve-config-value.js` treats a bare string as a literal).
	if (/^[A-Z][A-Z0-9_]*$/.test(value)) return env[value] || undefined;
	return value;
}

/** The value we hand pi: bare `UPPER_SNAKE` becomes `$VAR`, since pi only interpolates `$…`. */
export const configValueForPi = (value: string | undefined): string | undefined =>
	value === undefined ? undefined : /^[A-Z][A-Z0-9_]*$/.test(value) ? `$${value}` : value;
