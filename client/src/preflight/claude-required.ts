import { DEFAULT_DISABLED_HARNESSES } from '../harnesses/engine/registry.js';
import { CLAUDE_CODE_HARNESS, canonicalHarnessNameSet } from '../harnesses/names.js';

export interface ClaudeAuthRequirementConfig {
  harnesses?: {
    disabled?: readonly string[];
    externalImpls?: readonly unknown[];
  };
}

export const CLAUDE_AUTH_REQUIRED_HARNESSES = [
  'legacy-claude',
  CLAUDE_CODE_HARNESS,
  'claude-mcp-hyperliquid',
  'claude-mcp-prediction',
  'claude-mcp-prediction-apy',
] as const;

export function configRequiresClaudeAuth(config: ClaudeAuthRequirementConfig): boolean {
  if ((config.harnesses?.externalImpls?.length ?? 0) > 0) {
    return true;
  }
  const disabled = canonicalHarnessNameSet(config.harnesses?.disabled ?? [...DEFAULT_DISABLED_HARNESSES]);
  return CLAUDE_AUTH_REQUIRED_HARNESSES.some((name) => !disabled.has(name));
}
