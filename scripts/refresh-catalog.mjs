#!/usr/bin/env node
/**
 * Refresh `extensions/custom-providers/catalog.ts` from the providers' own
 * registries. The file is data only: the schema lives in `types.ts` and the endpoint
 * table in `sources.ts`, so neither is duplicated here.
 *
 * What is refreshed:
 *   - Command Code: model id set, display name, context window and wire
 *     (`supported_endpoints`).
 *   - Both SCNet wires: model id sets only (they differ — e.g. MiniMax-M2.5 is
 *     OpenAI-only). SCNet's wire returns ids with no parameters at all.
 *
 * Capability flags (`reasoning` / `input`) are **not** taken from the reseller's docs
 * page first: the authority is the official / pi built-in catalog (per-field majority
 * vote across the built-in providers that ship the same normalized id — they agree,
 * and a lone third-party host disagreeing is outvoted). Wire registries publish no
 * capability metadata at all (measured 2026-09-18: Command Code's OpenAI-shaped
 * `/models` has `id/name/context_length/supported_endpoints`, SCNet's has only
 * `id/object/ownedBy` and its Anthropic-shaped `capabilities` is null for every row).
 * Order per field: **built-in → Command Code capability page (embedded JSON, which
 * keys its table by its own ids — normalized on both sides, otherwise those models
 * silently keep their previous values) → previous catalog value**. Page/previous
 * disagreements are reported, never silently overwritten; pages that contradict
 * themselves (embedded data vs rendered table) are reported too, and no longer decide.
 *
 * What is preserved from the existing catalog: `maxTokens`, `cost`,
 * `thinkingLevelMap` and any hand-tuned value the wire cannot supply. New ids are
 * added with conservative defaults and reported so they can be tuned by hand.
 *
 * Usage: node scripts/refresh-catalog.mjs [--dry-run]
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const extDir = path.join(root, "extensions/custom-providers");
const catalogPath = path.join(extDir, "catalog.ts");
const dryRun = process.argv.includes("--dry-run");

/** Capability reference pages, per vendor that publishes one. */
const CAPS_DOCS = { commandcode: "https://commandcode.ai/docs/reference/cli/models" };

function findPiPackage() {
	const candidates = [];
	try {
		const npmRoot = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (npmRoot) candidates.push(path.join(npmRoot, "@earendil-works/pi-coding-agent"));
	} catch {
		// ignore
	}
	candidates.push("/home/user/.local/lib/node_modules/@earendil-works/pi-coding-agent");
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			readFileSync(path.join(candidate, "dist/index.js"));
			return candidate;
		} catch {
			// next
		}
	}
	throw new Error("pi package not found; set PI_PKG");
}

