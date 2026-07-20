import { describe, it, expect, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runDeliveryBridge,
  BridgeEnvelopeSchema,
} from '../../src/dispatcher/delivery-pr-bridge.js';
import type { DeliveredRecord, DeliveryReader } from '../../src/dispatcher/delivery-pr-bridge.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';
import liveIssueFixture from '../fixtures/delivery-live-issue-solution.json';

/**
 * Integration coverage for AC1 ("a synthetic solution envelope (fixture)
 * produces a real draft PR: patch applied, branch pushed …"): a REAL `git`
 * worktree/apply/commit/push against a local bare repo standing in for
 * `origin` — never the real jinn-mono remote — with `gh` scripted (never the
 * real GitHub CLI). Mirrors the coordinator's "no real network/gh/git-remote
 * in tests" instruction: this is a local-only git remote, not GitHub.
 */

const execFileAsync = promisify(execFile);

/** Real `git`, faked `gh` — dispatched by `cmd`. */
function makeMixedRunner(ghCalls: { cmd: string; args: string[] }[]): CommandRunner {
  return async (cmd, args) => {
    if (cmd === 'git') {
      const { stdout } = await execFileAsync('git', args);
      return stdout;
    }
    // cmd === 'gh'
    ghCalls.push({ cmd, args });
    if (args[0] === 'pr' && args[1] === 'list') return '[]'; // never handled before — proceed
    if (args[0] === 'api') return JSON.stringify({ state: 'open' }); // Guard 4 provenance check
    if (args[0] === 'pr' && args[1] === 'create') {
      return 'https://github.com/Jinn-Network/mono/pull/9001\n';
    }
    throw new Error(`unexpected gh call in integration test: ${args.join(' ')}`);
  };
}

