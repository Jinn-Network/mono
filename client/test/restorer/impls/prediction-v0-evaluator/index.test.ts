import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PredictionV0Evaluator } from '../../../../src/restorer/impls/prediction-v0-evaluator/index.js';
import { makeValidIntent, makeSignedManifest, makeEvalRestorationJob } from './test-helpers.js';
import { TrajectoryCollector } from '../../../../src/trajectory/index.js';

function makeCtx(intent: any, deps: any) {
  const tmp = mkdtempSync(join(tmpdir(), 'pred-eval-'));
  return {
    intent,
    intentCid: 'intent-cid',
    implStateDir: tmp,
    workingDir: tmp,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 0,
    trajectory: new TrajectoryCollector({ intentCid: 'test-intent-cid', runId: 'test-run-id' }),
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

describe('PredictionV0Evaluator — verdict pipeline', () => {
  const evaluatorPk = ('0x' + 'e'.repeat(64)) as `0x${string}`;

  it('PASS with correct prediction (p=0.55, oracle > threshold)', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, intentCid: 'intent-cid' });
    const evalIntent = makeEvalRestorationJob(manifest, intent);
    const evaluator = new PredictionV0Evaluator({
      evaluatorPk,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('PASS');
    expect(out.gating.score).toBe('797500000000000000');
    expect(out.gating.groundTruth).toBe('YES');
  });

  it('verdict artifact has correct schemaVersion metadata', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, intentCid: 'intent-cid' });
    const evalIntent = makeEvalRestorationJob(manifest, intent);
    const evaluator = new PredictionV0Evaluator({
      evaluatorPk,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });

    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));

    expect(out.gating.verdict).toBe('PASS');
    expect(out.artifacts[0]?.metadata).toMatchObject({ verdict: 'PASS' });
  });

  it('REJECTED when submittedAt > window.endTs', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ submittedAt: intent.window.endTs + 1, intentCid: 'intent-cid' });
    const evalIntent = makeEvalRestorationJob(manifest, intent);
    const evaluator = new PredictionV0Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('REJECTED');
    expect(out.gating.score).toBe('0');
  });

  it('FAIL on bad signature', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ corruptSignature: true, intentCid: 'intent-cid' });
    const evalIntent = makeEvalRestorationJob(manifest, intent);
    const evaluator = new PredictionV0Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('FAIL');
    expect(out.gating.score).toBe('0');
  });

  it('INDETERMINATE when context.restorationIntentCid is missing (legacy eval payload)', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ intentCid: 'intent-cid' });
    const evalIntent = makeEvalRestorationJob(manifest, intent, { omitRestorationIntentCid: true });
    const evaluator = new PredictionV0Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));
    expect(out.gating.verdict).toBe('INDETERMINATE');
  });

  it('emits venue_io + state_transition + artifact.emit spans on success', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, intentCid: 'intent-cid' });
    const evalIntent = makeEvalRestorationJob(manifest, intent);
    const evaluator = new PredictionV0Evaluator({
      evaluatorPk: ('0x' + 'e'.repeat(64)) as `0x${string}`,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const ctx = makeCtx(evalIntent, spanningDeps('3501'));
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

  it('restorationEnvelope.cid uses context restorationEnvelopeCid when present', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, intentCid: 'intent-cid' });
    const manifestJson = JSON.stringify(manifest);
    const evalIntent = makeEvalRestorationJob(manifest, intent, {
      restorationEnvelopeCid: 'f01551220abcdef1234',
    });
    const evaluator = new PredictionV0Evaluator({
      evaluatorPk: ('0x' + 'e'.repeat(64)) as `0x${string}`,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));
    const vp = out.verdictPayload as { restorationEnvelope: { cid: string; sha256: string } };
    expect(vp.restorationEnvelope.cid).toBe('f01551220abcdef1234');
    const expectedSha256 = createHash('sha256').update(manifestJson).digest('hex');
    expect(vp.restorationEnvelope.sha256).toBe(expectedSha256);
  });

  it('restorationEnvelope.cid falls back to bafy-unknown when no context key or requestId', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ probability: '0.55', submittedAt: 100, intentCid: 'intent-cid' });
    const evalIntent = makeEvalRestorationJob(manifest, intent);
    // makeEvalRestorationJob sets restorationRequestId to 0x00...00 (not empty)
    const evaluator = new PredictionV0Evaluator({
      evaluatorPk: ('0x' + 'e'.repeat(64)) as `0x${string}`,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await evaluator.run(makeCtx(evalIntent, spanningDeps('3501')));
    const vp = out.verdictPayload as { restorationEnvelope: { cid: string; sha256: string } };
    // falls back to restorationRequestId (0x00...00) since no RESTORATION_ENVELOPE_CID_CONTEXT_KEY
    expect(vp.restorationEnvelope.cid).not.toBe('bafy-unknown');
    expect(vp.restorationEnvelope.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('INDETERMINATE when oracle has no spanning round', async () => {
    const intent = makeValidIntent();
    const manifest = await makeSignedManifest({ intentCid: 'intent-cid' });
    const evalIntent = makeEvalRestorationJob(manifest, intent);
    const evaluator = new PredictionV0Evaluator({ evaluatorPk, evaluatorSafeAddress: '0x0000000000000000000000000000000000000003' });
    const out = await evaluator.run(makeCtx(evalIntent, {
      oraclePriceAtResolveTs: async () => ({
        round: { roundId: 1n, answer: 350_000_000_000n, startedAt: 0, updatedAt: 0, answeredInRound: 1n, decimals: 8 },
        nextRound: null,
        spanning: false,
      }),
    }));
    expect(out.gating.verdict).toBe('INDETERMINATE');
  });
});
