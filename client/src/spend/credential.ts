import {
  CLAUDE_CODE_HARNESS,
  CODEX_HARNESS,
  HERMES_AGENT_HARNESS,
  canonicalHarnessName,
} from '../harnesses/names.js';

/** A credential identity. Format: `{provider}:{authMethod}`, e.g. `anthropic:api-key`. Never empty. */
export type CredentialId = string;

/**
 * Resolve which authentication credential a harness will bill against, from
 * the presence of provider env vars. Returns null when the harness makes no
 * paid LLM call (e.g. prediction harnesses) or no credential is recognisable.
 */
export function resolveCredentialId(
  harness: string | undefined,
  env: NodeJS.ProcessEnv,
): CredentialId | null {
  if (!harness) return null;
  switch (canonicalHarnessName(harness)) {
    case CLAUDE_CODE_HARNESS:
      // empty string treated as absent
      if (env['CLAUDE_CODE_OAUTH_TOKEN']) return 'anthropic:subscription';
      if (env['ANTHROPIC_API_KEY']) return 'anthropic:api-key';
      return null;
    case CODEX_HARNESS:
      if (env['OPENAI_API_KEY']) return 'openai:api-key';
      return 'openai:subscription';
    case HERMES_AGENT_HARNESS: {
      const provider = (env['JINN_HERMES_PROVIDER'] ?? 'hermes').trim().toLowerCase();
      return `${provider}:api-key`;
    }
    default:
      return null;
  }
}
