/**
 * Utilities for normalizing Gemini model names across dispatch and execution.
 *
 * Context:
 * - Gemini 3 models are exposed as preview variants (e.g., gemini-3-pro-preview).
 * - Some callers (or legacy jobs) may specify non-preview names like gemini-3-pro,
 *   which can produce 404 errors from the Gemini API / Gemini CLI.
 */

export const DEFAULT_WORKER_MODEL = 'gemini-3-flash';

/**
 * Models currently available on the Gemini API.
 * Used as an enum constraint in dispatch tools to prevent agents from
 * hallucinating model names from training data.
 */
export const AVAILABLE_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
] as const;

export type AvailableModel = typeof AVAILABLE_MODELS[number];

const MODELS_PREFIX = 'models/';

/**
 * Map legacy / commonly-mistyped model names to the currently valid equivalents.
 * Keep this intentionally small and explicit.
 */
const LEGACY_MODEL_ALIASES: Record<string, string> = {
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-3-pro-latest': 'gemini-3-pro-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3-flash-latest': 'gemini-3-flash-preview',
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3.1-flash-lite': 'gemini-3.1-flash-lite-preview',
  // Deprecated experimental models - agent LLMs sometimes suggest these from training data
  'gemini-2.0-flash-thinking-exp-1219': 'gemini-3-flash',
  'gemini-2.0-flash-thinking-exp': 'gemini-3-flash',
  'gemini-2.0-flash-exp': 'gemini-3-flash',
  // Gemini 2.0 Flash variants — removed from Google API as of Feb 2026
  'gemini-2.0-flash-001': 'gemini-3-flash',
  'gemini-2.0-flash': 'gemini-3-flash',
  // Gemini 2.0 Pro experimental variants — removed from Google API as of Feb 2026
  'gemini-2.0-pro-exp-02-05': 'gemini-3-flash',
  'gemini-2.0-pro-exp': 'gemini-3-flash',
};

/**
 * Models that have been deprecated or removed from the Gemini API.
 * These will be rejected at dispatch time with a helpful suggestion.
 */
const DEPRECATED_MODELS = new Set([
  'gemini-2.0-flash-thinking-exp-1219',
  'gemini-2.0-flash-thinking-exp-01-21',
  'gemini-2.0-flash-thinking-exp',
  'gemini-2.0-flash-thinking',
  // Gemini 2.0 Flash variants — removed from Google API as of Feb 2026
  'gemini-2.0-flash-001',
  'gemini-2.0-flash',
  // Gemini 2.0 Pro experimental variants — removed from Google API as of Feb 2026
  'gemini-2.0-pro-exp-02-05',
  'gemini-2.0-pro-exp',
]);

/**
 * Canonical (normalized) model IDs confirmed to work against the current Gemini API.
 * Used as a fallback gate when no explicit allowedModels policy is configured.
 * Only normalized names belong here — aliases resolve via normalizeGeminiModel() first.
 */
export const KNOWN_VALID_MODELS = new Set([
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
]);

/**
 * Check if a normalized model ID is in the known-valid set.
 * Input must already be normalized via normalizeGeminiModel().
 */
export function isKnownValidModel(normalizedModel: string): boolean {
  return KNOWN_VALID_MODELS.has(normalizedModel);
}

/**
 * Check if a model matches any deprecated pattern (e.g., gemini-2.0-flash-thinking-exp-*)
 */
function matchesDeprecatedPattern(model: string): boolean {
  // All gemini-2.0-flash variants are removed from Google API as of Feb 2026
  if (model.startsWith('gemini-2.0-flash')) {
    return true;
  }
  // All gemini-2.0-pro-exp experimental models are deprecated
  if (model.startsWith('gemini-2.0-pro-exp')) {
    return true;
  }
  return false;
}

export type ModelValidationResult = {
  ok: boolean;
  reason?: string;
  suggestion?: string;
};

/**
 * Check if a model is valid and not deprecated.
 * Deprecated models are rejected with a suggestion for a valid alternative.
 */
export function validateModelAllowed(model: string): ModelValidationResult {
  const stripped = stripModelsPrefix(model.trim());

  // Check if the model or its normalized form is deprecated (exact match or pattern)
  if (DEPRECATED_MODELS.has(model) || DEPRECATED_MODELS.has(stripped) || matchesDeprecatedPattern(stripped)) {
    return {
      ok: false,
      reason: `Model '${model}' is deprecated and no longer available`,
      suggestion: DEFAULT_WORKER_MODEL,
    };
  }

  return { ok: true };
}

export type GeminiModelNormalization = {
  requested: string;
  normalized: string;
  changed: boolean;
  reason?: string;
};

function stripModelsPrefix(model: string): string {
  return model.startsWith(MODELS_PREFIX) ? model.slice(MODELS_PREFIX.length) : model;
}

/**
 * Normalize a Gemini model name for Gemini CLI usage.
 *
 * This:
 * - trims whitespace
 * - removes a leading "models/" prefix if present
 * - upgrades known Gemini 3 legacy names to their preview equivalents
 * - falls back to a safe default when the input is empty
 */
export function normalizeGeminiModel(
  model: string | null | undefined,
  defaultModel: string = DEFAULT_WORKER_MODEL,
): GeminiModelNormalization {
  const requestedRaw = (model ?? '').trim();
  const requested = requestedRaw.length > 0 ? requestedRaw : defaultModel;
  const stripped = stripModelsPrefix(requested);
  const aliasTarget = LEGACY_MODEL_ALIASES[stripped];

  if (aliasTarget) {
    return {
      requested,
      normalized: aliasTarget,
      changed: aliasTarget !== requested,
      reason: `legacy_alias:${stripped}`,
    };
  }

  // Catch-all: any gemini-2.0-flash variant not in the explicit map
  if (stripped.startsWith('gemini-2.0-flash')) {
    return {
      requested,
      normalized: 'gemini-3-flash',
      changed: true,
      reason: `legacy_pattern:${stripped}`,
    };
  }

  if (stripped !== requested) {
    return {
      requested,
      normalized: stripped,
      changed: true,
      reason: 'strip_models_prefix',
    };
  }

  return {
    requested,
    normalized: stripped,
    changed: false,
  };
}

export type ModelSelectionResult = {
  selected: string;
  reason: 'requested' | 'policy_fallback';
};

/**
 * Select a Gemini model with policy enforcement.
 * Used by the worker execution layer — silently falls back to the policy default
 * rather than rejecting (contrast with the hard-reject gate in dispatch tools).
 */
export function selectGeminiModelWithPolicy(
  requestedModel: string,
  policy: { allowedModels: string[]; defaultModel: string },
  systemDefault: string = DEFAULT_WORKER_MODEL,
): ModelSelectionResult {
  const normalized = normalizeGeminiModel(requestedModel, systemDefault).normalized;

  if (policy.allowedModels.length > 0) {
    const allowedSet = new Set(policy.allowedModels.map(m =>
      normalizeGeminiModel(m, systemDefault).normalized
    ));
    if (allowedSet.has(normalized)) return { selected: normalized, reason: 'requested' };
    return { selected: normalizeGeminiModel(policy.defaultModel, systemDefault).normalized, reason: 'policy_fallback' };
  }

  // No explicit policy — use KNOWN_VALID_MODELS as fallback
  if (isKnownValidModel(normalized)) return { selected: normalized, reason: 'requested' };
  return { selected: normalizeGeminiModel(policy.defaultModel, systemDefault).normalized, reason: 'policy_fallback' };
}
