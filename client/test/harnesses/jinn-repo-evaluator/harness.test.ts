import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '../../../src/types/task.js';
import type { HarnessContext } from '../../../src/harnesses/types.js';
import { SkippableError } from '../../../src/harnesses/types.js';
import { JinnRepoEvaluatorHarness } from '../../../src/harnesses/impls/jinn-repo-evaluator/harness.js';
import type { JinnRepoPoolItem } from '../../../src/solver-types/_jinn-repo-pool.js';

const INSTANCE_ID = 'jinn-mono-1234';

function poolItem(): JinnRepoPoolItem {
  return {
    schemaVersion: 'jinn-repo.v1',
    source: 'merged-pr',
    instance_id: INSTANCE_ID,
    repo: 'Jinn-Network/mono',
    base_commit: 'a'.repeat(40),
    merged_pr: 42,
    language: 'typescript',
    problem_statement: 'fix the thing',
    test_files: ['client/test/foo.test.ts'],
    test_cmd: 'yarn vitest run client/test/foo.test.ts',
    gold_tests: { 'client/test/foo.test.ts': 'expect(true).toBe(true)' },
    solution_patch: 'diff --git a/foo b/foo',
  };
}

function buildEvaluationTask(restorationEnvelopeJson: string, instanceId = INSTANCE_ID): Task {
  return {
    id: 'eval-task-1',
    description: 'evaluate jinn-repo',
    solverType: 'jinn-repo.v1',
    role: 'evaluation',
    // The evaluation task spec is the solverView (leak-controlled): no gold
    // tests, no solution_patch, no test_cmd. It carries instance_id.
    spec: {
      schemaVersion: 'jinn-repo.v1',
      instance_id: instanceId,
      repo: 'Jinn-Network/mono',
      base_commit: 'a'.repeat(40),
      problem_statement: 'fix the thing',
    },
    context: { restorationResult: restorationEnvelopeJson },
  };
}

const LIVE_INSTANCE_ID = 'Jinn-Network__mono-1889';

/**
 * A live-issue evaluation task's spec is the FULL JinnRepoLiveIssueTask —
 * unlike merged-pr, there is no gold to leak-protect, so no separate
 * solverView() projection exists for it.
 */
function buildLiveEvaluationTask(
  restorationEnvelopeJson: string,
  instanceId = LIVE_INSTANCE_ID,
): Task {
  return {
    id: 'eval-task-live-1',
    description: 'evaluate jinn-repo live issue',
    solverType: 'jinn-repo.v1',
    role: 'evaluation',
    spec: {
      schemaVersion: 'jinn-repo.v1',
      source: 'live-issue',
      instance_id: instanceId,
      repo: 'Jinn-Network/mono',
      base_commit: 'a'.repeat(40),
      language: 'typescript',
      problem_statement: 'fix the thing',
      issue_number: 1889,
    },
    context: { restorationResult: restorationEnvelopeJson },
  };
}

/**
 * A live-issue evaluation task whose spec has `source: 'live-issue'` (the
 * raw routing signal) but a field defect — here, a missing `issue_number` —
 * so the full `JinnRepoTaskSchema` parse fails. Regression fixture for issue
 * #1891 Finding 2: this must be recognized as a malformed live-issue task,
 * never silently misrouted to the merged-pr pool-lookup path.
 */
function buildMalformedLiveEvaluationTask(
  restorationEnvelopeJson: string,
  instanceId = LIVE_INSTANCE_ID,
): Task {
  const task = buildLiveEvaluationTask(restorationEnvelopeJson, instanceId);
  const spec = { ...(task.spec as Record<string, unknown>) };
  delete spec['issue_number'];
  return { ...task, spec };
}

