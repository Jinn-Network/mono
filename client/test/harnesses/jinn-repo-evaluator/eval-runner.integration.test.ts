import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JinnRepoTaskSchema } from '../../../src/solver-types/jinn-repo.js';
import { runJinnRepoEval } from '../../../src/harnesses/impls/jinn-repo-evaluator/eval-runner.js';

const FIXTURE = join(__dirname, '../../fixtures/jinn-repo/Jinn-Network__mono-1108');
const RUN = process.env.JINN_E2E_JINN_REPO === '1';

describe.runIf(RUN)('runJinnRepoEval', () => {
  const task = JinnRepoTaskSchema.parse(JSON.parse(readFileSync(join(FIXTURE, 'task.json'), 'utf8')));

  it('PASS when the real solution patch is applied', async () => {
    const patch = readFileSync(join(FIXTURE, 'solution.patch'), 'utf8');
    const result = await runJinnRepoEval({ task, patch, monoRepoUrl: process.env.JINN_MONO_REMOTE ?? 'https://github.com/Jinn-Network/mono.git' });
    expect(result.unscorable).toBe(false);
    expect(result.passed).toBe(true);
  }, 600_000);

  it('FAIL when an empty/wrong patch is applied', async () => {
    const patch = readFileSync(join(FIXTURE, 'bad.patch'), 'utf8');
    const result = await runJinnRepoEval({ task, patch, monoRepoUrl: process.env.JINN_MONO_REMOTE ?? 'https://github.com/Jinn-Network/mono.git' });
    expect(result.unscorable).toBe(false);
    expect(result.passed).toBe(false);
  }, 600_000);
});
