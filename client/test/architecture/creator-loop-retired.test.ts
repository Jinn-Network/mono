/**
 * Wave-4 D3 guard (Task 17 of
 * `docs/superpowers/plans/2026-07-30-cutover-stage-3-posting-flow.md`,
 * DR-2026-08-05 decision 1).
 *
 * The legacy creator loop, its task-source stack, and the launched-record
 * generator dispatcher are deleted. The native replacement is the posting loop
 * over `posting[]` (`client/src/daemon/posting-loop.ts`). This guard exists so
 * a later revert cannot quietly resurrect a second posting stack alongside it.
 *
 * Two deliberate deviations from the plan's literal file list, both recorded in
 * the PR body:
 *
 *   - `client/src/tasks/posting-service.ts` SURVIVES. It is Task 19's to
 *     delete, and Task 19 has not landed: `jinn tasks submit` still posts
 *     through `TaskPostingService.postCandidate`
 *     (`client/src/cli/commands/tasks.ts`), and `client/src/tasks/submit-preflight.ts`
 *     — Task 19's other deletion — is still on the branch. Deleting it here
 *     would break the live CLI submit path.
 *   - `client/src/tasks/sources.ts` is deleted by CARVE, not wholesale. Its
 *     `TaskGenerator` type has four out-of-retirement-scope consumers under
 *     `client/src/solver-types/`, so it re-homes to `solver-type.ts`; the
 *     posting-service's two candidate types re-home into the posting service.
 *     Only the creator-loop-only exports die.
 *
 * `LOOP_REGISTRY` still declares `creator`: the registry narrowing is D6's
 * scope, not D3's (DR-2026-08-05 addendum 2026-08-13, decision 3).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LOOP_REGISTRY } from '../../src/daemon/loop-heartbeat.js';

const retired = [
  '../../src/daemon/creator.ts',
  '../../src/tasks/sources.ts',
  '../../src/solvernets/launched-record-dispatcher.ts',
  '../../test/daemon/creator.test.ts',
  '../../test/tasks/sources.test.ts',
  '../../test/main/launched-record-dispatcher.test.ts',
];

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');
}

describe('creator loop retirement (Wave-4 D3)', () => {
  for (const relative of retired) {
    it(`${relative} is deleted`, () => {
      expect(existsSync(fileURLToPath(new URL(relative, import.meta.url)))).toBe(false);
    });
  }

  it('the daemon no longer references CreatorLoop or a task-source stack', () => {
    const daemon = read('../../src/daemon/daemon.ts');
    expect(daemon).not.toContain('CreatorLoop');
    expect(daemon).not.toContain('TaskSource');
    expect(daemon).not.toContain('taskSources');
  });

  it('main.ts no longer builds task sources or wires launched-record generators', () => {
    const main = read('../../src/main.ts');
    expect(main).not.toContain('tasks/sources.js');
    expect(main).not.toContain('launched-record-dispatcher.js');
    expect(main).not.toContain('wireLaunchedRecordGenerators');
    expect(main).not.toContain('taskSources');
  });

  it('no surviving client source imports the deleted task-source module', () => {
    for (const relative of [
      '../../src/tasks/posting-service.ts',
      '../../src/solver-types/solver-type.ts',
      '../../src/solver-types/swe-rebench-v2.ts',
      '../../src/solver-types/jinn-repo-auto.ts',
      '../../src/solver-types/jinn-repo-live-auto.ts',
    ]) {
      expect(read(relative)).not.toContain('tasks/sources.js');
    }
  });

  it('the CLI submit path keeps its posting service (Task 19 owns that deletion)', () => {
    expect(existsSync(fileURLToPath(new URL('../../src/tasks/posting-service.ts', import.meta.url))))
      .toBe(true);
    expect(read('../../src/cli/commands/tasks.ts')).toContain('TaskPostingService');
  });

  it('the loop registry still declares creator (D6 owns the narrowing) and declares posting', () => {
    const names = LOOP_REGISTRY.map((row) => row.name);
    expect(names).toContain('creator');
    expect(names).toContain('posting');
  });
});
