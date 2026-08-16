export const CLAUDE_CODE_HARNESS = 'claude-code';
export const CODEX_HARNESS = 'codex';
export const HERMES_AGENT_HARNESS = 'hermes-agent';

const HARNESS_ALIASES: Record<string, string> = {
  'claude-code-learner': CLAUDE_CODE_HARNESS,
  'codex-code-learner': CODEX_HARNESS,
};

const DISPLAY_NAMES: Record<string, string> = {
  [CLAUDE_CODE_HARNESS]: 'Claude Code',
  [CODEX_HARNESS]: 'Codex',
  [HERMES_AGENT_HARNESS]: 'Hermes Agent',
  'swe-rebench-v2-evaluator': 'SWE-rebench v2 Evaluator',
};

export function canonicalHarnessName(name: string | undefined): string {
  if (!name) return '';
  return HARNESS_ALIASES[name] ?? name;
}

export function harnessDisplayName(name: string | undefined): string {
  const canonical = canonicalHarnessName(name);
  return DISPLAY_NAMES[canonical] ?? canonical;
}

export function harnessOptionLabel(name: string, version?: string): string {
  const label = harnessDisplayName(name);
  return version ? `${label} ${version}` : label;
}

export function harnessNamesMatch(a: string | undefined, b: string | undefined): boolean {
  return canonicalHarnessName(a) === canonicalHarnessName(b);
}
