/**
 * `attention.md` documents pi's three config schemas field by field, and a doc that
 * lags the schema is exactly the failure this package exists to prevent. This test
 * re-derives the field lists from the installed pi and asserts the doc's schema block
 * mentions every field — pi adding one without the doc following turns this red.
 *
 * Doc-side only; the code-side counterpart is `pi-surface-test.mjs` (MODEL_KEYS vs
 * ModelDefinitionSchema).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PI, REPO_ROOT } from "./harness.mjs";

const piSource = readFileSync(path.join(PI, "dist/core/model-config.js"), "utf8");
function schemaKeys(name) {
	const body = piSource.match(new RegExp(`const ${name} = Type\\.Object\\(\\{([\\s\\S]*?)\\n\\}\\);`));
	if (!body) throw new Error(`pi dist has no ${name}`);
	return [...body[1].matchAll(/^\s{4}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
}

const doc = readFileSync(path.join(REPO_ROOT, ".codestable/attention.md"), "utf8");
const start = doc.indexOf("**pi 的三张配置 schema");
if (start < 0) throw new Error("attention.md lost its schema block");
const block = doc.slice(start, doc.indexOf("\n\n- pi 的 `calculateCost()`", start));
if (block.length < 200) throw new Error("schema block looks truncated");
// The prose may be reflowed onto several lines (one idea per line, see the layout
// rule in attention.md), so the count assertions compare whitespace-free text: the
// wording contract is `…块，N 字段`, not one physical line.
const flat = block.replace(/\s+/g, "");

const schemas = {
	ProviderConfigSchema: schemaKeys("ProviderConfigSchema"),
	ModelDefinitionSchema: schemaKeys("ModelDefinitionSchema"),
	ModelOverrideSchema: schemaKeys("ModelOverrideSchema"),
};
// The sub-shapes the schema nests: documented alongside the top-level fields.
const nested = [
	"maxRequestBytes", "maxPerMessage", "maxPerRequest", "jpegQuality", "inputTokensAbove",
	"short", "long", "off", "minimal", "low", "medium", "high", "xhigh", "max",
];
// Boundary-aware: `authHeader` must appear as its own token, so a renamed
// `authHeaderTypo` counts as missing rather than matching by prefix.
const mentions = (key) => new RegExp(`(^|[^A-Za-z0-9_])${key}([^A-Za-z0-9_]|$)`).test(block);
const missing = [];
for (const [name, keys] of Object.entries(schemas)) {
	if (keys.length === 0) throw new Error(`${name}: no fields parsed from pi dist`);
	for (const key of keys) if (!mentions(key)) missing.push(`${name}.${key}`);
}
for (const key of nested) if (!mentions(key)) missing.push(`sub-shape.${key}`);
if (missing.length) {
	console.error(`attention.md schema block is missing ${missing.length} field(s):`);
	for (const m of missing) console.error(`  - ${m}`);
	process.exit(1);
}
// The counts in the prose must match what pi actually declares.
for (const [name, keys] of Object.entries(schemas)) {
	const label = { ProviderConfigSchema: "`providers.<id>` 块", ModelDefinitionSchema: "`<id>/models.json` 条目", ModelOverrideSchema: "" }[name];
	const expected = `${label}，${keys.length} 字段`;
	if (label && !flat.includes(expected.replace(/\s+/g, ""))) {
		console.error(`${name}: doc must state "…${expected}"`);
		process.exit(1);
	}
}
console.log(`schema-doc: ${Object.values(schemas).map((k) => k.length).join("/")} fields + ${nested.length} sub-shape keys documented`);
