/**
 * Integration test for `runJinnRepoLiveEval` against a LOCAL `file://`
 * fixture repo (not the real Jinn-Network/mono GitHub remote — contrast
 * `./eval-runner.integration.test.ts`, which grades the real merged-pr
 * fixture against the real remote). A live-issue task has no gold, so there
 * is no historical commit this evaluator needs to reproduce; a small
 * synthetic package (checked in at `test/fixtures/jinn-repo-live-eval/app/`)
 * is enough to exercise the real subprocess pipeline — git clone, patch
 * apply, `yarn install`, `tsc --noEmit`, `vitest run` — without depending on
 * network access to GitHub or the full `client/`+`packages/sdk` build chain.
 *
 * Gated behind JINN_E2E_JINN_REPO_LIVE=1 (mirrors the sibling's
 * JINN_E2E_JINN_REPO gate): each scenario does a real `git fetch` + `yarn
 * install` + `tsc`/`vitest` subprocess run, too slow for the default `yarn
 * test` suite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmod, mkdir, mkdtemp, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  liveIssueWorkspaceRepository,
  runJinnRepoLiveEval,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/live-eval-runner.js';
import type { PackageSpec } from '../../../src/harnesses/impls/jinn-repo-evaluator/scope-tests.js';
import type { JinnRepoLiveIssueTask } from '@jinn-network/sdk/solvernets/jinn-repo';

const sh = promisify(execFile);

// __dirname is not defined in ESM; derive it from import.meta.url instead.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_APP = join(__dirname, '../../fixtures/jinn-repo-live-eval/app');
const RUN = process.env.JINN_E2E_JINN_REPO_LIVE === '1';

/** The fixture's own package layout: `<fixture-repo>/app/{src,test}`. */
const FIXTURE_PACKAGE: PackageSpec = {
  root: 'app',
  srcDir: 'app/src',
  testDir: 'app/test',
  typecheckScript: 'typecheck',
  testScript: 'test',
};

const LIVE_BASE_COMMIT = 'a'.repeat(40);

function liveIssueSpec(relay?: JinnRepoLiveIssueTask['relay']): JinnRepoLiveIssueTask {
  return {
    schemaVersion: 'jinn-repo.v1',
    source: 'live-issue',
    instance_id: 'Jinn-Network__mono-1889',
    repo: relay?.targetRepository ?? 'Jinn-Network/mono',
    base_commit: relay?.inputHead ?? LIVE_BASE_COMMIT,
    language: 'typescript',
    problem_statement: 'Exercise live issue workspace selection.',
    issue_number: 1889,
    ...(relay === undefined ? {} : { relay }),
  };
}

describe('liveIssueWorkspaceRepository', () => {
  it('selects the outer repository for legacy live issues, the upstream target for initial Relay, and the managed fork for repair Relay', () => {
    const initialRelay = {
      schemaVersion: 'jinn-issue-relay-round.v1' as const,
      generation: 'relay:initial',
      round: 0,
      snapshotDigest: `sha256:${'b'.repeat(64)}` as const,
      targetRepository: 'upstream-org/upstream-repo',
      workspaceRepository: 'upstream-org/upstream-repo',
      inputHead: LIVE_BASE_COMMIT,
      purpose: 'initial' as const,
      findings: [],
    };
    const repairRelay = {
      schemaVersion: 'jinn-issue-relay-round.v1' as const,
      generation: 'relay:repair',
      round: 1,
      snapshotDigest: `sha256:${'c'.repeat(64)}` as const,
      targetRepository: 'upstream-org/upstream-repo',
      workspaceRepository: 'managed-fork/relay-repair',
      inputHead: LIVE_BASE_COMMIT,
      purpose: 'repair' as const,
      findings: [{ code: 'ci', title: 'CI failure', detail: 'Repair the failed check.' }],
      prNumber: 42,
    };

    expect(liveIssueWorkspaceRepository(liveIssueSpec())).toBe('Jinn-Network/mono');
    expect(liveIssueWorkspaceRepository(liveIssueSpec(initialRelay))).toBe('upstream-org/upstream-repo');
    expect(liveIssueWorkspaceRepository(liveIssueSpec(repairRelay))).toBe('managed-fork/relay-repair');
  });
});

