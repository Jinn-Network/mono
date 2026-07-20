import { describe, it, expect } from 'vitest';
import {
  runDeliveryBridge,
  BridgeEnvelopeSchema,
} from '../../src/dispatcher/delivery-pr-bridge.js';
import type {
  DeliveredRecord,
  DeliveryReader,
  DeliveryBridgeConfig,
} from '../../src/dispatcher/delivery-pr-bridge.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import liveIssueFixture from '../fixtures/delivery-live-issue-solution.json';
import mergedPrFixture from '../fixtures/delivery-merged-pr-solution.json';

interface RawFixture {
  manifestCid: string;
  envelope: unknown;
  task: unknown;
}

function recordFromFixture(fx: RawFixture): DeliveredRecord {
  return {
    manifestCid: fx.manifestCid,
    envelope: BridgeEnvelopeSchema.parse(fx.envelope),
    taskRaw: fx.task,
  };
}

function fakeReader(records: DeliveredRecord[]): DeliveryReader {
  return { pollSolutions: async () => records };
}

interface FakeRunnerCfg {
  /** `gh pr list --head <branch>` returns this PR number when set (idempotent-skip path). */
  existingPr?: number;
  /** `git apply --check` throws a scripted conflict error. */
  applyCheckFails?: boolean;
  /** `gh issue view --json labels` reports the stall label already present. */
  existingStallLabel?: boolean;
  failOn?: (cmd: string, args: string[]) => boolean;
}

/** Scripted runner mirroring the `fakeRunner` pattern in drift-sweep.test.ts / merge-sweep.test.ts. */
function fakeRunner(cfg: FakeRunnerCfg = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cfg.failOn?.(cmd, args)) throw new Error('scripted failure');
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      return JSON.stringify(cfg.existingPr != null ? [{ number: cfg.existingPr }] : []);
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
      return JSON.stringify({ labels: cfg.existingStallLabel ? [{ name: 'engine:stalled' }] : [] });
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return 'https://github.com/Jinn-Network/mono/pull/4242';
    }
    if (cmd === 'git' && args.includes('apply') && args.includes('--check') && cfg.applyCheckFails) {
      const err = new Error('patch does not apply') as NodeJS.ErrnoException & { stderr?: string };
      err.stderr = 'error: patch failed: FIXTURE.md:1\nerror: FIXTURE.md: patch does not apply';
      throw err;
    }
    return '';
  };
  return { runner, calls };
}

const BASE_CFG: DeliveryBridgeConfig = {
  enabled: true,
  repoRoot: '/repo',
  worktreesBase: '/worktrees',
  ipfsGatewayUrl: 'https://gateway.autonolas.tech',
};

