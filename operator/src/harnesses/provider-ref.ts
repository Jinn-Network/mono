// operator/src/harnesses/provider-ref.ts
//
// Shared, zero-dependency `ProviderRef` shape for routing a harness model
// through a named provider or a custom OpenAI-compatible endpoint.
//
// Lives under `harnesses/` (NOT the SPA tree) so BOTH the server and the SPA
// can import it — the SPA already cross-imports `harnesses/cost-estimates.js`.
// It MUST NOT import zod: pulling zod into the SPA bundle is a non-starter. The
// zod validator lives server-side in `config.ts`; the join endpoint validates
// the same shape by hand.

/**
 * How a harness (currently Hermes) reaches a model provider.
 *
 * - String form — a named provider Hermes already knows (`openrouter`,
 *   `anthropic`, `openai`, …). Persisted verbatim; passed as `--provider <name>`.
 * - Object form — a custom OpenAI-compatible endpoint. `name` is the provider
 *   label; `baseUrl` overrides the endpoint; `authVar` names the env var holding
 *   the credential (used when the key does not match the adapter's
 *   `_API_KEY` / `_TOKEN` allowlist pattern).
 */
export type ProviderRef =
  | string
  | { name: string; baseUrl?: string; authVar?: string };

/** The provider name for either form; `undefined` when no ref is set. */
export function providerRefName(ref: ProviderRef | undefined): string | undefined {
  if (ref === undefined) return undefined;
  return typeof ref === 'string' ? ref : ref.name;
}

/** The custom base URL for the object form; `undefined` otherwise. */
export function providerRefBaseUrl(ref: ProviderRef | undefined): string | undefined {
  if (ref === undefined || typeof ref === 'string') return undefined;
  return ref.baseUrl;
}

/** The credential env-var name for the object form; `undefined` otherwise. */
export function providerRefAuthVar(ref: ProviderRef | undefined): string | undefined {
  if (ref === undefined || typeof ref === 'string') return undefined;
  return ref.authVar;
}

/**
 * OpenRouter model-id shape (`<org>/<model>`). Shared so the load-time backfill
 * (`config.ts`) and the adapter's inference bridge (`hermes-agent/adapter.ts`)
 * stamp/route exactly the same ids without drifting out of sync (issue #1243).
 */
export const OPENROUTER_MODEL_FORMAT = /^[a-z0-9_-]+\/[a-z0-9_.\-:]+$/i;

/** Whether `id` is an OpenRouter-shaped `<org>/<model>` model id. */
export function isOpenRouterModelId(id: string | undefined): boolean {
  return typeof id === 'string' && OPENROUTER_MODEL_FORMAT.test(id);
}
