/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import { gatherLauncherTasks } from '../../src/api/launcher-tasks.js';
import type { JinnConfig } from '../../src/config.js';
import type { TaskStatusSnapshot } from '../../src/archive/types.js';

const SWE_WIRING = {
  workKind: 'swe-rebench-v2.v1',
  harness: 'claude-code',
  model: 'claude-haiku-4-5-20251001',
  plugins: [],
  credentialRef: 'claude-code-default',
  isolationPolicy: 'process' as const,
  legacyManifestDigest: 'bafymanifest',
};

describe('gatherLauncherTasks', () => {
  it('labels posted tasks by executionWiring workKind when no solverNet is recorded', async () => {
    const config = {
      executionWiring: [SWE_WIRING],
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
    expect(response.tasks[0]?.solverNet).toBe('swe-rebench-v2.v1');
  });

  it('falls through to "unknown" when no wiring entry matches the posted task solverType', async () => {
    const config = {
      executionWiring: [],
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

describe('gatherLauncherTasks — onchainStatus chip (#579)', () => {
  // now() returns ms; claimWindowEnd is unix seconds. 2026-06-14 ≈ 1_780_000_000s.
  const NOW_MS = 1_780_000_000_000;
  const config = {
    executionWiring: [SWE_WIRING],
  } as unknown as JinnConfig;

  function makeDeps(
    statusByTaskId: Record<string, TaskStatusSnapshot>,
    fetchTaskStatuses?: (cid: string) => Promise<Map<string, TaskStatusSnapshot>>,
  ) {
    return {
      config,
      creatorAddress: '0xabc',
      now: () => NOW_MS,
      fetchPostedTasks: () =>
        Object.keys(statusByTaskId).length === 0
          ? [{ taskId: 'tabsent', taskCid: 'cidA', postedAt: '2026-05-25T00:00:00Z', budget: { totalWei: '0' } }]
          : Object.keys(statusByTaskId).map((taskId) => ({
              taskId,
              taskCid: `cid-${taskId}`,
              postedAt: '2026-05-25T00:00:00Z',
              budget: { totalWei: '0' },
            })),
      fetchTaskStatuses:
        fetchTaskStatuses ??
        (async () => new Map(Object.entries(statusByTaskId))),
    };
  }

  it('renders finalized when the snapshot is finalized', async () => {
    const deps = makeDeps({ t1: { taskId: 't1', finalized: true, refunded: false } });
    const response = await gatherLauncherTasks(deps);
    expect(response.tasks[0]?.onchainStatus).toBe('finalized');
  });

  it('renders finalized when the snapshot is refunded (on-chain-closed)', async () => {
    const deps = makeDeps({ t1: { taskId: 't1', finalized: false, refunded: true } });
    const response = await gatherLauncherTasks(deps);
    expect(response.tasks[0]?.onchainStatus).toBe('finalized');
  });

  it('renders expired when not finalized and the claim window is in the past', async () => {
    const deps = makeDeps({
      t1: { taskId: 't1', finalized: false, refunded: false, claimWindowEnd: 1_700_000_000 },
    });
    const response = await gatherLauncherTasks(deps);
    expect(response.tasks[0]?.onchainStatus).toBe('expired');
  });

  it('renders open when not finalized and the claim window is in the future', async () => {
    const deps = makeDeps({
      t1: { taskId: 't1', finalized: false, refunded: false, claimWindowEnd: 1_790_000_000 },
    });
    const response = await gatherLauncherTasks(deps);
    expect(response.tasks[0]?.onchainStatus).toBe('open');
  });

  it('renders unknown when the claim window is missing (does not guess open)', async () => {
    const deps = makeDeps({ t1: { taskId: 't1', finalized: false, refunded: false } });
    const response = await gatherLauncherTasks(deps);
    expect(response.tasks[0]?.onchainStatus).toBe('unknown');
  });

  it('renders unknown when the claim window is invalid (does not guess open)', async () => {
    const deps = makeDeps({
      t1: {
        taskId: 't1',
        finalized: false,
        refunded: false,
        claimWindowEnd: Number.NaN,
      },
    });
    const response = await gatherLauncherTasks(deps);
    expect(response.tasks[0]?.onchainStatus).toBe('unknown');
  });

  it('renders open when now exactly equals claimWindowEnd', async () => {
    const deps = makeDeps({
      t1: { taskId: 't1', finalized: false, refunded: false, claimWindowEnd: 1_780_000_000 },
    });
    const response = await gatherLauncherTasks(deps);
    expect(response.tasks[0]?.onchainStatus).toBe('open');
  });

  it('renders unknown when no snapshot exists for the taskId', async () => {
    const deps = makeDeps({}); // fetchPostedTasks yields 'tabsent', statuses empty
    const response = await gatherLauncherTasks(deps);
    expect(response.tasks[0]?.onchainStatus).toBe('unknown');
  });

  it('renders unknown for every task when fetchTaskStatuses throws (graceful degradation)', async () => {
    const deps = makeDeps(
      { t1: { taskId: 't1', finalized: true, refunded: false } },
      async () => { throw new Error('indexer down'); },
    );
    const response = await gatherLauncherTasks(deps);
    expect(response.tasks[0]?.onchainStatus).toBe('unknown');
  });

  it('renders unknown for every task when no fetchTaskStatuses dep is supplied', async () => {
    const response = await gatherLauncherTasks({
      config,
      creatorAddress: '0xabc',
      now: () => NOW_MS,
      fetchPostedTasks: () => [
        { taskId: 't1', taskCid: 'cid1', postedAt: '2026-05-25T00:00:00Z', budget: { totalWei: '0' } },
      ],
    });
    expect(response.tasks[0]?.onchainStatus).toBe('unknown');
  });

  it('keys the status lookup by protocolTaskId, not the off-chain display taskId (#579)', async () => {
    // Production keyspace mismatch: the posted record's display `taskId` is an
    // off-chain UUID/slug, while the indexer status map is keyed by the on-chain
    // decimal taskId. The record carries that on-chain id as `protocolTaskId`.
    const ONCHAIN_ID = '12345678901234567890';
    const deps = {
      config,
      creatorAddress: '0xabc',
      now: () => NOW_MS,
      fetchPostedTasks: () => [
        {
          taskId: 'b3f1c2a4-0000-4000-8000-000000000000', // off-chain UUID
          protocolTaskId: ONCHAIN_ID, // on-chain decimal id
          taskCid: 'cid1',
          postedAt: '2026-05-25T00:00:00Z',
          budget: { totalWei: '0' },
        },
      ],
      // Status map keyed by the on-chain id, as the live indexer keys it.
      fetchTaskStatuses: async () =>
        new Map<string, TaskStatusSnapshot>([
          [ONCHAIN_ID, { taskId: ONCHAIN_ID, finalized: true, refunded: false }],
        ]),
    };
    const response = await gatherLauncherTasks(deps);
    expect(response.tasks[0]?.onchainStatus).toBe('finalized');
  });

  it('falls back to the display taskId when protocolTaskId is absent (older/test rows)', async () => {
    // No protocolTaskId on the record; the status map is keyed by the display
    // taskId. The fallback keeps these rows resolving correctly.
    const deps = {
      config,
      creatorAddress: '0xabc',
      now: () => NOW_MS,
      fetchPostedTasks: () => [
        { taskId: 't1', taskCid: 'cid1', postedAt: '2026-05-25T00:00:00Z', budget: { totalWei: '0' } },
      ],
      fetchTaskStatuses: async () =>
        new Map<string, TaskStatusSnapshot>([
          ['t1', { taskId: 't1', finalized: true, refunded: false }],
        ]),
    };
    const response = await gatherLauncherTasks(deps);
    expect(response.tasks[0]?.onchainStatus).toBe('finalized');
  });

  it('dedupes manifest cids and calls fetchTaskStatuses once per cid', async () => {
    const fetchTaskStatuses = vi.fn(
      async () => new Map([['t1', { taskId: 't1', finalized: true, refunded: false }]]),
    );
    const deps = {
      config,
      creatorAddress: '0xabc',
      now: () => NOW_MS,
      fetchPostedTasks: () => [
        { taskId: 't1', taskCid: 'cid1', postedAt: '2026-05-25T00:00:00Z', budget: { totalWei: '0' } },
      ],
      fetchTaskStatuses,
    };
    await gatherLauncherTasks(deps);
    expect(fetchTaskStatuses).toHaveBeenCalledTimes(1);
    expect(fetchTaskStatuses).toHaveBeenCalledWith('bafymanifest');
  });

  it('scopes status lookup to legacyManifestDigest matching the current page solver type', async () => {
    const fetchTaskStatuses = vi.fn(
      async () => new Map([['t1', { taskId: 't1', finalized: true, refunded: false }]]),
    );
    const response = await gatherLauncherTasks({
      config: {
        executionWiring: [
          {
            workKind: 'other.v1',
            harness: 'claude-code',
            model: 'claude-haiku-4-5-20251001',
            plugins: [],
            credentialRef: 'claude-code-default',
            isolationPolicy: 'process',
            legacyManifestDigest: 'bafy-unrelated',
          },
          {
            ...SWE_WIRING,
            legacyManifestDigest: 'bafy-current',
          },
        ],
      } as unknown as JinnConfig,
      creatorAddress: '0xabc',
      now: () => NOW_MS,
      fetchPostedTasks: () => [
        {
          taskId: 't1',
          taskCid: 'cid1',
          solverType: 'swe-rebench-v2.v1',
          postedAt: '2026-05-25T00:00:00Z',
          budget: { totalWei: '0' },
        },
      ],
      fetchTaskStatuses,
    });

    expect(fetchTaskStatuses).toHaveBeenCalledTimes(1);
    expect(fetchTaskStatuses).toHaveBeenCalledWith('bafy-current');
    expect(response.tasks[0]?.onchainStatus).toBe('finalized');
  });

  it('uses the provided launched manifest CID for statuses even when not wired', async () => {
    const fetchTaskStatuses = vi.fn(
      async () => new Map([['t1', { taskId: 't1', finalized: true, refunded: false }]]),
    );
    const response = await gatherLauncherTasks(
      {
        config: { executionWiring: [] } as unknown as JinnConfig,
        creatorAddress: '0xabc',
        now: () => NOW_MS,
        fetchPostedTasks: () => [
          { taskId: 't1', taskCid: 'cid1', postedAt: '2026-05-25T00:00:00Z', budget: { totalWei: '0' } },
        ],
        fetchTaskStatuses,
      },
      { manifestCid: 'bafy-owned-launch' },
    );

    expect(fetchTaskStatuses).toHaveBeenCalledTimes(1);
    expect(fetchTaskStatuses).toHaveBeenCalledWith('bafy-owned-launch');
    expect(response.tasks[0]?.onchainStatus).toBe('finalized');
  });

  it('prefers the provided launched manifest CID instead of fanning out wiring memberships', async () => {
    const fetchTaskStatuses = vi.fn(
      async (cid: string) =>
        new Map([
          [
            't1',
            {
              taskId: 't1',
              finalized: cid === 'bafy-launched',
              refunded: false,
              claimWindowEnd: 1_790_000_000,
            },
          ],
        ]),
    );
    const response = await gatherLauncherTasks(
      {
        config: {
          executionWiring: [
            {
              workKind: 'a.v1',
              harness: 'claude-code',
              model: 'claude-haiku-4-5-20251001',
              plugins: [],
              credentialRef: 'claude-code-default',
              isolationPolicy: 'process',
              legacyManifestDigest: 'bafy-joined-a',
            },
            {
              workKind: 'b.v1',
              harness: 'claude-code',
              model: 'claude-haiku-4-5-20251001',
              plugins: [],
              credentialRef: 'claude-code-default',
              isolationPolicy: 'process',
              legacyManifestDigest: 'bafy-joined-b',
            },
          ],
        } as unknown as JinnConfig,
        creatorAddress: '0xabc',
        now: () => NOW_MS,
        fetchPostedTasks: () => [
          { taskId: 't1', taskCid: 'cid1', postedAt: '2026-05-25T00:00:00Z', budget: { totalWei: '0' } },
        ],
        fetchTaskStatuses,
      },
      { manifestCid: 'bafy-launched' },
    );

    expect(fetchTaskStatuses).toHaveBeenCalledTimes(1);
    expect(fetchTaskStatuses).toHaveBeenCalledWith('bafy-launched');
    expect(response.tasks[0]?.onchainStatus).toBe('finalized');
  });
});
