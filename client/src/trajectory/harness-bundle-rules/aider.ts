import * as path from 'node:path';
import { registerRule, type SnapshotRule } from './types.js';

/**
 * Aider harness-bundle snapshot rule.
 *
 * Files (per spec §3.2):
 *   - <repoRoot>/.aider.conf.yml  (project-level config; takes precedence)
 *   - ~/.aider.conf.yml           (user-level config)
 *
 * Aider has no skills/prompts directory analogue — the conf.yml drives
 * model + read-only files + pre/post commands; that's the whole knob set
 * a replayable bundle needs.
 */
export const aiderSnapshotRule: SnapshotRule = {
  tool: 'aider',
  async candidatePaths(input: { home: string; repoRoot?: string }): Promise<string[]> {
    const out: string[] = [];
    out.push(path.join(input.home, '.aider.conf.yml'));
    if (input.repoRoot) {
      out.push(path.join(input.repoRoot, '.aider.conf.yml'));
    }
    return out;
  },
};

registerRule(aiderSnapshotRule);
