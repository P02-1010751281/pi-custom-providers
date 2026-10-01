import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { EXT, assert } from "./harness.mjs";

/**
 * The module graph. It was hand-verified until now, and a cycle would be easy to miss in a
 * repo with no typechecker: pi's jiti loader evaluates whatever it is handed, and turning a
 * type-only import into a runtime one is a one-word edit. So the shape is pinned here:
 *
 *   1. every `./x.ts` import (or re-export) names a file that exists,
 *   2. the graph is acyclic — type-only edges included, since a type-only back-edge is
 *      exactly the shape the one cycle this package ever had took,
 *   3. every module is reachable from `index.ts` — an orphan is dead code.
 *
 * `util.ts` and `apis.ts` are the leaves (they import nothing): the first holds the JSON guards
 * every layer uses, the second pi's vocabulary. `index.ts` is the only entry pi loads.
 */
const dir = path.join(EXT, "custom-providers");
const modules = readdirSync(dir)
	.filter((file) => file.endsWith(".ts"))
	.sort();
const deps = new Map(modules.map((module) => [module, []]));

const DEPENDENCY = /\b(?:import|export)\b([^;]*?)\bfrom\s+"\.\/([\w-]+)\.ts"/g;
for (const module of modules) {
	const text = readFileSync(path.join(dir, module), "utf8");
	const found = [...text.matchAll(DEPENDENCY)];
	const declared = text.match(/\bfrom\s+"\.\//g)?.length ?? 0;
	assert(found.length === declared, `${module}: every local import is a \`./x.ts\` statement (parsed ${found.length} of ${declared})`);
	for (const [, clause, target] of found) {
		assert(modules.includes(`${target}.ts`), `${module} imports a module that does not exist: ${target}.ts`);
		deps.get(module).push({ to: `${target}.ts`, typeOnly: /^\s*type\b/.test(clause) });
	}
}

// 2. Depth-first cycle check. `open` means "on the current path", so an edge to an open
// module is a cycle and the path to it is the report.
const state = new Map();
const stack = [];
const visit = (module) => {
	state.set(module, "open");
	stack.push(module);
	for (const { to } of deps.get(module)) {
		if (state.get(to) === "open") assert(false, `import cycle: ${[...stack.slice(stack.indexOf(to)), to].join(" -> ")}`);
		if (!state.has(to)) visit(to);
	}
	stack.pop();
	state.set(module, "done");
};
for (const module of modules) if (!state.has(module)) visit(module);

// 3. Everything must hang off the entry point pi loads.
const reachable = new Set();
const walk = (module) => {
	if (reachable.has(module)) return;
	reachable.add(module);
	for (const { to } of deps.get(module)) walk(to);
};
walk("index.ts");
assert(reachable.size === modules.length, `every module is reachable from index.ts (unreachable: ${modules.filter((module) => !reachable.has(module)).join(", ")})`);

// The leaf matters: the JSON guards live there, and they are used by the very modules a
// dependency of `util.ts` would have to come from.
assert(deps.get("util.ts").length === 0, "util.ts is the import-graph leaf (it must import nothing)");
// Same for the pi vocabulary: a dependency here would make every layer that speaks pi's
// protocols depend on that layer too.
assert(deps.get("apis.ts").length === 0, "apis.ts holds no local dependency (it is pi's vocabulary, and nothing else)");

console.log(`modules: ${modules.length}, no cycles, all reachable from index.ts`);
console.log("OK");
