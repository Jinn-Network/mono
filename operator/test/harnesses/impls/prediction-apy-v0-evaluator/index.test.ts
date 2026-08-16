import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../../../src/util/canonical-json.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { PredictionApyV0Evaluator } from '../../../../src/harnesses/impls/prediction-apy-v0-evaluator/index.js';
import { signCanonical } from '../../../../src/harnesses/engine/signing.js';
import { SOLUTION_TASK_CID_CONTEXT_KEY, SOLUTION_ENVELOPE_CID_CONTEXT_KEY } from '../../../../src/harnesses/impls/evaluation-context.js';
import { PredictionApyV0VerdictPayloadSchema } from '../../../../src/types/payloads/prediction-apy-v0.js';
import type { Task } from '../../../../src/types/task.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import { TrajectoryCollector } from '../../../../src/trajectory/index.js';

const PK = ('0x' + 'e'.repeat(64)) as `0x${string}`;
const AGENT_PK = ('0x' + '1'.repeat(64)) as `0x${string}`;

const intentProv = (cid: string) => ({
  cid,
  onchainCreationTx: '0x' + 'ab'.repeat(32),
  onchainCreationBlock: 1,
  requestId: '0x' + 'cd'.repeat(32),
});

async function makeSignedApyManifestJson(overrides: { submittedAt?: number; taskCid?: string; corruptSignature?: boolean } = {}) {
  const account = privateKeyToAccount(AGENT_PK);
  const unsigned: Record<string, unknown> = {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'prediction.apy.v0',
    role: 'solution',
    generatedAt: 1_000,
    task: intentProv(overrides.taskCid ?? 'expected-cid'),
    participant: { safeAddress: '0x' + '44'.repeat(20), agentEoa: account.address },
    window: { startTs: 0, endTs: 600_000 },
    executor: {
      implName: 'claude-mcp-prediction-apy',
      implVersion: '1.0.0',
      clientGitSha: 'dev',
      codeDigest: 'sha256:' + '0'.repeat(64),
      runtimeBundleDigest: 'sha256:' + '1'.repeat(64),
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: account.address },
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: {
      prediction: {
        predictedBps: '100',
        submittedAt: overrides.submittedAt ?? 100_000,
        modelId: 'apy-persistence.v1',
      },
    },
  };
  const s = await signCanonical(unsigned, AGENT_PK, account.address);
  const full = {
    ...unsigned,
    signature: {
      algo: 'secp256k1' as const,
      signer: account.address,
      hash: s.hash,
      sig: overrides.corruptSignature ? (('0x' + 'a'.repeat(130)) as `0x${string}`) : s.sig,
    },
  };
  return JSON.stringify(full);
}

function makeEvalIntent(
  manifestJson: string,
  options?: { omitSolutionTaskCid?: boolean; solutionTaskCid?: string; solutionEnvelopeCid?: string },
): Task {
  return {
    id: 'eval-apy',
    description: 'e',
    solverType: 'prediction.apy.v0',
    role: 'evaluation',
    window: { startTs: 0, endTs: 600_000 },
    spec: {
      kind: 'prediction.apy.v0',
      oracle: {
        venue: 'aave-v3-base-sepolia',
        pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
        reserve: '0x31d3A7711a10C45D72649D51E1c8D74282702572',
        reserveSymbol: 'USDC',
      },
      metric: { type: 'supply-apy-twa-bps', twaWindowSeconds: 3600, sampleCount: 12, toleranceBps: 100 },
      question: { resolveTs: 900_000 },
    },
    eligibility: {},
    context: {
      restorationResult: manifestJson,
      ...(options?.omitSolutionTaskCid
        ? {}
        : { [SOLUTION_TASK_CID_CONTEXT_KEY]: options?.solutionTaskCid ?? 'expected-cid' }),
      ...(options?.solutionEnvelopeCid
        ? { [SOLUTION_ENVELOPE_CID_CONTEXT_KEY]: options.solutionEnvelopeCid }
        : {}),
    },
  } as unknown as Task;
}

function makeCtx(task: Task, taskCid: string, testDeps: Record<string, unknown> = {}): HarnessContext & { trajectory: TrajectoryCollector } {
  const d = mkdtempSync(join(tmpdir(), 'apy-eval-'));
  return {
    task: task,
    taskCid,
    implStateDir: d,
    workingDir: d,
    log: () => {},
    abort: new AbortController().signal,
    msUntilEndTs: () => 0,
    trajectory: new TrajectoryCollector({ taskCid: 'test-task-cid', runId: 'test-run-id' }),
    _testDeps: testDeps,
  } as unknown as HarnessContext & { trajectory: TrajectoryCollector };
}

