/**
 * Wave-4 D3 guard (Task 18 of
 * `docs/superpowers/plans/2026-07-30-cutover-stage-3-posting-flow.md`,
 * DR-2026-08-05 decision 1).
 *
 * The SolverNet lifecycle-transition PRODUCER retires: the state machine that
 * broadcast `setMetadata` pause/resume/retire transitions, its daemon-startup
 * recovery scan, its API route, and the launch state machine's generator-spawn
 * side effect. The operator-facing replacement for pause/retire is
 * `posting[].enabled` plus the work client's close (headless design §4.2).
 *
 * The lifecycle WIRE VOCABULARY stays: `LaunchedSolverNetRecord.status`,
 * `lifecycleProgress`, `generatorEnabled`, the `spawning` launch phase, the
 * `encodeLifecyclePayload` encoder, and the most-recent-wins resolver are all
 * still parsed by surviving consumers, so records written by any prior daemon
 * generation still validate. `generatorEnabled` in particular is a REQUIRED
 * field of `LaunchedSolverNetRecordSchema` (`client/src/solvernets/store.ts`),
 * so `launch()` must keep writing it — this guard asserts the producer legs are
 * gone, not that the vocabulary is.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function path(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

function read(relative: string): string {
  return readFileSync(path(relative), 'utf-8');
}

const surviving = [
  '../../src/api/solvernets-endpoints.ts',
  '../../src/solvernets/launch-state-machine.ts',
  '../../src/solvernets/daemon-init.ts',
  '../../src/main.ts',
];

describe('lifecycle publishing retirement (Wave-4 D3)', () => {
  it('the lifecycle-transitions module and its test are deleted', () => {
    expect(existsSync(path('../../src/solvernets/lifecycle-transitions.ts'))).toBe(false);
    expect(existsSync(path('../../test/solvernets/lifecycle-transitions.test.ts'))).toBe(false);
  });

  it('no surviving module imports it', () => {
    for (const relative of surviving) {
      expect(read(relative)).not.toContain('lifecycle-transitions');
    }
  });

  it('the launch state machine no longer spawns generators', () => {
    const source = read('../../src/solvernets/launch-state-machine.ts');
    expect(source).not.toContain('launched-record-dispatcher');
    expect(source).not.toContain('spawnGenerator');
  });

  it('the API no longer exposes a lifecycle-transition route', () => {
    const endpoints = read('../../src/api/solvernets-endpoints.ts');
    expect(endpoints).not.toContain('/lifecycle');
    expect(endpoints).not.toContain('lifecycleTransition');
  });

  it('the lifecycle wire vocabulary survives for record consumers', () => {
    const store = read('../../src/solvernets/store.ts');
    expect(store).toContain('lifecycleProgress');
    expect(store).toContain('generatorEnabled');
    expect(read('../../src/solvernets/most-recent-wins.ts')).toContain('SetMetadataLifecyclePayload');
  });
});
