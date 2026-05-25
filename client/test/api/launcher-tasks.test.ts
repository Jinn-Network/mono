/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { gatherLauncherTasks } from '../../src/api/launcher-tasks.js';
import type { JinnConfig } from '../../src/config.js';

describe('gatherLauncherTasks', () => {
  it('labels posted tasks by joinedSolverNets display name when no solverNet is recorded', async () => {
    const config = {
      joinedSolverNets: {
        'legacy:swe-rebench-v2': {
          manifestCid: 'legacy:swe-rebench-v2',
          name: 'swe-rebench-v2',
          contract: { id: 'swe-rebench-v2', version: 'v1' },
          roles: ['solver'],
          plugins: [],
          disabledDefaultPlugins: [],
        },
      },
    } as unknown as JinnConfig;
    const response = await gatherLauncherTasks({
      config,
      creatorAddress: '0xabc',
      fetchPostedTasks: () => [
        {
          taskId: 't1',
          taskCid: 'cid1',
          solverType: 'swe-rebench-v2.v1',
          postedAt: '2026-05-25T00:00:00Z',
          budget: { totalWei: '0' },
        },
      ],
    });
    expect(response.tasks[0]?.solverNet).toBe('swe-rebench-v2');
  });

  it('falls through to "unknown" when no joined entry matches the posted task solverType', async () => {
    const config = {
      joinedSolverNets: {},
    } as unknown as JinnConfig;
    const response = await gatherLauncherTasks({
      config,
      creatorAddress: '0xabc',
      fetchPostedTasks: () => [
        {
          taskId: 't1',
          taskCid: 'cid1',
          solverType: 'unknown.v0',
          postedAt: '2026-05-25T00:00:00Z',
          budget: { totalWei: '0' },
        },
      ],
    });
    expect(response.tasks[0]?.solverNet).toBe('unknown');
  });
});