describe('PredictionApyV0Evaluator', () => {
  it('PASS with stubbed TWA and matching taskCid', async () => {
    const manifest = await makeSignedApyManifestJson();
    const evalTask = makeEvalIntent(manifest);
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalTask, 'expected-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.gating.verdict).toBe('PASS');
  });

  it('REJECTED when submitted after window', async () => {
    const manifest = await makeSignedApyManifestJson({ submittedAt: 700_000 });
    const evalTask = makeEvalIntent(manifest);
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalTask, 'expected-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.gating.verdict).toBe('REJECTED');
  });

  it('FAIL when manifest task cid does not match context.solutionTaskCid', async () => {
    const manifest = await makeSignedApyManifestJson({ taskCid: 'wrong' });
    const evalTask = makeEvalIntent(manifest);
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalTask, 'expected-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.gating.verdict).toBe('FAIL');
  });

  it('uses context.solutionTaskCid when it differs from ctx.taskCid (eval job vs solution)', async () => {
    const manifest = await makeSignedApyManifestJson({ taskCid: 'solution-cid' });
    const evalTask = makeEvalIntent(manifest, { solutionTaskCid: 'solution-cid' });
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalTask, 'evaluation-task-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.gating.verdict).toBe('PASS');
  });

  it('INDETERMINATE when context.solutionTaskCid is missing', async () => {
    const manifest = await makeSignedApyManifestJson();
    const evalTask = makeEvalIntent(manifest, { omitSolutionTaskCid: true });
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalTask, 'any-eval-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.gating.verdict).toBe('INDETERMINATE');
  });

  it('FAIL on bad signature', async () => {
    const manifest = await makeSignedApyManifestJson({ corruptSignature: true });
    const evalTask = makeEvalIntent(manifest);
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalTask, 'expected-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.gating.verdict).toBe('FAIL');
  });

  it('emits venue_io + state_transition + artifact.emit spans on successful run', async () => {
    const manifest = await makeSignedApyManifestJson();
    const evalTask = makeEvalIntent(manifest);
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const ctx = makeCtx(evalTask, 'expected-cid', {
      twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
    });
    await ev.run(ctx);

    const { spans } = ctx.trajectory.snapshot();
    const kinds = spans.map((s) => s.attributes['jinn.span.kind']);

    expect(kinds).toContain('jinn.venue_io');
    expect(kinds).toContain('jinn.state_transition');
    expect(kinds).toContain('jinn.artifact.emit');

    const venueSpan = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.venue_io');
    expect(venueSpan!.attributes['http.response.status_code']).toBe(200);
    expect(venueSpan!.attributes['venue.id']).toBe('aave-v3');

    const stateSpan = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.state_transition');
    expect(stateSpan!.attributes['jinn.state.from']).toBe('FETCHED');
    expect(stateSpan!.attributes['jinn.state.to']).toBe('SCORED');

    const artifactSpan = spans.find((s) => s.attributes['jinn.span.kind'] === 'jinn.artifact.emit');
    expect(artifactSpan!.attributes['jinn.artifact.artifactType']).toBe('evaluation_verdict');
    expect(typeof artifactSpan!.attributes['jinn.artifact.sha256']).toBe('string');
  });

  it('verdictPayload conforms to PredictionApyV0VerdictPayloadSchema on PASS', async () => {
    const manifest = await makeSignedApyManifestJson();
    const evalTask = makeEvalIntent(manifest);
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalTask, 'expected-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    expect(out.verdictPayload).toBeDefined();
    const parsed = PredictionApyV0VerdictPayloadSchema.safeParse(out.verdictPayload);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.verdict).toBe('PASS');
      expect(parsed.data.scoreBasis).toBe('absolute-error-linear.v1');
      expect(parsed.data.solutionEnvelope.cid).toBe('bafy-unknown');
      // sha256 is now computed from the restoration envelope JSON (not a placeholder)
      expect(parsed.data.solutionEnvelope.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.data.verificationOfRestoration.claimedTier).toBe('self-signed');
      expect(parsed.data.verificationOfRestoration.overall).toBe('valid');
      expect(parsed.data.claimed.predictedBps).toBe('100');
      expect(parsed.data.claimed.modelId).toBe('apy-persistence.v1');
    }
  });

  it('solutionEnvelope.cid uses threaded context key + sha256 matches manifest JSON', async () => {
    const manifest = await makeSignedApyManifestJson();
    const envelopeCid = 'f01551220deadbeef1234567890abcdef';
    const evalTask = makeEvalIntent(manifest, { solutionEnvelopeCid: envelopeCid });
    const ev = new PredictionApyV0Evaluator({
      evaluatorPk: PK,
      evaluatorSafeAddress: '0x0000000000000000000000000000000000000003',
    });
    const out = await ev.run(
      makeCtx(evalTask, 'expected-cid', {
        twApyBpsOverWindow: async () => ({ twApyBps: 100, sampleCount: 12 }),
      }),
    );
    const vp = out.verdictPayload as { solutionEnvelope: { cid: string; sha256: string } };
    expect(vp.solutionEnvelope.cid).toBe(envelopeCid);
    // Evaluator uses JCS canonical bytes (canonicalJson) to match the upload pipeline.
    const expectedSha256 = createHash('sha256').update(canonicalJson(JSON.parse(manifest))).digest('hex');
    expect(vp.solutionEnvelope.sha256).toBe(expectedSha256);
  });
});
