import { describe, expect, it } from 'vitest';
import { TaskEngine } from '../../../src/harnesses/engine/engine.js';
import { Store } from '../../../src/store/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '../../src/types/task.js';

describe('TaskEngine synthetic claim filter', () => {
  it('rejects minter claiming own synthetic mint via operatorSafeAddress', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engine-synth-'));
    try {
      const store = new Store(join(dir, 'jinn.db'));
      const engine = new TaskEngine({
        store,
        paths: { workingDirRoot: join(dir, 'work'), implStateDirRoot: join(dir, 'impl') },
        operatorSafeAddress: '0xAbc',
        implRegistry: {
          findFor: () => ({
            name: 'stub',
            version: '1',
            canAttempt: async () => ({ ok: true }),
            isReady: async () => ({ ready: true }),
            run: async () => { throw new Error('not reached'); },
          }),
        },
      });

      // Cutover stage 1 (docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md
      // Task 16): canAcceptTask({ taskRole: 'restoration', ... }) is now always refused
      // before the synthetic-claim filter runs (see
      // test/daemon/solution-path-retired.test.ts). syntheticClaimBlocked() is
      // role-agnostic (it runs whenever a task + operatorSafeAddress are present,
      // irrespective of role), so this probe now uses taskRole: 'evaluation' — the
      // identical code path, still reachable.
      const task: Task = {
        id: 't1',
        description: 'synthetic',
        solverType: 'swe-rebench-v2.v1',
        role: 'evaluation',
        eligibility: {
          syntheticProvenance: {
            synthetic: true,
            mintFamily: 'commit-echo',
            sourceLineageHash: 'sha256:x',
            minterSafe: '0xabc',
          },
        },
      };

      const accept = await engine.canAcceptTask({
        solverType: 'swe-rebench-v2.v1',
        taskRole: 'evaluation',
        task,
      });
      expect(accept.ok).toBe(false);
      if (!accept.ok) expect(accept.reason).toMatch(/minter/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
