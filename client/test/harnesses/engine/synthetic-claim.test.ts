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

      const task: Task = {
        id: 't1',
        description: 'synthetic',
        solverType: 'swe-rebench-v2.v1',
        role: 'restoration',
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
        taskRole: 'restoration',
        task,
      });
      expect(accept.ok).toBe(false);
      if (!accept.ok) expect(accept.reason).toMatch(/minter/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
