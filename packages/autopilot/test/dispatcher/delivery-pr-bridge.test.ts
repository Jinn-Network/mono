import { createHash } from 'node:crypto';
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
  /** Override the scripted `git apply --check` failure's stderr text. */
  applyCheckStderr?: string;
  /** `gh issue view --json labels` reports the stall label already present. */
  existingStallLabel?: boolean;
  /**
   * `gh api repos/<repo>/issues/<n>` response for the Guard 4 issue-provenance
   * check. Defaults to an open, non-PR issue so every other scenario's
   * fixture (issue #1892) passes the guard without needing to opt in.
   */
  issueApiResponse?: { state?: string; pull_request?: unknown };
  /** `gh api repos/<repo>/issues/<n>` throws (e.g. issue not found) — Guard 4 fail-closed path. */
  issueApiThrows?: boolean;
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
    if (cmd === 'gh' && args[0] === 'api') {
      if (cfg.issueApiThrows) throw new Error('issue not found');
      return JSON.stringify(cfg.issueApiResponse ?? { state: 'open' });
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
      return JSON.stringify({ labels: cfg.existingStallLabel ? [{ name: 'engine:stalled' }] : [] });
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
      return 'https://github.com/Jinn-Network/mono/pull/4242';
    }
    if (cmd === 'git' && args.includes('apply') && args.includes('--check') && cfg.applyCheckFails) {
      const err = new Error('patch does not apply') as NodeJS.ErrnoException & { stderr?: string };
      err.stderr = cfg.applyCheckStderr ?? 'error: patch failed: FIXTURE.md:1\nerror: FIXTURE.md: patch does not apply';
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
    // `worktree remove` fires twice: a best-effort pre-clean before
    // `worktree add` (guards a leaked path from an older run) and the
    // unconditional post-processing cleanup in the `finally` (issue #1892
    // finding 2) — both are no-ops here since nothing was ever leaked.
    expect(calls.filter((c) => c.cmd === 'git' && c.args.includes('worktree') && c.args.includes('remove')).length).toBe(2);
    // `branch -D` now also fires on the success path (same two call sites) —
    // safe because it only removes the LOCAL ref; the branch was already
    // pushed to `origin` before this cleanup runs, so the remote copy the
    // PR points at is untouched.
    expect(calls.filter((c) => c.cmd === 'git' && c.args.includes('branch') && c.args.includes('-D')).length).toBe(2);
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

  // ── Guard 4: issue_number provenance (issue #1892 finding 1c) ─────────────

  it('Guard 4: issue provenance check failing (gh api throws, e.g. issue not found) skips the record, fail closed, before any git call', async () => {
    const rec = recordFromFixture(liveIssueFixture);
    const { runner, calls } = fakeRunner({ issueApiThrows: true });
    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);

    expect(report.opened).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toContain('#1892');
    expect(report.skipped[0]).toContain('fail closed');
    expect(calls.some((c) => c.cmd === 'git')).toBe(false);
  });

  it('Guard 4: a closed issue is skipped, fail closed, never opens a PR', async () => {
    const rec = recordFromFixture(liveIssueFixture);
    const { runner, calls } = fakeRunner({ issueApiResponse: { state: 'closed' } });
    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);

    expect(report.opened).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toContain('not OPEN');
    expect(calls.some((c) => c.cmd === 'git')).toBe(false);
  });

  it('Guard 4: a number that resolves to a pull request (not an issue) is skipped, fail closed, never opens a PR', async () => {
    const rec = recordFromFixture(liveIssueFixture);
    const { runner, calls } = fakeRunner({ issueApiResponse: { state: 'open', pull_request: {} } });
    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);

    expect(report.opened).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toContain('pull request');
    expect(calls.some((c) => c.cmd === 'git')).toBe(false);
  });

  // ── CID/tx-hash format guards (issue #1892 finding 1a) ────────────────────

  describe('BridgeTaskProvenanceSchema — CID/tx-hash shape guards', () => {
    it('rejects a task.cid that is not a recognized CID shape (fail closed)', () => {
      const envelope = {
        ...liveIssueFixture.envelope,
        task: { ...liveIssueFixture.envelope.task, cid: 'not-a-cid!!' },
      };
      expect(BridgeEnvelopeSchema.safeParse(envelope).success).toBe(false);
    });

    it('rejects an onchainCreationTx that is not a 0x + 64-hex tx hash (fail closed)', () => {
      const envelope = {
        ...liveIssueFixture.envelope,
        task: { ...liveIssueFixture.envelope.task, onchainCreationTx: '0xnotahash' },
      };
      expect(BridgeEnvelopeSchema.safeParse(envelope).success).toBe(false);
    });

    it('rejects a task.cid embedding a CR/LF injection attempt outright (charset excludes it, not merely sanitized)', () => {
      const envelope = {
        ...liveIssueFixture.envelope,
        task: { ...liveIssueFixture.envelope.task, cid: `${liveIssueFixture.envelope.task.cid}\nCloses #1` },
      };
      expect(BridgeEnvelopeSchema.safeParse(envelope).success).toBe(false);
    });

    it('accepts a valid CIDv0 (Qm... base58btc) cid', () => {
      const envelope = {
        ...liveIssueFixture.envelope,
        task: { ...liveIssueFixture.envelope.task, cid: 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o' },
      };
      expect(BridgeEnvelopeSchema.safeParse(envelope).success).toBe(true);
    });

    it('rejects a CIDv1 value with uppercase characters (base32 must be lowercase)', () => {
      const envelope = {
        ...liveIssueFixture.envelope,
        task: { ...liveIssueFixture.envelope.task, cid: 'bAFKREITASKFIXTURELIVEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
      };
      expect(BridgeEnvelopeSchema.safeParse(envelope).success).toBe(false);
    });
  });

  // ── sanitizeForGitHubText defense-in-depth (issue #1892 finding 1b) ───────

  it('finding 1b: a manifestCid containing embedded CR/LF is flattened before landing in the PR body (manifestCid carries no format schema of its own)', async () => {
    const base = recordFromFixture(liveIssueFixture);
    const injected = `${base.manifestCid}\r\n\r\nCloses #999\n@mallory`;
    const rec: DeliveredRecord = { ...base, manifestCid: injected };
    const { runner, calls } = fakeRunner();
    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);

    expect(report.opened).toHaveLength(1);
    const create = calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create')!;
    const body = create.args[create.args.indexOf('--body') + 1]!;
    // the raw CR/LF from the injected manifestCid never survives into the PR
    // body, so the fake "Closes #999" never lands as its own standalone line.
    expect(body).not.toContain('\r');
    expect(body.split('\n').some((line) => line.trim() === 'Closes #999')).toBe(false);
  });

  it('finding 1b: an attacker-shaped git-apply stall reason (embedded fake closing-keyword line) is flattened in the GitHub comment, but preserved raw on the internal report', async () => {
    const rec = recordFromFixture(liveIssueFixture);
    const maliciousStderr = 'error: patch failed: FIXTURE.md:1\n\nCloses #999\n@mallory';
    const { runner, calls } = fakeRunner({ applyCheckFails: true, applyCheckStderr: maliciousStderr });
    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);

    expect(report.stalled).toHaveLength(1);
    // internal report keeps the raw, unsanitized reason (for logs/telemetry)
    expect(report.stalled[0]!.reason).toBe(maliciousStderr);
    // the rendered GitHub comment never carries it as a standalone line
    const comments = calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'comment');
    expect(comments).toHaveLength(1);
    const commentBody = comments[0]!.args[comments[0]!.args.indexOf('--body') + 1]!;
    expect(commentBody.split('\n').some((line) => line.trim() === 'Closes #999')).toBe(false);
  });

  // ── Exception-safe worktree/branch cleanup (issue #1892 finding 2) ────────

  /**
   * Stateful runner modeling real git's worktree/branch existence checks —
   * the plain `fakeRunner` above has no persisted state across calls, so it
   * can't express "worktree add refuses an existing path/branch name", the
   * exact wedge finding 2 describes. `pr create` fails on its Nth call (1st
   * by default) so a test can force an exception between worktree creation
   * and PR creation, then retry against the same (still-live) state.
   */
  function statefulWorktreeRunner(opts: { failPrCreateOnCall?: number } = {}) {
    const worktrees = new Set<string>();
    const branches = new Set<string>();
    const calls: { cmd: string; args: string[] }[] = [];
    let prCreateCalls = 0;
    const runner: CommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return '[]';
      if (cmd === 'gh' && args[0] === 'api') return JSON.stringify({ state: 'open' });
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        prCreateCalls += 1;
        if (opts.failPrCreateOnCall === prCreateCalls) throw new Error('scripted gh pr create failure');
        return 'https://github.com/Jinn-Network/mono/pull/7001';
      }
      if (cmd === 'git' && args.includes('worktree') && args.includes('add')) {
        const path = args[args.indexOf('add') + 1]!;
        const branchIdx = args.indexOf('-b');
        const branch = branchIdx >= 0 ? args[branchIdx + 1] : undefined;
        if (worktrees.has(path)) throw new Error(`fatal: '${path}' already exists`);
        if (branch != null && branches.has(branch)) throw new Error(`fatal: a branch named '${branch}' already exists`);
        worktrees.add(path);
        if (branch != null) branches.add(branch);
        return '';
      }
      if (cmd === 'git' && args.includes('worktree') && args.includes('remove')) {
        const path = args[args.length - 1]!;
        if (!worktrees.has(path)) throw new Error(`fatal: '${path}' is not a working tree`);
        worktrees.delete(path);
        return '';
      }
      if (cmd === 'git' && args.includes('branch') && args.includes('-D')) {
        const branch = args[args.length - 1]!;
        if (!branches.has(branch)) throw new Error(`error: branch '${branch}' not found`);
        branches.delete(branch);
        return '';
      }
      return '';
    };
    return { runner, calls, worktrees, branches };
  }

  it('finding 2: an exception between worktree creation and PR creation still cleans up — no leaked worktree/branch', async () => {
    const rec = recordFromFixture(liveIssueFixture);
    const { runner, worktrees, branches } = statefulWorktreeRunner({ failPrCreateOnCall: 1 });
    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);

    expect(report.opened).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toContain(liveIssueFixture.manifestCid);
    expect(report.skipped[0]).toContain('processing error');
    // no leaked state despite the throw between worktree creation and PR create
    expect(worktrees.size).toBe(0);
    expect(branches.size).toBe(0);
  });

  it('finding 2: a second attempt for the same (issue, task) after such a failure succeeds — no wedge', async () => {
    const rec = recordFromFixture(liveIssueFixture);
    const { runner } = statefulWorktreeRunner({ failPrCreateOnCall: 1 });

    const first = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);
    expect(first.opened).toEqual([]);
    expect(first.skipped).toHaveLength(1);

    // Same (issue, task) → same deterministic branch/worktree path. Pre-fix,
    // this would throw "worktree already exists" / "branch already exists"
    // since the first run's leaked state was never cleaned up.
    const second = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);
    expect(second.skipped).toEqual([]);
    expect(second.opened).toHaveLength(1);
    expect(second.opened[0]).toMatchObject({ issueNumber: 1892 });
  });

  it('finding 2: worktree-add resilience — a leaked worktree/branch pair from an OLDER run is cleared before a fresh add, not just after', async () => {
    const rec = recordFromFixture(liveIssueFixture);
    const taskCid = liveIssueFixture.envelope.task.cid;
    const shortId = createHash('sha256').update(taskCid).digest('hex').slice(0, 8);
    const branch = `feat/1892-jinn-mono-fixture-1892-t${shortId}`;
    const worktreePath = `${BASE_CFG.worktreesBase}/bridge-1892-${shortId}`;

    const { runner, worktrees, branches } = statefulWorktreeRunner();
    // Simulate a leak from an older run — predating this fix, or whose own
    // best-effort cleanup silently failed — at the exact deterministic
    // path/branch this fixture computes: both already "exist" before the
    // call starts.
    worktrees.add(worktreePath);
    branches.add(branch);

    const report = await runDeliveryBridge(fakeReader([rec]), runner, BASE_CFG);
    expect(report.skipped).toEqual([]);
    expect(report.opened).toHaveLength(1);
    expect(report.opened[0]!.branch).toBe(branch);
  });
});