describe('runDeliveryBridge', () => {
  it('disabled by default: flag off → no-op, reader never polled, no gh/git calls', async () => {
    let polled = false;
    const reader: DeliveryReader = {
      pollSolutions: async () => {
        polled = true;
        return [];
      },
    };
    const { runner, calls } = fakeRunner();
    const report = await runDeliveryBridge(reader, runner, { ...BASE_CFG, enabled: false });
    expect(polled).toBe(false);
    expect(calls).toEqual([]);
    expect(report).toEqual({ opened: [], stalled: [], skipped: [] });
  });

  it('happy path: applies, pushes, opens a draft PR with the deterministic branch/labels/evidence body', async () => {
    const rec = recordFromFixture(liveIssueFixture);
    const { runner, calls } = fakeRunner();
    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);

    expect(report.opened).toHaveLength(1);
    expect(report.opened[0]).toMatchObject({ issueNumber: 1892, prNumber: 4242 });
    expect(report.opened[0]!.branch).toMatch(/^feat\/1892-jinn-mono-fixture-1892-t[0-9a-f]{8}$/);
    expect(report.stalled).toEqual([]);
    expect(report.skipped).toEqual([]);

    const create = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
    expect(create).toBeDefined();
    expect(create!.args).toContain('--draft');
    expect(create!.args).toContain('engine:review');
    const body = create!.args[create!.args.indexOf('--body') + 1]!;
    expect(body).toContain('Closes #1892');
    expect(body).toContain(`jinn-task-cid: ${liveIssueFixture.envelope.task.cid}`);
    expect(body).toContain(`gateway.autonolas.tech/ipfs/${liveIssueFixture.manifestCid}`);
    expect(body).toContain(`gateway.autonolas.tech/ipfs/${liveIssueFixture.envelope.task.cid}`);
    expect(body).toContain(`sepolia.basescan.org/tx/${liveIssueFixture.envelope.task.onchainCreationTx}`);

    expect(calls.some((c) => c.cmd === 'git' && c.args.includes('worktree') && c.args.includes('add'))).toBe(true);
    expect(calls.some((c) => c.cmd === 'git' && c.args.includes('push'))).toBe(true);
    expect(calls.filter((c) => c.cmd === 'git' && c.args.includes('worktree') && c.args.includes('remove')).length).toBe(1);
    // no branch -D on the success path — only the worktree checkout is removed
    expect(calls.some((c) => c.cmd === 'git' && c.args.includes('branch') && c.args.includes('-D'))).toBe(false);
    // no stall machinery touched
    expect(calls.some((c) => c.cmd === 'gh' && c.args[0] === 'issue')).toBe(false);
  });

  it('apply-conflict → stall: never falls back to --3way; labels + one comment; no PR; worktree+branch cleaned up', async () => {
    const rec = recordFromFixture(liveIssueFixture);
    const { runner, calls } = fakeRunner({ applyCheckFails: true });
    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);

    expect(report.opened).toEqual([]);
    expect(report.stalled).toHaveLength(1);
    expect(report.stalled[0]).toMatchObject({ issueNumber: 1892 });
    expect(report.stalled[0]!.reason).toContain('patch failed');

    expect(calls.some((c) => c.cmd === 'git' && c.args.includes('--3way'))).toBe(false);
    expect(calls.some((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'edit' && c.args.includes('--add-label') && c.args.includes('engine:stalled'))).toBe(true);
    const comments = calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'comment');
    expect(comments).toHaveLength(1);
    expect(comments[0]!.args.join(' ')).toContain('patch failed');
    expect(calls.some((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create')).toBe(false);
    expect(calls.some((c) => c.cmd === 'git' && c.args.includes('worktree') && c.args.includes('remove'))).toBe(true);
    expect(calls.some((c) => c.cmd === 'git' && c.args.includes('branch') && c.args.includes('-D'))).toBe(true);
  });

  it('restart does not re-comment when the stall label is already present (label checked first)', async () => {
    const rec = recordFromFixture(liveIssueFixture);
    const { runner, calls } = fakeRunner({ applyCheckFails: true, existingStallLabel: true });
    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);

    expect(report.stalled).toHaveLength(1);
    expect(calls.some((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'edit')).toBe(false);
    expect(calls.some((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'comment')).toBe(false);
    // cleanup still happens regardless of the label short-circuit
    expect(calls.some((c) => c.cmd === 'git' && c.args.includes('worktree') && c.args.includes('remove'))).toBe(true);
    expect(calls.some((c) => c.cmd === 'git' && c.args.includes('branch') && c.args.includes('-D'))).toBe(true);
  });

  it('idempotent skip: an existing PR for the deterministic branch stops all further work', async () => {
    const rec = recordFromFixture(liveIssueFixture);
    const { runner, calls } = fakeRunner({ existingPr: 555 });
    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);

    expect(report.opened).toEqual([]);
    expect(report.stalled).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toContain('#555');
    expect(calls.some((c) => c.cmd === 'git')).toBe(false);
  });

  it('retrospective-envelope rejection: a merged-pr task doc never opens a PR (hard guard)', async () => {
    const rec = recordFromFixture(mergedPrFixture);
    const { runner, calls } = fakeRunner();
    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);

    expect(report.opened).toEqual([]);
    expect(report.stalled).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatch(/rejected/);
    expect(calls).toEqual([]); // guard fires before any gh/git call
  });

  it('role filter: a verdict-role envelope is skipped, never bridged', async () => {
    const base = recordFromFixture(liveIssueFixture);
    const rec: DeliveredRecord = { ...base, envelope: { ...base.envelope, role: 'verdict' } };
    const { runner, calls } = fakeRunner();
    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);

    expect(report.opened).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toContain('role=verdict');
    expect(calls).toEqual([]);
  });

  it('a poll failure is logged and never fatal — returns an empty report', async () => {
    const reader: DeliveryReader = {
      pollSolutions: async () => {
        throw new Error('indexer unreachable');
      },
    };
    const { runner } = fakeRunner();
    const report = await runDeliveryBridge(reader, runner, BASE_CFG);
    expect(report).toEqual({ opened: [], stalled: [], skipped: [] });
  });

  it('a per-record processing failure is isolated — other records still process', async () => {
    const good = recordFromFixture(liveIssueFixture);
    const bad: DeliveredRecord = { ...good, manifestCid: 'bafkreiTHROWS' };
    const { runner } = fakeRunner();
    // The first record processed (`bad`) fails its very first runner call
    // (the idempotency `gh pr list`); the second record (`good`) must still
    // process normally afterward.
    let call = 0;
    const throwingRunner: CommandRunner = async (cmd, args) => {
      call += 1;
      if (call === 1) throw new Error('scripted per-record failure');
      return runner(cmd, args);
    };
    const report = await runDeliveryBridge(fakeReader([bad, good]), throwingRunner, BASE_CFG);
    expect(report.skipped.some((s) => s.includes('bafkreiTHROWS'))).toBe(true);
    expect(report.opened).toHaveLength(1);
    expect(report.opened[0]!.issueNumber).toBe(1892);
  });
});
