/**
 * pi's own vocabulary, mirrored: the protocols pi can stream (plus our aliases for them), and
 * the model defaults pi fills in when a definition leaves them out. pi exports neither —
 * `BUILTIN_APIS` is a private pair-list in `pi-ai/dist/compat.js`, the defaults live inside the
 * composer — so both are repeated here, and `tests/apis-test.mjs` pins the protocol list
 * against the registry pi actually populates.
 *
 * The import-graph leaf for everything pi-shaped: it imports nothing, so any layer may speak
 * pi's vocabulary without dragging another layer along.
 */

/**
 * pi's built-in protocol ids — `BUILTIN_APIS` in `pi-ai/dist/compat.js:108`, which is a
 * private const pair-list, so the ids are repeated here. `tests/apis-test.mjs` asserts
 * this list against the registry pi actually populates (`getApiProviders()`), so a pi
 * build that adds or drops one fails a test instead of silently rejecting a protocol.
 * Registering or requesting any of them is pi's own job; nothing here implements one.
 */
export const BUILTIN_APIS = [
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"bedrock-converse-stream",
	"pi-messages",
] as const;

/**
 * Accepted spellings, lowercased: three short names plus pi's ids themselves (a
 * differently-cased pi id is a typo, not a different protocol). Anything else is
 * reported and skipped rather than passed through — pi would only fail later, at
 * registration, with a message that does not name the file it came from.
 */
const API_ALIASES: Record<string, string> = {
	openai: "openai-completions",
	chat: "openai-completions",
	anthropic: "anthropic-messages",
	messages: "anthropic-messages",
	responses: "openai-responses",
};

/** Resolve one `api` value to a pi protocol id, or undefined when pi has no such protocol. */
export function normalizeApi(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const api = value.trim().toLowerCase();
	if (api.length === 0) return undefined;
	const resolved = API_ALIASES[api] ?? api;
	return (BUILTIN_APIS as readonly string[]).includes(resolved) ? resolved : undefined;
}

/**
 * Size of a model nobody declared one for. Discovery never invents parameters, and an entry
 * only the user declares still has to satisfy `registerProvider`, so both numbers are needed
 * — kept with the api vocabulary because they are pi's own model defaults, and every layer
 * that fills a hole (the directory reader, the live row, the synthesized row) must mean the
 * same number by "we don't know".
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;
export const FALLBACK_MAX_TOKENS = 16_384;


/**
 * The `compat` keys each protocol implementation actually reads, per pi protocol id. The table
 * exists so a key that can never reach the wire gets named: pi's request builder reads
 * `compat.<key>` itself, and its config schema does not fence membership (`ProviderCompatSchema`
 * is a union of the three per-family object schemas, each of which allows extra properties), so
 * an unread key — a cross-family copy, a typo, a key from another pi build — is accepted by
 * `models.json`, forwarded to nobody, and silently lost.
 *
 * Derived from `pi-ai/dist/api/<id>.js` plus every `dist/api/*.js` module it imports (a protocol
 * module mentions the keys its request path reads, helpers included). `tests/compat-keys-test.mjs`
 * re-derives the table from the installed pi and fails when it drifts, so it is a mirror of pi,
 * not a memory of one. An id absent here is one nobody measured — `inertCompatKeys` then says
 * nothing rather than guessing.
 */
export const API_COMPAT_KEYS: Record<string, readonly string[]> = {
	'anthropic-messages': ['allowEmptySignature', 'allowedFallbackModels', 'forceAdaptiveThinking', 'sendSessionAffinityHeaders', 'sessionAffinityFormat', 'supportsCacheControlOnTools', 'supportsEagerToolInputStreaming', 'supportsLongCacheRetention', 'supportsMidConvoEffort', 'supportsMidConvoSystemMessages', 'supportsMidConvoToolChanges', 'supportsStrictTools', 'supportsTemperature'],
	'openai-completions': ['cacheControlFormat', 'chatTemplateArgs', 'chatTemplateKwargs', 'maxTokensField', 'openRouterRouting', 'requiresAssistantAfterToolResult', 'requiresReasoningContentOnAssistantMessages', 'requiresThinkingAsText', 'requiresToolResultName', 'sendSessionAffinityHeaders', 'sessionAffinityFormat', 'supportsDeveloperRole', 'supportsFinishReason', 'supportsLongCacheRetention', 'supportsMidConvoSystemMessages', 'supportsMidConvoToolAdditions', 'supportsOpenAIGrammarTools', 'supportsReasoningEffort', 'supportsStore', 'supportsStrictMode', 'supportsThinkingTokenBudget', 'supportsUsageInStreaming', 'thinkingFormat', 'thinkingTokenBudgetField', 'vercelGatewayRouting', 'vllmPriority', 'zaiToolStream'],
	'openai-responses': ['sessionAffinityFormat', 'supportsAdditionalTools', 'supportsDeveloperRole', 'supportsExplicitPromptCacheMode', 'supportsLongCacheRetention', 'supportsMaxOutputTokens', 'supportsMidConvoSystemMessages', 'supportsOpenAIGrammarTools', 'supportsStrictMode', 'supportsToolSearch'],
	'openai-codex-responses': ['supportsAdditionalTools', 'supportsDeveloperRole', 'supportsMidConvoSystemMessages', 'supportsOpenAIGrammarTools', 'supportsStrictMode', 'supportsToolSearch'],
	'azure-openai-responses': ['supportsAdditionalTools', 'supportsDeveloperRole', 'supportsMidConvoSystemMessages', 'supportsOpenAIGrammarTools', 'supportsStrictMode', 'supportsToolSearch'],
	'google-generative-ai': [],
	'google-vertex': [],
	'mistral-conversations': ['supportsMidConvoSystemMessages'],
	'bedrock-converse-stream': ['supportsStrictMode'],
	'pi-messages': [],
};

/**
 * The `compat` keys in `compat` that `api`'s implementation never reads, sorted. An api this
 * table has not measured reports nothing: "no effect" is a claim that needs a read-set.
 */
export function inertCompatKeys(api: string, compat: Record<string, unknown> | undefined): string[] {
	const read = compat === undefined ? undefined : API_COMPAT_KEYS[api];
	if (!read) return [];
	const known = new Set(read);
	return Object.keys(compat as Record<string, unknown>)
		.filter((key) => !known.has(key))
		.sort();
}