function buildSolverEnvelope(overrides: Record<string, unknown> = {}): string {
  const base = {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'jinn-repo.v1',
    role: 'solution',
    generatedAt: Date.parse('2026-06-08T00:00:00.000Z'),
    task: {
      cid: 'bafy-task',
      onchainCreationTx: `0x${'0'.repeat(64)}`,
      onchainCreationBlock: 1,
      requestId: `0x${'1'.repeat(64)}`,
    },
    participant: {
      safeAddress: `0x${'2'.repeat(40)}`,
      agentEoa: `0x${'3'.repeat(40)}`,
    },
    window: { startTs: Date.parse('2026-06-08T00:00:00.000Z'), endTs: Date.parse('2026-06-15T00:00:00.000Z') },
    executor: {
      implName: 'claude-code-learner',
      implVersion: '1.0.0',
      clientGitSha: 'dev',
      codeDigest: `sha256:${'0'.repeat(64)}`,
      runtimeBundleDigest: `sha256:${'1'.repeat(64)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa' as const, pubkey: `0x${'3'.repeat(40)}` },
      mode: 'train' as const,
    },
    evidenceTier: 'self-signed' as const,
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: {
      schemaVersion: 'jinn-repo-solution.v1',
      patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-hello\n+world\n',
    },
    signature: {
      algo: 'secp256k1' as const,
      signer: `0x${'3'.repeat(40)}`,
      hash: `0x${'4'.repeat(64)}`,
      sig: `0x${'5'.repeat(130)}`,
    },
    ...overrides,
  };
  return JSON.stringify(base);
}

function buildHarnessContext(task: Task, dir: string): HarnessContext {
  return {
    task,
    implStateDir: dir,
    workingDir: dir,
    log: () => undefined,
    abort: new AbortController().signal,
    msUntilEndTs: () => 60_000,
    trajectory: { addSpan: () => undefined } as unknown as HarnessContext['trajectory'],
    mode: 'train',
  };
}

describe('JinnRepoEvaluatorHarness — supports', () => {
  it('claims solverType=jinn-repo.v1 with role=evaluation only', () => {
    const h = new JinnRepoEvaluatorHarness();
    expect(h.supports({ solverType: 'jinn-repo.v1', role: 'evaluation' })).toBe(true);
    expect(h.supports({ solverType: 'jinn-repo.v1', role: 'restoration' })).toBe(false);
    expect(h.supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(false);
    expect(h.supports({ solverType: 'jinn-repo.v1' })).toBe(false);
  });
});

describe('JinnRepoEvaluatorHarness — run', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-repo-evaluator-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('maps a passing grade to a jinn-repo-verdict.v1 payload with passed:true', async () => {
    const grade = vi.fn().mockResolvedValue({ passed: true, unscorable: false, logExcerpt: 'all green' });
    const h = new JinnRepoEvaluatorHarness({
      loadPool: () => [poolItem()],
      grade,
    });
    const sol = await h.run(buildHarnessContext(buildEvaluationTask(buildSolverEnvelope()), dir));

    expect(sol.verdictPayload).toEqual({
      schemaVersion: 'jinn-repo-verdict.v1',
      passed: true,
      test_log_excerpt: 'all green',
    });
    expect(sol.gating).toMatchObject({ verdict: 'PASS', passed: true });
    // The grade was called with the resolved pool item + the candidate patch.
    expect(grade).toHaveBeenCalledWith({
      task: poolItem(),
      solution: { patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-hello\n+world\n' },
    });
  });

  it('maps a failing grade to passed:false', async () => {
    const grade = vi.fn().mockResolvedValue({ passed: false, unscorable: false, logExcerpt: 'red' });
    const h = new JinnRepoEvaluatorHarness({ loadPool: () => [poolItem()], grade });
    const sol = await h.run(buildHarnessContext(buildEvaluationTask(buildSolverEnvelope()), dir));

    expect(sol.verdictPayload).toMatchObject({ schemaVersion: 'jinn-repo-verdict.v1', passed: false });
    expect(sol.gating).toMatchObject({ verdict: 'FAIL', passed: false });
  });

  it('throws SkippableError on an unscorable grade — never coerces to passed:false', async () => {
    const grade = vi.fn().mockResolvedValue({ passed: null, unscorable: true, logExcerpt: 'install-failed' });
    const h = new JinnRepoEvaluatorHarness({ loadPool: () => [poolItem()], grade });
    const ctx = buildHarnessContext(buildEvaluationTask(buildSolverEnvelope()), dir);
    await expect(h.run(ctx)).rejects.toBeInstanceOf(SkippableError);
    await expect(h.run(ctx)).rejects.toMatchObject({ reason: 'eval_unscorable' });
  });

  it('throws SkippableError when the instance_id is not in the pool — no silent pass', async () => {
    const grade = vi.fn();
    const h = new JinnRepoEvaluatorHarness({ loadPool: () => [poolItem()], grade });
    const ctx = buildHarnessContext(buildEvaluationTask(buildSolverEnvelope(), 'jinn-mono-absent'), dir);
    await expect(h.run(ctx)).rejects.toBeInstanceOf(SkippableError);
    await expect(h.run(ctx)).rejects.toMatchObject({ reason: 'instance_not_in_pool' });
    expect(grade).not.toHaveBeenCalled();
  });

  it('rejects an envelope that is not a jinn-repo.v1 solution', async () => {
    const h = new JinnRepoEvaluatorHarness({ loadPool: () => [poolItem()], grade: vi.fn() });
    const ctx = buildHarnessContext(
      buildEvaluationTask(buildSolverEnvelope({ solverType: 'swe-rebench-v2.v1' })),
      dir,
    );
    await expect(h.run(ctx)).rejects.toThrow(/expected jinn-repo\.v1\/solution/);
  });

  // Merged-pr regression: the gold-grading path (pool lookup + `grade`) is
  // untouched by #1891 — `gradeLive` must never be invoked for it.
  it('never calls gradeLive for a merged-pr evaluation task', async () => {
    const grade = vi.fn().mockResolvedValue({ passed: true, unscorable: false, logExcerpt: '' });
    const gradeLive = vi.fn();
    const h = new JinnRepoEvaluatorHarness({ loadPool: () => [poolItem()], grade, gradeLive });
    const sol = await h.run(buildHarnessContext(buildEvaluationTask(buildSolverEnvelope()), dir));

    expect(sol.verdictPayload).toMatchObject({ schemaVersion: 'jinn-repo-verdict.v1' });
    expect(grade).toHaveBeenCalledTimes(1);
    expect(gradeLive).not.toHaveBeenCalled();
  });
});

describe('JinnRepoEvaluatorHarness — run (live-issue, issue #1891)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-repo-evaluator-live-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('maps a passing mechanical grade to a jinn-repo-verdict.v2 payload with gates', async () => {
    const gradeLive = vi.fn().mockResolvedValue({
      applies: true,
      typecheck: true,
      tests: true,
      passed: true,
      unscorable: false,
      logExcerpt: '',
    });
    const grade = vi.fn();
    const h = new JinnRepoEvaluatorHarness({ grade, gradeLive });
    const sol = await h.run(
      buildHarnessContext(buildLiveEvaluationTask(buildSolverEnvelope()), dir),
    );

    expect(sol.verdictPayload).toEqual({
      schemaVersion: 'jinn-repo-verdict.v2',
      passed: true,
      test_log_excerpt: '',
      gates: { applies: true, typecheck: true, tests: true },
    });
    expect(sol.gating).toMatchObject({ verdict: 'PASS', passed: true });
    expect(sol.informational).toEqual({ instance_id: LIVE_INSTANCE_ID });
    // Never falls through to pool-based grading — no gold exists for live-issue.
    expect(grade).not.toHaveBeenCalled();
    expect(gradeLive).toHaveBeenCalledWith({
      spec: expect.objectContaining({ source: 'live-issue', instance_id: LIVE_INSTANCE_ID }),
      solution: { patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-hello\n+world\n' },
    });
  });

  it('maps a typecheck-failed grade to passed:false with the failing gate recorded', async () => {
    const gradeLive = vi.fn().mockResolvedValue({
      applies: true,
      typecheck: false,
      tests: false,
      passed: false,
      unscorable: false,
      logExcerpt: 'typecheck-failed[client]: ...',
    });
    const h = new JinnRepoEvaluatorHarness({ gradeLive });
    const sol = await h.run(
      buildHarnessContext(buildLiveEvaluationTask(buildSolverEnvelope()), dir),
    );

    expect(sol.verdictPayload).toMatchObject({
      schemaVersion: 'jinn-repo-verdict.v2',
      passed: false,
      gates: { applies: true, typecheck: false, tests: false },
    });
    expect(sol.gating).toMatchObject({ verdict: 'FAIL', passed: false });
  });

  it('maps an applies:false grade (patch does not apply) to a graded FAIL, not unscorable', async () => {
    const gradeLive = vi.fn().mockResolvedValue({
      applies: false,
      typecheck: false,
      tests: false,
      passed: false,
      unscorable: false,
      logExcerpt: 'candidate patch does not apply',
    });
    const h = new JinnRepoEvaluatorHarness({ gradeLive });
    const sol = await h.run(
      buildHarnessContext(buildLiveEvaluationTask(buildSolverEnvelope()), dir),
    );

    expect(sol.verdictPayload).toMatchObject({
      schemaVersion: 'jinn-repo-verdict.v2',
      passed: false,
      gates: { applies: false, typecheck: false, tests: false },
    });
  });

  it('throws SkippableError on an unscorable live grade — never coerces to passed:false', async () => {
    const gradeLive = vi.fn().mockResolvedValue({
      applies: false,
      typecheck: false,
      tests: false,
      passed: false,
      unscorable: true,
      logExcerpt: 'install-failed[client]',
    });
    const h = new JinnRepoEvaluatorHarness({ gradeLive });
    const ctx = buildHarnessContext(buildLiveEvaluationTask(buildSolverEnvelope()), dir);
    await expect(h.run(ctx)).rejects.toBeInstanceOf(SkippableError);
    await expect(h.run(ctx)).rejects.toMatchObject({ reason: 'eval_unscorable' });
  });

  it('never consults the pool for a live-issue task', async () => {
    const loadPool = vi.fn(() => [poolItem()]);
    const gradeLive = vi.fn().mockResolvedValue({
      applies: true,
      typecheck: true,
      tests: true,
      passed: true,
      unscorable: false,
      logExcerpt: '',
    });
    const h = new JinnRepoEvaluatorHarness({ loadPool, gradeLive });
    await h.run(buildHarnessContext(buildLiveEvaluationTask(buildSolverEnvelope()), dir));
    expect(loadPool).not.toHaveBeenCalled();
  });

  // Issue #1891 Finding 2: a live-issue spec with a field defect (raw
  // `source: 'live-issue'` but a missing/invalid field, e.g. `issue_number`)
  // must throw a loud, specific error and NEVER fall through to the
  // merged-pr pool-lookup path — a fall-through there would surface a
  // misleading `instance_not_in_pool` SkippableError and be re-attempted
  // forever, since the raw source is never actually a merged-pr task.
  it('throws a specific error for a malformed live-issue spec and never touches the pool', async () => {
    const loadPool = vi.fn(() => [poolItem()]);
    const grade = vi.fn();
    const gradeLive = vi.fn();
    const h = new JinnRepoEvaluatorHarness({ loadPool, grade, gradeLive });
    const ctx = buildHarnessContext(
      buildMalformedLiveEvaluationTask(buildSolverEnvelope()),
      dir,
    );

    await expect(h.run(ctx)).rejects.toThrow(/malformed live-issue task spec/);
    await expect(h.run(ctx)).rejects.toThrow(/issue_number/);
    expect(loadPool).not.toHaveBeenCalled();
    expect(grade).not.toHaveBeenCalled();
    expect(gradeLive).not.toHaveBeenCalled();
  });
});

describe('JinnRepoEvaluatorHarness — canAttempt', () => {
  it('accepts a merged-pr evaluation task with a restorationResult', async () => {
    const h = new JinnRepoEvaluatorHarness();
    const verdict = await h.canAttempt(buildEvaluationTask(buildSolverEnvelope()));
    expect(verdict).toEqual({ ok: true });
  });

  it('accepts a legacy evaluation task whose spec has no `source` field (defaults merged-pr)', async () => {
    // buildEvaluationTask's spec already omits `source` — this is the
    // pre-union shape every jinn-repo evaluation task carried historically.
    const h = new JinnRepoEvaluatorHarness();
    const verdict = await h.canAttempt(buildEvaluationTask(buildSolverEnvelope()));
    expect(verdict.ok).toBe(true);
  });

  it('accepts a live-issue evaluation task with a restorationResult (issue #1891)', async () => {
    const h = new JinnRepoEvaluatorHarness();
    const verdict = await h.canAttempt(buildLiveEvaluationTask(buildSolverEnvelope()));
    expect(verdict).toEqual({ ok: true });
  });

  // Issue #1891 Finding 2: a spec with raw `source: 'live-issue'` but a field
  // defect (here, a missing `issue_number`) must be rejected here with a
  // specific reason — not accepted blind and re-attempted forever once it
  // throws deep inside `run()`.
  it('rejects a malformed live-issue evaluation task spec (missing issue_number)', async () => {
    const h = new JinnRepoEvaluatorHarness();
    const verdict = await h.canAttempt(buildMalformedLiveEvaluationTask(buildSolverEnvelope()));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/^malformed live-issue task spec:/);
      expect(verdict.reason).toMatch(/issue_number/);
    }
  });

  it('rejects a live-issue evaluation task with no restorationResult', async () => {
    const h = new JinnRepoEvaluatorHarness();
    const task = buildLiveEvaluationTask(buildSolverEnvelope());
    task.context = {};
    const verdict = await h.canAttempt(task);
    expect(verdict).toEqual({ ok: false, reason: 'context.restorationResult required' });
  });

  it('rejects wrong solverType before role/spec checks', async () => {
    const h = new JinnRepoEvaluatorHarness();
    const verdict = await h.canAttempt({
      id: 't', description: 'd', solverType: 'swe-rebench-v2.v1', role: 'evaluation',
    });
    expect(verdict).toEqual({ ok: false, reason: 'solverType is not jinn-repo.v1' });
  });
});

describe('JinnRepoEvaluatorHarness — isReady', () => {
  it('reports requires-live-daemon in stub mode', async () => {
    const h = new JinnRepoEvaluatorHarness({ stub: true });
    const r = await h.isReady!();
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('requires live daemon');
  });

  it('reports ready when not stubbed', async () => {
    const h = new JinnRepoEvaluatorHarness();
    const r = await h.isReady!();
    expect(r.ready).toBe(true);
  });
});
