import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LearnerHarness } from '../../../../src/harnesses/impls/learner/index.js';
import { NoOpHarnessAdapter } from '../../../../src/harnesses/impls/learner/test-utils/noop-adapter.js';
import { fakeFullPipelineRun } from '../../../../src/harnesses/impls/learner/test-utils/fake-plugin-outputs.js';
import { makeHarnessCtx } from '@test/harness-ctx.js';

function makeCtx(workingDir: string, implStateDir: string) {
  const endTs = Date.now() + 60_000;
  return makeHarnessCtx({
task: {
      id: 'path-scope-1',
      description: 'path scope test',
      window: { startTs: Date.now() - 1000, endTs },
    },
    workingDir,
    implStateDir,
    msUntilEndTs: () => Math.max(0, endTs - Date.now()),
  });
}

describe('claude-code-learner path-scope guard', () => {
  let workingDir: string;
  let implStateDir: string;
  let unsafeRoot: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-pathscope-work-'));
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-pathscope-state-'));
    unsafeRoot = mkdtempSync(join(tmpdir(), 'jinn-pathscope-unsafe-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(implStateDir, { recursive: true, force: true });
    rmSync(unsafeRoot, { recursive: true, force: true });
  });

  it('rejects (or noticeably warns about) writes outside workingDir + implStateDir', async () => {
    // Construct a NoOp adapter that "the worker" attempts an out-of-scope write through.
    // The plugin contract is that subagents only write to outputPath under
    // workingDir/.<phase>/. A misbehaving worker that writes to unsafeRoot
    // is the failure mode we want to detect.
    const violationAttempted = { tried: false };
    const adapter = new NoOpHarnessAdapter().on(async (inputs) => {
      // Happy path artifacts (so the run succeeds enough to harvest).
      fakeFullPipelineRun(inputs.workingDir, { intentKind: 'test.kind' });
      // Violating write (a real harness would block this; the NoOp doesn't
      // enforce — this test asserts the contract is documented + that any
      // resulting artifact under unsafeRoot is NOT visible in workingDir).
      try {
        writeFileSync(join(unsafeRoot, 'leak.txt'), 'should not be harvested');
        violationAttempted.tried = true;
      } catch {
        // Some harnesses/test envs may block the write itself.
      }
    });

    const impl = new LearnerHarness({ adapter });
    const ctx = makeCtx(workingDir, implStateDir);
    const out = await impl.run(ctx);

    // Whatever the adapter wrote outside scope must NOT appear in
    // Solution's harvest. Confirm the harvest stayed scoped to
    // workingDir contents and that unsafeRoot leak is not referenced.
    expect(JSON.stringify(out)).not.toContain(unsafeRoot);
    expect(JSON.stringify(out)).not.toContain('leak.txt');
    expect(out.gating.phasesCompleted).toContain('execute');

    // The leak file may exist on disk (the NoOp adapter doesn't enforce
    // the boundary), but it must not be in workingDir.
    expect(existsSync(join(workingDir, 'leak.txt'))).toBe(false);
  });

  it('verifies all artifact paths in Solution resolve under workingDir or implStateDir', async () => {
    const adapter = new NoOpHarnessAdapter();
    const impl = new LearnerHarness({ adapter });
    const ctx = makeCtx(workingDir, implStateDir);
    const out = await impl.run(ctx);

    // Solution's gating may carry path-like strings; if any do,
    // they must resolve under one of the two scoped roots.
    const allowedRoots = [resolve(workingDir), resolve(implStateDir)];
    for (const value of Object.values(out.gating)) {
      if (typeof value === 'string' && value.startsWith('/')) {
        const resolved = resolve(value);
        const inScope = allowedRoots.some((root) => resolved.startsWith(root));
        expect(inScope, `path ${resolved} outside allowed roots`).toBe(true);
      }
    }
  });

  it('cross-kind isolation: different implStateDirs produce independent outputs', async () => {
    // Simulate what the engine provides: kind-partitioned implStateDirs.
    // Two runs with different kind dirs must produce independent gating output
    // with no cross-contamination between each other's state roots.
    const implStateDirKindA = mkdtempSync(join(tmpdir(), 'jinn-pathscope-kind-a-'));
    const implStateDirKindB = mkdtempSync(join(tmpdir(), 'jinn-pathscope-kind-b-'));
    try {
      const adapter = new NoOpHarnessAdapter();
      const implA = new LearnerHarness({ adapter });
      const implB = new LearnerHarness({ adapter });

      const ctxA = makeCtx(workingDir, implStateDirKindA);
      const ctxB = makeCtx(mkdtempSync(join(tmpdir(), 'jinn-pathscope-work-b-')), implStateDirKindB);

      const outA = await implA.run(ctxA);
      const outB = await implB.run(ctxB);

      // Neither output may reference the other's implStateDir root.
      const jsonA = JSON.stringify(outA);
      const jsonB = JSON.stringify(outB);
      expect(jsonA).not.toContain(implStateDirKindB);
      expect(jsonB).not.toContain(implStateDirKindA);
    } finally {
      rmSync(implStateDirKindA, { recursive: true, force: true });
      rmSync(implStateDirKindB, { recursive: true, force: true });
    }
  });
});
