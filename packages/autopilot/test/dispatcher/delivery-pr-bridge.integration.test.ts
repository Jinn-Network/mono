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

    // The pushed commit really applied the patch: read the file at that ref.
    const fileAtBranch = execFileSync('git', ['-C', repoRoot, 'show', `${branch}:FIXTURE.md`]).toString();
    expect(fileAtBranch).toBe('hello world\n');

    // The `gh pr create` call carried the right shape.
    const create = ghCalls.find((c) => c.args[0] === 'pr' && c.args[1] === 'create');
    expect(create).toBeDefined();
    expect(create!.args).toEqual(expect.arrayContaining(['--draft', '--base', 'next', '--head', branch, '--label', 'engine:review']));
    const body = create!.args[create!.args.indexOf('--body') + 1]!;
    expect(body).toContain('Closes #1892');

    // Worktree cleanup happened — only the checkout is gone, the branch ref survives.
    const worktreeList = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain']).toString();
    expect(worktreeList).not.toContain('bridge-1892');
  });
});
