export const CLAUDE_CODE_HARNESS = 'claude-code';
export const CODEX_HARNESS = 'codex';
export const HERMES_AGENT_HARNESS = 'hermes-agent';

const HARNESS_ALIASES: Record<string, string> = {
  'claude-code-learner': CLAUDE_CODE_HARNESS,
  'codex-code-learner': CODEX_HARNESS,
};

export function canonicalHarnessName(name: string): string {
  return HARNESS_ALIASES[name] ?? name;
}

export function harnessNameMatches(candidate: string, requested: string): boolean {
  return canonicalHarnessName(candidate) === canonicalHarnessName(requested);
}

export function canonicalHarnessNameSet(names: readonly string[]): Set<string> {
  return new Set(names.map((name) => canonicalHarnessName(name)));
}

export function harnessStateDirName(name: string): string {
  const canonical = canonicalHarnessName(name);
  if (canonical === CLAUDE_CODE_HARNESS) return 'claude-code-learner';
  if (canonical === CODEX_HARNESS) return 'codex-code-learner';
  if (canonical === HERMES_AGENT_HARNESS) return 'hermes-agent';
  return canonical;
}
