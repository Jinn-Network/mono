import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// This fixture is a real merged-PR instance (gold test_files/test_cmd) — parse
// via the merged-pr branch schema directly rather than the general union.
import { JinnRepoMergedPrTaskSchema } from '../../../src/solver-types/jinn-repo.js';
import { runJinnRepoEval } from '../../../src/harnesses/impls/jinn-repo-evaluator/eval-runner.js';
import { validateAdmissible } from '../../../src/solver-types/jinn-repo-admit.js';
import type { JinnRepoPoolItem } from '../../../src/solver-types/_jinn-repo-pool.js';

// __dirname is not defined in ESM; derive it from import.meta.url instead.
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const FIXTURE = join(__dirname, '../../fixtures/jinn-repo/Jinn-Network__mono-1108');
const RUN = process.env.JINN_E2E_JINN_REPO === '1';

function readGold(dir: string, paths: string[]): Record<string, string> {
  const g: Record<string, string> = {};
  for (const p of paths) g[p] = readFileSync(join(dir, 'gold-test', p), 'utf8');
  return g;
}

describe.runIf(RUN)('runJinnRepoEval', () => {
  const task = JinnRepoMergedPrTaskSchema.parse(JSON.parse(readFileSync(join(FIXTURE, 'task.json'), 'utf8')));
  const goldTests = readGold(FIXTURE, task.test_files);

  it('PASS when the real solution patch is applied', async () => {
    const patch = readFileSync(join(FIXTURE, 'solution.patch'), 'utf8');
    const result = await runJinnRepoEval({ task, patch, goldTests, monoRepoUrl: process.env.JINN_MONO_REMOTE ?? 'https://github.com/Jinn-Network/mono.git' });
    expect(result.unscorable).toBe(false);
    expect(result.passed).toBe(true);
  }, 600_000);

  it('FAIL when an empty/wrong patch is applied', async () => {
    const patch = readFileSync(join(FIXTURE, 'bad.patch'), 'utf8');
    const result = await runJinnRepoEval({ task, patch, goldTests, monoRepoUrl: process.env.JINN_MONO_REMOTE ?? 'https://github.com/Jinn-Network/mono.git' });
    expect(result.unscorable).toBe(false);
    expect(result.passed).toBe(false);
  }, 600_000);

  it('ADMITS the real fixture via the FAIL_TO_PASS double-run gate', async () => {
    const item: JinnRepoPoolItem = {
      ...task,
      gold_tests: goldTests,
      solution_patch: readFileSync(join(FIXTURE, 'solution.patch'), 'utf8'),
    };
    const monoRepoUrl = process.env.JINN_MONO_REMOTE ?? 'https://github.com/Jinn-Network/mono.git';
    const verdict = await validateAdmissible(item, { run: runJinnRepoEval, monoRepoUrl });
    expect(verdict.admitted).toBe(true);
  }, 1_200_000);
});
