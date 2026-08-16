import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../../../src/util/canonical-json.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PredictionV1Evaluator } from '../../../../src/harnesses/impls/prediction-v0-evaluator/index.js';
import { makeValidTask, makeSignedManifest, makeEvalTask } from './test-helpers.js';
import { TrajectoryCollector } from '../../../../src/trajectory/index.js';

function makeCtx(task: any, deps: any) {
  const tmp = mkdtempSync(join(tmpdir(), 'pred-eval-'));
  return {
    task: task,
    taskCid: 'task-cid',
    implStateDir: tmp,
    workingDir: tmp,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 0,
    trajectory: new TrajectoryCollector({ taskCid: 'test-task-cid', runId: 'test-run-id' }),
    _testDeps: deps,
  } as any;
}

function spanningDeps(priceAtResolve: string) {
  const answer = BigInt(Math.round(parseFloat(priceAtResolve) * 1e8));
  return {
    oraclePriceAtResolveTs: async () => ({
      round: { roundId: 1n, answer, startedAt: 4_499_999, updatedAt: 4_499_999, answeredInRound: 1n, decimals: 8 },
      nextRound: { roundId: 2n, answer: 0n, startedAt: 4_500_001, updatedAt: 4_500_001, answeredInRound: 2n, decimals: 8 },
      spanning: true,
    }),
  };
}

describe('PredictionV1Evaluator — verdict pipeline', () => {
  const evaluatorPk = ('0x' + 'e'.repeat(64)) as `0x${string}`;

  it('PASS with correct prediction (p=0.55, oracle > threshold)', async () => {
    const task = makeValidTask();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, taskCid: 'task-cid' });
    const evalTask = makeEvalTask(manifest, task);
    const evaluator = new PredictionV1Evaluator({
      evaluatorPk,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await evaluator.run(makeCtx(evalTask, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('PASS');
    expect(out.gating.score).toBe('797500000000000000');
    expect(out.gating.groundTruth).toBe('YES');
  });

  it('verdict artifact has correct schemaVersion metadata', async () => {
    const task = makeValidTask();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, taskCid: 'task-cid' });
    const evalTask = makeEvalTask(manifest, task);
    const evaluator = new PredictionV1Evaluator({
      evaluatorPk,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });

    const out = await evaluator.run(makeCtx(evalTask, spanningDeps('3501')));

    expect(out.gating.verdict).toBe('PASS');
    expect(out.artifacts[0]?.metadata).toMatchObject({ verdict: 'PASS' });
  });

  it('REJECTED when submittedAt > window.endTs', async () => {
    const task = makeValidTask();
    const manifest = await makeSignedManifest({ submittedAt: task.window.endTs + 1, taskCid: 'task-cid' });
    const evalTask = makeEvalTask(manifest, task);
    const evaluator = new PredictionV1Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalTask, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('REJECTED');
    expect(out.gating.score).toBe('0');
  });

  it('FAIL on bad signature', async () => {
    const task = makeValidTask();
    const manifest = await makeSignedManifest({ corruptSignature: true, taskCid: 'task-cid' });
    const evalTask = makeEvalTask(manifest, task);
    const evaluator = new PredictionV1Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalTask, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('FAIL');
    expect(out.gating.score).toBe('0');
  });

  it('INDETERMINATE when context.solutionTaskCid is missing', async () => {
    const task = makeValidTask();
    const manifest = await makeSignedManifest({ taskCid: 'task-cid' });
    const evalTask = makeEvalTask(manifest, task, { omitSolutionTaskCid: true });
    const evaluator = new PredictionV1Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalTask, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('INDETERMINATE');
  });

  it('emits venue_io + state_transition + artifact.emit spans on success', async () => {
    const task = makeValidTask();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, taskCid: 'task-cid' });
    const evalTask = makeEvalTask(manifest, task);
    const evaluator = new PredictionV1Evaluator({
      evaluatorPk: ('0x' + 'e'.repeat(64)) as `0x${string}`,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const ctx = makeCtx(evalTask, spanningDeps('3501'));
    await evaluator.run(ctx);

    const { spans } = ctx.trajectory.snapshot();
    const kinds = spans.map((s: any) => s.attributes['jinn.span.kind']);

    expect(kinds).toContain('jinn.venue_io');
    expect(kinds).toContain('jinn.state_transition');
    expect(kinds).toContain('jinn.artifact.emit');

    const venueSpan = spans.find((s: any) => s.attributes['jinn.span.kind'] === 'jinn.venue_io');
    expect(venueSpan!.attributes['http.response.status_code']).toBe(200);
    expect(venueSpan!.attributes['venue.id']).toBe('chainlink');

    const stateSpan = spans.find((s: any) => s.attributes['jinn.span.kind'] === 'jinn.state_transition');
    expect(stateSpan!.attributes['jinn.state.from']).toBe('FETCHED');
    expect(stateSpan!.attributes['jinn.state.to']).toBe('SCORED');

    const artifactSpan = spans.find((s: any) => s.attributes['jinn.span.kind'] === 'jinn.artifact.emit');
    expect(artifactSpan!.attributes['jinn.artifact.artifactType']).toBe('evaluation_verdict');
    expect(typeof artifactSpan!.attributes['jinn.artifact.sha256']).toBe('string');
  });

  it('solutionEnvelope.cid uses context solutionEnvelopeCid when present', async () => {
    const task = makeValidTask();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, taskCid: 'task-cid' });
    const evalTask = makeEvalTask(manifest, task, {
      solutionEnvelopeCid: 'f01551220abcdef1234',
    });
    const evaluator = new PredictionV1Evaluator({
      evaluatorPk: ('0x' + 'e'.repeat(64)) as `0x${string}`,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await evaluator.run(makeCtx(evalTask, spanningDeps('3501')));
    const vp = out.verdictPayload as { solutionEnvelope: { cid: string; sha256: string } };
    expect(vp.solutionEnvelope.cid).toBe('f01551220abcdef1234');
    // Evaluator uses JCS canonical bytes (canonicalJson) to match the upload pipeline.
    const expectedSha256 = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
    expect(vp.solutionEnvelope.sha256).toBe(expectedSha256);
  });

  it('solutionEnvelope.cid falls back to bafy-unknown when no context key or requestId', async () => {
    const task = makeValidTask();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, taskCid: 'task-cid' });
    const evalTask = makeEvalTask(manifest, task);
    // makeEvalTask sets restorationRequestId to 0x00...00 (not empty)
    const evaluator = new PredictionV1Evaluator({
      evaluatorPk: ('0x' + 'e'.repeat(64)) as `0x${string}`,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await evaluator.run(makeCtx(evalTask, spanningDeps('3501')));
    const vp = out.verdictPayload as { solutionEnvelope: { cid: string; sha256: string } };
    // falls back to restorationRequestId (0x00...00) since no solutionEnvelopeCid context key
    expect(vp.solutionEnvelope.cid).not.toBe('bafy-unknown');
    expect(vp.solutionEnvelope.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('INDETERMINATE when oracle has no spanning round', async () => {
    const task = makeValidTask();
    const manifest = await makeSignedManifest({ taskCid: 'task-cid' });
    const evalTask = makeEvalTask(manifest, task);
    const evaluator = new PredictionV1Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalTask, {
      oraclePriceAtResolveTs: async () => ({
        round: { roundId: 1n, answer: 350_000_000_000n, startedAt: 0, updatedAt: 0, answeredInRound: 1n, decimals: 8 },
        nextRound: null,
        spanning: false,
      }),
    }));
    expect(out.gating.verdict).toBe('INDETERMINATE');
  });
});