const piPackage = process.env.PI_PKG || findPiPackage();
const { createJiti } = await import(`${piPackage}/node_modules/jiti/lib/jiti-static.mjs`);
// `builtin.ts` imports `@earendil-works/pi-ai`, which only resolves through the
// extension loader's alias map (its compat entrypoint, which exports the catalog).
const jiti = createJiti(`${piPackage}/dist/core/extensions/loader.js`, {
	moduleCache: false,
	alias: { "@earendil-works/pi-ai": path.join(piPackage, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js") },
});
const importTs = (file) => jiti.import(path.join(extDir, file));

const { SOURCES } = await importTs("sources.ts");
const { loadEnvFile } = await importTs("env.ts");
// Reused rather than re-implemented: the script must resolve built-in ids and capability
// votes exactly like the extension does, or `custom-providers drift` would report the
// generator's disagreements as drift. The `@earendil-works/pi-ai` alias above exists for
// this import.
const { loadBuiltinCatalog, capabilityAuthority, builtinLevelMap, normalizeModelId } = await importTs("builtin.ts");
const builtin = await loadBuiltinCatalog();

loadEnvFile(path.join(homedir(), ".pi", "agent", ".env"));
loadEnvFile(path.join(homedir(), ".omp", "agent", ".env"));

/**
 * Probe targets derived from the runtime table, so a URL cannot drift between them: one per
 * *declared* endpoint (the default one plus every `apis.<api>`), because discovery is per
 * endpoint and a model served by a second protocol endpoint must be discovered there.
 * An endpoint without a `modelsPath` is listed with `path: undefined` — no discovery is far
 * better than guessing `/models`.
 */
const ENDPOINTS = SOURCES.flatMap((vendor) => {
	const env = vendor.builtinAccount.envVar;
	const defaults = { vendor, env };
	return [
		{ ...defaults, api: vendor.declaration.api, baseUrl: vendor.declaration.baseUrl, path: vendor.declaration.modelsPath },
		...Object.entries(vendor.declaration.apis).map(([api, endpoint]) => ({
			...defaults,
			api,
			baseUrl: endpoint.baseUrl,
			// Absent = inherit the vendor's path, and if that is absent too: no discovery.
			path: endpoint.modelsPath ?? vendor.declaration.modelsPath,
		})),
	];
});

async function fetchJson(url, headers, attempts = 3) {
	let last;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const response = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(20000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return await response.json();
		} catch (error) {
			last = error;
			await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
		}
	}
	throw last;
}

/**
 * The auth shape is decided by the protocol, never by an account's `authHeader`: an
 * Anthropic endpoint wants `x-api-key` + a version, everything else takes a bearer token.
 */
const endpointAuth = (api, key) =>
	api === "anthropic-messages"
		? { "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) }
		: key
			? { Authorization: `Bearer ${key}` }
			: {};

async function probeEndpoint(endpoint) {
	if (!endpoint.path) return { rows: [], skipped: true };
	const key = process.env[endpoint.env];
	const url = `${endpoint.baseUrl.replace(/\/+$/, "")}${endpoint.path.startsWith("/") ? endpoint.path : `/${endpoint.path}`}`;
	const payload = await fetchJson(url, endpointAuth(endpoint.api, key));
	const rows = Array.isArray(payload.data) ? payload.data : payload.models;
	if (!Array.isArray(rows)) throw new Error(`${endpoint.vendor.id}/${endpoint.api}: no data/models array (GET ${url})`);
	return { rows: rows.filter((row) => row && typeof row.id === "string"), skipped: false };
}

async function probeCaps(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
	const html = await response.text();
	const embedded = new Map();
	const pattern = /\[\\?"\$\\?",\\?"tr\\?",\\?"([^"\\]+)\\?",\{.*?\\?"caps\\?":\{\\?"text\\?":(true|false),\\?"vision\\?":(true|false),\\?"reasoning\\?":(true|false)\}/g;
	for (const match of html.matchAll(pattern)) embedded.set(capsKey(match[1]), { id: match[1], text: match[2] === "true", vision: match[3] === "true", reasoning: match[4] === "true" });
	const rendered = new Map();
	for (const row of html.split("<tr>").slice(1)) {
		const id = (row.match(/<code>([^<]+)<\/code>/) ?? [])[1];
		const label = (row.match(/aria-label="Capabilities: ([^"]*)"/) ?? [])[1];
		if (!id || !label) continue;
		rendered.set(capsKey(id), { id, text: label.includes("Text input"), vision: label.includes("Vision"), reasoning: label.includes("Reasoning") });
	}
	return { embedded, rendered };
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Capability authority: official / pi built-in catalog, per decision 18. The vote itself
 * lives in `builtin.ts` (shared with `drift`), so this only unwraps it.
 */
function builtinCapability(id) {
	return capabilityAuthority(builtin, id);
}

/** The docs page keys capabilities by its own ids; registry ids may carry a date suffix. */
const capsKey = (id) => id.toLowerCase().replace(/-\d{8}$/, "");
const familyMax = (id) => {
	const i = id.toLowerCase();
	if (i.includes("claude")) return 64000;
	if (i.includes("gpt-5")) return 128000;
	if (i.includes("gemini")) return 65536;
	if (i.includes("deepseek")) return 384000;
	if (i.includes("glm")) return 131072;
	if (i.includes("kimi")) return 65536;
	if (i.includes("qwen")) return 65536;
	if (i.includes("minimax")) return 131072;
	return 32768;
};
const clampMax = (value, ctx, id) => (Number.isInteger(value) && value > 0 && value < ctx ? value : Math.min(familyMax(id), Math.max(1024, ctx - 1)));

function freshModel(row, previous, page, defaultApi, probeApi) {
	const ctx = Number(row.context_length ?? row.contextWindow) || previous?.contextWindow || 128000;
	const authority = builtinCapability(row.id);
	// Capability authority: official / pi built-in first, then the reseller's page, then
	// whatever the catalog already said. Never a guess in the other direction.
	const reasoning = authority?.reasoning ?? page?.reasoning ?? previous?.reasoning ?? false;
	const vision = authority?.image ?? page?.vision ?? previous?.input?.includes("image") ?? false;
	const capabilityKnown = authority !== undefined || page !== undefined;
	// `supported_endpoints` says which protocols the *default* endpoint serves for this id;
	// when it lists only `/messages`, the id speaks anthropic-messages even though it came
	// back from the OpenAI-shaped registry.
	const messagesOnly = Array.isArray(row.supported_endpoints) && row.supported_endpoints.length > 0 && row.supported_endpoints.every((e) => e === "/messages");
	const modelApi = messagesOnly ? "anthropic-messages" : probeApi !== defaultApi ? probeApi : previous?.api ?? defaultApi;
	// Level maps are only taken from the built-in catalog on the anthropic wire (there the
	// map is a model fact); elsewhere the endpoint's own map wins by default and a differing
	// built-in map is reported, never copied.
	const api = modelApi;
	const levelMap = builtinLevelMap(builtin, row.id, api) ?? previous?.thinkingLevelMap;
	return {
		id: row.id,
		name: typeof row.name === "string" && row.name.length > 0 ? row.name : previous?.name ?? row.id,
		...(modelApi !== defaultApi ? { api: modelApi } : {}),
		reasoning,
		input: capabilityKnown ? (vision ? ["text", "image"] : ["text"]) : previous?.input ?? ["text"],
		contextWindow: ctx,
		maxTokens: previous && previous.maxTokens < ctx ? previous.maxTokens : clampMax(undefined, ctx, row.id),
		cost: { ...ZERO_COST, ...(previous?.cost ?? {}) },
		...(reasoning && levelMap ? { thinkingLevelMap: levelMap } : {}),
	};
}

function serialize(catalog) {
	const fields = ["id", "name", "api", "reasoning", "input", "contextWindow", "maxTokens", "cost", "thinkingLevelMap"];
	const lines = [
		"/**",
		" * GENERATED FILE — do not edit by hand.",
		" *",
		" * Regenerate with `node scripts/refresh-catalog.mjs`, which probes every declared",
		" * /models endpoints and the Command Code capability reference, then diffs the result",
		" * against this file (+added -removed ~changed).",
		" *",
		" * Schema: `types.ts`. Endpoints and API key variables: `sources.ts` (the generator",
		" * imports both, so neither the types nor the URLs are duplicated here).",
		" *",
		" * Fields the wire cannot supply (`maxTokens`, `thinkingLevelMap`) are preserved from",
		" * the previous catalog; new ids fall back to family defaults and are reported.",
		" *",
		" * `cost` is always present: pi requires it (`calculateCost` dereferences",
		" * `model.cost`). These are subscription lanes with no per-token price, so cost is zero.",
		" */",
		'import type { CatalogModel, VendorId } from "./types.ts";',
		"",
		"export const CATALOG: Record<VendorId, CatalogModel[]> = {",
	];
	for (const [source, models] of Object.entries(catalog)) {
		lines.push(`\t${JSON.stringify(source)}: [`);
		for (const model of models) {
			lines.push(`\t\t{ ${fields.filter((key) => key in model).map((key) => `${key}: ${JSON.stringify(model[key])}`).join(", ")} },`);
		}
		lines.push("\t],");
	}
	lines.push("};", "");
	return lines.join("\n");
}

const previous = (await importTs("catalog.ts")).CATALOG;
const missing = SOURCES.filter((vendor) => !Array.isArray(previous[vendor.id]) && !vendor.aliases.some((alias) => Array.isArray(previous[alias])));
if (missing.length > 0) throw new Error(`catalog.ts has no entry for: ${missing.map((vendor) => vendor.id).join(", ")} (sources.ts and catalog.ts are out of sync)`);

const [probed, caps] = await Promise.all([
	Promise.all(ENDPOINTS.map(async (endpoint) => {
		try {
			return { endpoint, ...(await probeEndpoint(endpoint)) };
		} catch (error) {
			if (!dryRun) throw error;
			return { endpoint, rows: [], skipped: false, error: String(error) };
		}
	})),
	Promise.all(Object.entries(CAPS_DOCS).map(async ([id, url]) => [id, await probeCaps(url)])),
]);
const capsById = Object.fromEntries(caps);
const capFor = (vendorId, modelId) => capsById[vendorId]?.embedded.get(capsKey(modelId));

/**
 * One vendor's model list, assembled from every endpoint's rows. An id served by the
 * default endpoint needs no `api` (and gets none: that keeps `providers.<id>.baseUrl` able
 * to redirect it); an id only a second endpoint serves carries that endpoint's api, which
 * the loader turns into `api` + `apis.<api>.baseUrl` (§5.2). The previous value is only
 * kept when discovery says nothing about the api.
 */
const catalog = {};
for (const vendor of SOURCES) {
	const perEndpoint = probed.filter((entry) => entry.endpoint.vendor.id === vendor.id);
	const previousOf = new Map(
		[...(previous[vendor.id] ?? []), ...vendor.aliases.flatMap((alias) => previous[alias] ?? [])].map((model) => [model.id, model]),
	);
	const defaultApi = vendor.declaration.api;
	const ids = [];
	const seen = new Set();
	const rowsById = new Map();
	for (const entry of perEndpoint) {
		for (const row of entry.rows) {
			if (!seen.has(row.id)) {
				seen.add(row.id);
				ids.push(row.id);
			}
			// The default endpoint's row wins when several endpoints return the same id: its
			// `supported_endpoints` is what says whether the id may use the default protocol.
			const existing = rowsById.get(row.id);
			if (!existing || entry.endpoint.api === defaultApi) rowsById.set(row.id, { row, probeApi: entry.endpoint.api });
		}
	}
	catalog[vendor.id] = ids.map((id) => {
		const { row, probeApi } = rowsById.get(id);
		return freshModel(row, previousOf.get(id), capFor(vendor.id, id), defaultApi, probeApi);
	});
}
for (const entry of probed) {
	if (entry.skipped) console.log(`  ${entry.endpoint.vendor.id}/${entry.endpoint.api}: no modelsPath declared -> no discovery for this endpoint`);
	if (entry.error) console.log(`  ${entry.endpoint.vendor.id}/${entry.endpoint.api}: probe failed (dry run, previous values kept): ${entry.error}`);
}

const report = (name, before, after) => {
	const beforeIds = new Set(before.map((m) => m.id));
	const afterIds = new Set(after.map((m) => m.id));
	const added = [...afterIds].filter((id) => !beforeIds.has(id));
	const removed = [...beforeIds].filter((id) => !afterIds.has(id));
	const changed = after.filter((model) => {
		const old = before.find((entry) => entry.id === model.id);
		return old && JSON.stringify(old) !== JSON.stringify(model);
	});
	console.log(`${name}: ${after.length} models (+${added.length} -${removed.length} ~${changed.length})`);
	if (added.length) console.log(`  added:   ${added.join(", ")}`);
	if (removed.length) console.log(`  removed: ${removed.join(", ")}`);
	for (const model of changed) console.log(`  changed: ${model.id}`);
};
for (const vendor of SOURCES) {
	const before = previous[vendor.id] ?? vendor.aliases.flatMap((alias) => previous[alias] ?? []);
	report(vendor.id, before, catalog[vendor.id]);
}

// Both are silent-drift traps, so they are reported instead of guessed at.
for (const [vendorId, { embedded, rendered }] of Object.entries(capsById)) {
	const ids = (catalog[vendorId] ?? []).map((row) => row.id);
	const unknown = ids.filter((id) => !embedded.has(capsKey(id)) && !builtinCapability(id));
	if (unknown.length > 0) console.log(`  caps: no capability source for ${unknown.join(", ")} (previous values preserved)`);
	const conflicts = [...embedded]
		.map(([key, embeddedFlags]) => {
			const renderedFlags = rendered.get(key);
			if (!renderedFlags || (renderedFlags.vision === embeddedFlags.vision && renderedFlags.reasoning === embeddedFlags.reasoning)) return undefined;
			return `${embeddedFlags.id}: embedded vision=${embeddedFlags.vision} reasoning=${embeddedFlags.reasoning} | rendered vision=${renderedFlags.vision} reasoning=${renderedFlags.reasoning}`;
		})
		.filter(Boolean);
	if (conflicts.length > 0) console.log(`  caps: the page disagrees with itself -> ${conflicts.join("; ")}`);
}

// Official / built-in authority: how many models it decided, and where the reseller's
// page would have said otherwise (visible so a stale page entry cannot hide).
const builtinDecided = [];
const pageAgainstBuiltin = [];
const levelMapApplied = [];
const levelMapKept = [];
for (const vendor of SOURCES) {
	for (const model of catalog[vendor.id] ?? []) {
		const authority = builtinCapability(model.id);
		if (authority) {
			builtinDecided.push(`${vendor.id}/${model.id}`);
			const page = capFor(vendor.id, model.id);
			if (page && (page.reasoning !== authority.reasoning || page.vision !== authority.image)) {
				pageAgainstBuiltin.push(`${model.id}: built-in reasoning=${authority.reasoning} image=${authority.image} | page reasoning=${page.reasoning} vision=${page.vision}`);
			}
		}
		// Level maps: counted separately, because only the anthropic wire's map is taken.
		if (!model.thinkingLevelMap) continue;
		if (builtinLevelMap(builtin, model.id, model.api ?? vendor.declaration.api)) levelMapApplied.push(`${vendor.id}/${model.id}`);
		else levelMapKept.push(`${vendor.id}/${model.id}`);
	}
}
console.log(`  caps: built-in (official) authority decided ${builtinDecided.length} models`);
for (const line of pageAgainstBuiltin) console.log(`  caps: page disagrees with built-in, built-in wins -> ${line}`);
console.log(`  caps: built-in level map applied to ${levelMapApplied.length} models (anthropic wire only): ${levelMapApplied.join(", ") || "-"}`);
console.log(`  caps: ${levelMapKept.length} models keep their own level map (built-in maps are per-gateway outside the anthropic wire)`);

const output = serialize(catalog);
if (dryRun) {
	console.log("dry run: not writing catalog.ts");
} else {
	writeFileSync(catalogPath, output);
	console.log(`wrote ${catalogPath}`);
}