describe('runJinnRepoLiveEval workspace boundary', () => {
  it('supplies the Relay workspace GitHub URL and outer base commit to the repro checkout', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'jinn-repo-live-eval-workspace-boundary-'));
    const binDir = join(sandbox, 'bin');
    const gitLog = join(sandbox, 'git.log');
    const originalPath = process.env.PATH;
    const originalGitLog = process.env.GIT_LOG;
    const baseCommit = 'd'.repeat(40);
    const relay = {
      schemaVersion: 'jinn-issue-relay-round.v1' as const,
      generation: 'relay:repair-boundary',
      round: 1,
      snapshotDigest: `sha256:${'e'.repeat(64)}` as const,
      targetRepository: 'upstream-org/upstream-repo',
      workspaceRepository: 'managed-fork/relay-repair',
      inputHead: baseCommit,
      purpose: 'repair' as const,
      findings: [{ code: 'ci', title: 'CI failure', detail: 'Repair the failed check.' }],
      prNumber: 42,
    };

    try {
      await mkdir(binDir);
      await writeFile(
        join(binDir, 'git'),
        [
          '#!/usr/bin/env bash',
          'printf "%s\\n" "$*" >> "$GIT_LOG"',
        ].join('\n'),
      );
      await chmod(join(binDir, 'git'), 0o755);
      process.env.PATH = `${binDir}:${originalPath ?? ''}`;
      process.env.GIT_LOG = gitLog;

      const result = await runJinnRepoLiveEval({
        spec: liveIssueSpec(relay),
        patch: '',
        packages: [],
      });
      const gitArgs = (await readFile(gitLog, 'utf8')).trim().split('\n').filter(Boolean);

      expect(result).toMatchObject({ applies: true, typecheck: true, tests: true, passed: true });
      expect(gitArgs.some((args) => args.endsWith(
        'remote add origin https://github.com/managed-fork/relay-repair.git',
      ))).toBe(true);
      expect(gitArgs.some((args) => args.endsWith(
        `fetch -q --depth 1 origin ${baseCommit}`,
      ))).toBe(true);
    } finally {
      process.env.PATH = originalPath;
      if (originalGitLog === undefined) delete process.env.GIT_LOG;
      else process.env.GIT_LOG = originalGitLog;
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

// A patch against a file that does not exist in the base commit, and is not
// marked as a new-file creation (no `--- /dev/null`) — `git apply` refuses
// this unconditionally, independent of repo state. Used for the applies:false
// scenario.
const NON_APPLYING_PATCH = [
  'diff --git a/app/src/does-not-exist.ts b/app/src/does-not-exist.ts',
  'index 0000000..1111111 100644',
  '--- a/app/src/does-not-exist.ts',
  '+++ b/app/src/does-not-exist.ts',
  '@@ -1,1 +1,1 @@',
  '-old line that does not exist',
  '+new line',
  '',
].join('\n');

// A patch that applies cleanly but touches only a new file OUTSIDE the
// fixture package (`app/`, the sole entry in `packages: [FIXTURE_PACKAGE]`
// passed to `grade()` below) — e.g. a repo-root doc/config file. Regression
// coverage for issue #1891 Finding 1: this must NOT be a vacuous PASS.
const OUTSIDE_GATED_SCOPE_PATCH = [
  'diff --git a/NOTES.md b/NOTES.md',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/NOTES.md',
  '@@ -0,0 +1 @@',
  '+not under any gated package',
  '',
].join('\n');

describe.runIf(RUN)('runJinnRepoLiveEval (local file:// fixture repo)', () => {
  let repoDir: string;
  let baseCommit: string;

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'jinn-repo-live-eval-fixture-repo-'));
    await cp(FIXTURE_APP, join(repoDir, 'app'), { recursive: true });
    await sh('git', ['init', '-q', repoDir]);
    await sh('git', ['-C', repoDir, 'config', 'user.email', 'test@test.com']);
    await sh('git', ['-C', repoDir, 'config', 'user.name', 'test']);
    await sh('git', ['-C', repoDir, 'add', '-A']);
    await sh('git', ['-C', repoDir, 'commit', '-q', '-m', 'base']);
    const { stdout } = await sh('git', ['-C', repoDir, 'rev-parse', 'HEAD']);
    baseCommit = stdout.trim();
  }, 120_000);

  afterAll(async () => {
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  /**
   * Mutates a tracked file in the shared fixture repo's working tree, reads
   * off the resulting unified diff via a real `git diff` (guaranteed valid
   * format, unlike a hand-written hunk), then reverts the working tree so
   * the next scenario starts clean. Tests in this file must run
   * sequentially (the default — no `.concurrent`) since they share `repoDir`.
   */
  async function patchFromMutation(contents: string): Promise<string> {
    await writeFile(join(repoDir, 'app/src/math.ts'), contents);
    const { stdout } = await sh('git', ['-C', repoDir, 'diff']);
    await sh('git', ['-C', repoDir, 'checkout', '--', '.']);
    return stdout;
  }

  function grade(patch: string) {
    return runJinnRepoLiveEval({
      spec: { ...liveIssueSpec(), base_commit: baseCommit },
      patch,
      workspaceRepoUrl: `file://${repoDir}`,
      packages: [FIXTURE_PACKAGE],
    });
  }

  it('applies:false — a malformed patch fails to apply, graded FAIL (not unscorable)', async () => {
    const result = await grade(NON_APPLYING_PATCH);
    expect(result.unscorable).toBe(false);
    expect(result.applies).toBe(false);
    expect(result.typecheck).toBe(false);
    expect(result.tests).toBe(false);
    expect(result.passed).toBe(false);
  }, 120_000);

  it('unscorable — a non-empty patch touching no gated package is never a vacuous PASS (issue #1891 Finding 1)', async () => {
    const result = await grade(OUTSIDE_GATED_SCOPE_PATCH);
    expect(result.unscorable).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.applies).toBe(false);
    expect(result.typecheck).toBe(false);
    expect(result.tests).toBe(false);
    expect(result.logExcerpt).toMatch(/no-gated-package-touched/);
    expect(result.logExcerpt).toMatch(/NOTES\.md/);
  }, 60_000);

  it('typecheck:false — a type error fails the typecheck gate; tests never run', async () => {
    const patch = await patchFromMutation(
      `export function add(a: number, b: number): number {\n` +
        `  const bad: number = 'oops';\n` +
        `  return a + b;\n` +
        `}\n`,
    );
    const result = await grade(patch);
    expect(result.unscorable).toBe(false);
    expect(result.applies).toBe(true);
    expect(result.typecheck).toBe(false);
    expect(result.tests).toBe(false);
    expect(result.passed).toBe(false);
  }, 180_000);

  it('tests:false — a logic bug typechecks cleanly but fails the scoped mirrored test', async () => {
    const patch = await patchFromMutation(
      `export function add(a: number, b: number): number {\n` + `  return a + b + 1;\n` + `}\n`,
    );
    const result = await grade(patch);
    expect(result.unscorable).toBe(false);
    expect(result.applies).toBe(true);
    expect(result.typecheck).toBe(true);
    expect(result.tests).toBe(false);
    expect(result.passed).toBe(false);
  }, 180_000);

  it('passed:true — a valid change applies, typechecks, and passes the scoped mirrored test', async () => {
    const patch = await patchFromMutation(
      `export function add(a: number, b: number): number {\n` + `  return b + a;\n` + `}\n`,
    );
    const result = await grade(patch);
    expect(result.unscorable).toBe(false);
    expect(result.applies).toBe(true);
    expect(result.typecheck).toBe(true);
    expect(result.tests).toBe(true);
    expect(result.passed).toBe(true);
  }, 180_000);
});