describe('delivery-pr-bridge — integration (local bare git repo as origin, scripted gh)', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const d of cleanupDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('a synthetic solution envelope produces a real pushed branch + a captured gh pr create call', async () => {
    const bareOrigin = mkdtempSync(join(tmpdir(), 'jinn-bridge-it-origin-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'jinn-bridge-it-repo-'));
    const worktreesBase = mkdtempSync(join(tmpdir(), 'jinn-bridge-it-worktrees-'));
    cleanupDirs.push(bareOrigin, repoRoot, worktreesBase);

    // Local bare "origin" — never the real jinn-mono GitHub remote.
    execFileSync('git', ['init', '--bare', '--quiet', bareOrigin]);
    execFileSync('git', ['clone', '--quiet', bareOrigin, repoRoot]);
    execFileSync('git', ['-C', repoRoot, 'checkout', '-q', '-B', 'next']);
    // Baseline content the fixture's patch context matches exactly.
    writeFileSync(join(repoRoot, 'FIXTURE.md'), 'hello\n');
    execFileSync('git', ['-C', repoRoot, 'add', 'FIXTURE.md']);
    execFileSync('git', ['-C', repoRoot, 'commit', '-q', '-m', 'init']);
    execFileSync('git', ['-C', repoRoot, 'push', '-q', '-u', 'origin', 'next']);

    const rec: DeliveredRecord = {
      manifestCid: liveIssueFixture.manifestCid,
      envelope: BridgeEnvelopeSchema.parse(liveIssueFixture.envelope),
      taskRaw: liveIssueFixture.task,
    };
    const reader: DeliveryReader = { pollSolutions: async () => [rec] };
    const ghCalls: { cmd: string; args: string[] }[] = [];
    const runner = makeMixedRunner(ghCalls);

    const report = await runDeliveryBridge(reader, runner, {
      enabled: true,
      repoRoot,
      worktreesBase,
      ipfsGatewayUrl: 'https://gateway.autonolas.tech',
    });

    expect(report.stalled).toEqual([]);
    expect(report.opened).toHaveLength(1);
    expect(report.opened[0]).toMatchObject({ issueNumber: 1892, prNumber: 9001 });
    const branch = report.opened[0]!.branch;
    expect(branch).toMatch(/^feat\/1892-jinn-mono-fixture-1892-t[0-9a-f]{8}$/);

    // The branch is REALLY on the bare "origin" — not just claimed by the report.
    const lsRemote = execFileSync('git', ['ls-remote', '--heads', bareOrigin, branch]).toString();
    expect(lsRemote.trim()).not.toBe('');

    // The pushed commit really applied the patch: read the file via the
    // REMOTE-tracking ref, not the local branch — the exception-safe cleanup
    // fix (issue #1892 finding 2) unconditionally deletes the LOCAL branch
    // ref after a successful push (harmless: `branch -D` never touches
    // `refs/remotes/origin/*`, and the remote copy is what the PR points at).
    const fileAtBranch = execFileSync('git', ['-C', repoRoot, 'show', `origin/${branch}:FIXTURE.md`]).toString();
    expect(fileAtBranch).toBe('hello world\n');

    // The `gh pr create` call carried the right shape.
    const create = ghCalls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    expect(create).toBeDefined();
    expect(create!.args).toEqual(expect.arrayContaining(['--draft', '--base', 'next', '--head', branch, '--label', 'engine:review']));
    const body = create!.args[create!.args.indexOf('--body') + 1]!;
    expect(body).toContain('Closes #1892');

    // Worktree cleanup happened — the checkout is gone.
    const worktreeList = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']).toString();
    expect(worktreeList).not.toContain('bridge-1892');
    // The LOCAL branch ref is gone too (finding 2's unconditional cleanup) —
    // only the remote-tracking ref (verified above) and the bare origin's
    // own ref (verified via ls-remote above) remain.
    const localBranches = execFileSync('git', ['-C', repoRoot, 'branch', '--list', branch]).toString();
    expect(localBranches.trim()).toBe('');
  });

  it('finding 2: a scripted mid-flow failure (git push rejection) still cleans up the real worktree/branch, and a second real attempt for the same (issue, task) succeeds', async () => {
    const bareOrigin = mkdtempSync(join(tmpdir(), 'jinn-bridge-it-origin-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'jinn-bridge-it-repo-'));
    const worktreesBase = mkdtempSync(join(tmpdir(), 'jinn-bridge-it-worktrees-'));
    cleanupDirs.push(bareOrigin, repoRoot, worktreesBase);

    execFileSync('git', ['init', '--bare', '--quiet', bareOrigin]);
    execFileSync('git', ['clone', '--quiet', bareOrigin, repoRoot]);
    execFileSync('git', ['-C', repoRoot, 'checkout', '-q', '-B', 'next']);
    writeFileSync(join(repoRoot, 'FIXTURE.md'), 'hello\n');
    execFileSync('git', ['-C', repoRoot, 'add', 'FIXTURE.md']);
    execFileSync('git', ['-C', repoRoot, 'commit', '-q', '-m', 'init']);
    execFileSync('git', ['-C', repoRoot, 'push', '-q', '-u', 'origin', 'next']);

    const rec: DeliveredRecord = {
      manifestCid: liveIssueFixture.manifestCid,
      envelope: BridgeEnvelopeSchema.parse(liveIssueFixture.envelope),
      taskRaw: liveIssueFixture.task,
    };
    const reader: DeliveryReader = { pollSolutions: async () => [rec] };
    const ghCalls: { cmd: string; args: string[] }[] = [];

    // Real git throughout, EXCEPT `push` is scripted to reject exactly once
    // (one of finding 2's own listed exception triggers — "git push
    // rejection") — the worktree/branch/commit are all real local git state
    // by the time this fires, so this exercises the exact leak shape finding
    // 2 describes without real git's non-fast-forward rejection on retry
    // getting in the way (nothing ever reached the real remote on attempt 1).
    let pushCalls = 0;
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args.includes('push')) {
        pushCalls += 1;
        if (pushCalls === 1) {
          throw new Error('scripted git push rejection (simulating a remote-side failure)');
        }
      }
      if (cmd === 'git') {
        const { stdout } = await execFileAsync('git', args);
        return stdout;
      }
      // cmd === 'gh'
      ghCalls.push({ cmd, args });
      if (args[0] === 'pr' && args[1] === 'list') return '[]';
      if (args[0] === 'api') return JSON.stringify({ state: 'open' });
      if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/Jinn-Network/mono/pull/9002\n';
      throw new Error(`unexpected gh call in integration test: ${args.join(' ')}`);
    };

    const cfg = { enabled: true, repoRoot, worktreesBase, ipfsGatewayUrl: 'https://gateway.autonolas.tech' };

    const first = await runDeliveryBridge(reader, runner, cfg);
    expect(first.opened).toEqual([]);
    expect(first.skipped).toHaveLength(1);
    expect(first.skipped[0]).toContain(liveIssueFixture.manifestCid);

    // No leaked worktree or local branch after the scripted failure — the
    // `finally` in `processRecord` ran its best-effort cleanup for real.
    const worktreeListAfterFailure = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']).toString();
    expect(worktreeListAfterFailure).not.toContain('bridge-1892');
    const localBranchesAfterFailure = execFileSync('git', ['-C', repoRoot, 'branch', '--list', 'feat/1892-*']).toString();
    expect(localBranchesAfterFailure.trim()).toBe('');

    // A second real attempt for the SAME (issue, task) — same deterministic
    // worktree path/branch name — must not hit "path already exists" /
    // "branch already exists" (the exact wedge finding 2 fixes) and must
    // actually succeed this time.
    const second = await runDeliveryBridge(reader, runner, cfg);
    expect(second.skipped).toEqual([]);
    expect(second.stalled).toEqual([]);
    expect(second.opened).toHaveLength(1);
    expect(second.opened[0]).toMatchObject({ issueNumber: 1892, prNumber: 9002 });
    expect(second.opened[0]!.branch).toMatch(/^feat\/1892-jinn-mono-fixture-1892-t[0-9a-f]{8}$/);
  });
});
