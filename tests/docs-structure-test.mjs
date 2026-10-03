/**
 * The tracked documents are hand-maintained and their layout rules used to live in a throwaway
 * script outside the repo. That is how `README.md` shipped in v0.5.1 with an unclosed code fence:
 * the ad-hoc check toggled a boolean on every fence-looking line instead of pairing fences, so the
 * two paragraphs after the fence rendered as code and every check still said OK.
 *
 * This guard reads every tracked document (`README.md`, `CHANGELOG.md`, `.codestable/**\/*.md`) and
 * pins the four structural rules `attention.md` writes down:
 *   - fences pair up: a closing fence carries no info string and is not shorter than its opener;
 *   - every row of a table has as many cells as its header, and every table has a separator row;
 *   - a prose line stays within 200 code points — table rows and lines inside a fence are exempt,
 *     because the rule is one record or one code statement per line;
 *   - the suite count the documents state matches what `tests/` holds.
 * Prose means any line outside a fence that is not a table row, so an indented continuation line is
 * checked too; code in these documents is expected to live in a fence. A fence indented four spaces
 * or more is an indented code block rather than a fence and is ignored by the pairing rule.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { assert, REPO_ROOT } from "./harness.mjs";

const BUDGET = 200;

/** Every tracked document: the ones at the repo root plus everything under `.codestable`. */
function trackedDocs() {
	const files = readdirSync(REPO_ROOT)
		.filter((name) => name.endsWith(".md"))
		.map((name) => path.join(REPO_ROOT, name));
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".md")) files.push(full);
		}
	};
	walk(path.join(REPO_ROOT, ".codestable"));
	return files.sort();
}

const DOCS = trackedDocs();
// A walk that silently finds nothing would make every rule below pass.
for (const required of ["README.md", "CHANGELOG.md", ".codestable/attention.md"]) {
	assert(
		DOCS.some((file) => path.relative(REPO_ROOT, file) === required),
		`${required} is among the guarded documents (walk found ${DOCS.length})`,
	);
}

const FENCE = /^ {0,3}(`{3,})(.*)$/;
const TABLE_ROW = /^\s*\|/;
/** A cell count that ignores inline code spans and escaped pipes. */
const cells = (line) => (line.replace(/`[^`]*`/g, "").match(/(?<!\\)\|/g) ?? []).length;

const problems = [];
const counts = { fences: 0, tables: 0 };

for (const file of DOCS) {
	const rel = path.relative(REPO_ROOT, file);
	const lines = readFileSync(file, "utf8").split("\n");
	let open = null; // the fence that is currently open
	let table = null; // the table that is currently open

	for (const [index, line] of lines.entries()) {
		const at = index + 1;
		const fence = FENCE.exec(line);

		if (fence && open === null) {
			open = { line: at, ticks: fence[1].length };
			table = null; // a fence inside a table run ends it
			counts.fences += 1;
			continue;
		}
		if (fence) {
			const closes = fence[2].trim() === "" && fence[1].length >= open.ticks;
			if (closes) open = null;
			else problems.push(`${rel}:${at}: fence-like line cannot close the block opened at line ${open.line}`);
			continue;
		}
		if (open !== null) continue; // inside a fence: neither a table row nor prose

		if (TABLE_ROW.test(line)) {
			const width = cells(line);
			const separator = line.replace(/[|\-:\s]/g, "") === "" && line.includes("-");
			if (table === null) {
				table = { line: at, width, separator };
				counts.tables += 1;
			} else {
				if (width !== table.width) problems.push(`${rel}:${at}: table row has ${width} cells, header at line ${table.line} has ${table.width}`);
				if (separator) table.separator = true;
			}
			continue;
		}

		if (table !== null && !table.separator) problems.push(`${rel}:${table.line}: table has no separator row`);
		table = null;

		const length = [...line].length;
		if (length > BUDGET) problems.push(`${rel}:${at}: ${length} code points (budget ${BUDGET})`);
	}
	if (open !== null) problems.push(`${rel}:${open.line}: unclosed fence`);
	if (table !== null && !table.separator) problems.push(`${rel}:${table.line}: table has no separator row`);
}

assert(problems.length === 0, `tracked documents are well-formed:\n  ${problems.join("\n  ")}`);

// --- the suite count the documents state is what tests/ holds ---------------------------
const suites = readdirSync(path.join(REPO_ROOT, "tests")).filter(
	(name) => name.endsWith(".mjs") && name !== "run-all.mjs" && name !== "harness.mjs",
).length;
const stated = [
	["README.md", /#\s*(\d+)\s*个套件/],
	[".codestable/attention.md", /跑全部（(\d+) 个/],
];
for (const [name, pattern] of stated) {
	const count = readFileSync(path.join(REPO_ROOT, name), "utf8").match(pattern);
	assert(count, `${name} states how many suites run-all.mjs runs`);
	assert(Number(count[1]) === suites, `${name} states the suite count (doc ${count[1]} / tests/${suites})`);
}

console.log(`docs-structure: ${DOCS.length} documents, ${counts.fences} fences, ${counts.tables} tables, ${suites} suites`);
