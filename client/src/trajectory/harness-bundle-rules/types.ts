/**
 * Per-tool snapshot rule. Each rule, given the operator's home (and optional
 * repo root), returns the absolute paths to read into the harness-bundle
 * for one tool.
 *
 * Spec: spec/2026-05-07-telemetry-collector-and-task-generator.md §3.2.
 */
export interface SnapshotRule {
  /** Tool brand. Must match the TranscriptParser.tool union from Task 3.1. */
  readonly tool:
    | 'claude-code'
    | 'codex'
    | 'gemini-cli'
    | 'cursor'
    | 'aider'
    | 'continue';

  /**
   * Returns absolute paths the assembler should attempt to include in the
   * bundle. The assembler applies the operator's `allowedDirectories` filter
   * after this call — the rule itself returns the FULL set of candidates.
   * Paths that don't exist on disk are silently skipped at assembly time.
   */
  candidatePaths(input: { home: string; repoRoot?: string }): Promise<string[]>;
}

const registry = new Map<SnapshotRule['tool'], SnapshotRule>();

export function registerRule(rule: SnapshotRule): void {
  registry.set(rule.tool, rule);
}

export function getRule(tool: SnapshotRule['tool']): SnapshotRule {
  const rule = registry.get(tool);
  if (!rule) throw new Error(`No snapshot rule registered for tool: ${tool}`);
  return rule;
}

/** For tests; clears all registrations. */
export function clearRegistry(): void {
  registry.clear();
}
