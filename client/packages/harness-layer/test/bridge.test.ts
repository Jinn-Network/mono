import { describe, it, expect } from 'vitest';
import {
  repoFromInstanceId,
  bridgeAttempts,
  toBridgeCapturedTask,
  buildBridgeEvidencePublisher,
  type AttemptRef,
  type BridgeEvidence,
  type BridgeDeps,
} from '../src/bridge.js';
import { parseTraceEnvelopeV0 } from '../src/envelope.js';
import { createMemoryLedger } from '../src/ledger.js';
import type { HarnessPublishDeps } from '../src/publish.js';

const NOW = new Date('2026-07-06T00:00:00.000Z');

function ref(over: Partial<AttemptRef> = {}): AttemptRef {
  return {
    requestId: '0x' + 'a'.repeat(64),
    chainId: 84532,
    instanceId: 'django__django-11333',
    model: 'claude-sonnet-4-6',
    manifestCid: 'bafyAttempt',
    polarity: 'pass',
    ...over,
  };
}

describe('repoFromInstanceId (SWE-bench owner__repo-N convention)', () => {
  it('derives owner/repo', () => {
    expect(repoFromInstanceId('django__django-11333')).toBe('django/django');
    expect(repoFromInstanceId('sympy__sympy-27510')).toBe('sympy/sympy');
    expect(repoFromInstanceId('scikit-learn__scikit-learn-12345')).toBe('scikit-learn/scikit-learn');
  });
  it('returns null for a malformed id', () => {
    expect(repoFromInstanceId('not-an-instance')).toBeNull();
    expect(repoFromInstanceId('')).toBeNull();
  });
});

describe('toBridgeCapturedTask (both polarities, D10)', () => {
  const ev: BridgeEvidence = { taskSummary: 'Fix duplicate rows', patch: 'diff --git a/x b/x', repo: 'django/django' };

  it('a pass becomes a completed, evaluator-verified pattern-eligible trace', () => {
    const t = toBridgeCapturedTask(ref({ polarity: 'pass' }), ev, NOW);
    expect(t.outcome.status).toBe('completed');
    expect(t.outcome.verifiabilityTier).toBe('evaluator-verified');
    expect(t.environment.harness.name).toBe('jinn-execution-ledger-bridge');
    expect(t.provenance).toBe('contributed');
    expect(t.task.distributionTags).toContain('coding');
    expect(t.steps.some((s) => s.name === 'tool:apply_patch')).toBe(true);
  });

  it('a fail becomes a failed, evaluator-verified lesson-eligible trace', () => {
    const t = toBridgeCapturedTask(ref({ polarity: 'fail' }), ev, NOW);
    expect(t.outcome.status).toBe('failed');
    expect(t.outcome.verifiabilityTier).toBe('evaluator-verified');
    const verdictStep = t.steps.find((s) => s.name === 'evaluator:verdict');
    expect(verdictStep?.attributes.actualPassed).toBe(false);
  });

  it('inserts a solver:trajectory step between patch and verdict when enriched (§8, v0.5)', () => {
    const t = toBridgeCapturedTask(ref(), { ...ev, stepTrace: '- plan [jinn.phase]\n- edit [jinn.mcp_call]' }, NOW);
    const names = t.steps.map((s) => s.name);
    expect(names).toEqual(['tool:apply_patch', 'solver:trajectory', 'evaluator:verdict']);
    const traceStep = t.steps.find((s) => s.name === 'solver:trajectory');
    expect(String(traceStep!.attributes.trace)).toContain('plan');
    // enriched evidence is NOT tagged patch-only
    expect(t.task.distributionTags).not.toContain('patch-only');
  });

  it('tags patch-only and inserts no trace step when the trajectory is unavailable (§8, v0.5)', () => {
    const t = toBridgeCapturedTask(ref(), ev, NOW); // ev has no stepTrace
    expect(t.steps.map((s) => s.name)).toEqual(['tool:apply_patch', 'evaluator:verdict']);
    expect(t.task.distributionTags).toContain('patch-only');
  });
});

describe('bridgeAttempts', () => {
  function coreDeps(over: Partial<BridgeDeps> = {}): BridgeDeps & { published: AttemptRef[] } {
    const published: AttemptRef[] = [];
    const deps: BridgeDeps & { published: AttemptRef[] } = {
      published,
      slateInstanceIds: new Set<string>(),
      now: () => NOW,
      fetchEvidence: async (r) => ({ taskSummary: `summary ${r.instanceId}`, patch: `patch ${r.instanceId}`, repo: repoFromInstanceId(r.instanceId) ?? undefined }),
      publishEvidence: async (_task, r) => { published.push(r); return { envelopeRef: `env-${r.instanceId}-${r.polarity}`, anchorTx: null }; },
      ...over,
    };
    return deps;
  }

  it('bridges both a pass and a fail for the same instance (complementary, not deduped)', async () => {
    const deps = coreDeps();
    const res = await bridgeAttempts(
      [ref({ polarity: 'pass' }), ref({ polarity: 'fail' })],
      deps,
    );
    expect(res.bridged.map((b) => b.polarity).sort()).toEqual(['fail', 'pass']);
  });

  it('dedups a repeated (instance_id, polarity)', async () => {
    const deps = coreDeps();
    const res = await bridgeAttempts(
      [ref({ requestId: '0x1'.padEnd(66, '0') }), ref({ requestId: '0x2'.padEnd(66, '0') })],
      deps,
    );
    expect(res.bridged).toHaveLength(1);
    expect(res.deduped).toHaveLength(1);
  });

  it('retains up to groupCap attempts per (instance_id, polarity); overflow → deduped, kept-K stable-ordered (#1478)', async () => {
    const deps = coreDeps({ groupCap: 2 });
    const passRefs = ['0xa', '0xb', '0xc'].map((p) => ref({ requestId: p.padEnd(66, '0') }));
    const res = await bridgeAttempts(passRefs, deps);
    // exactly K kept, the remainder recorded as over-cap.
    expect(res.bridged).toHaveLength(2);
    expect(res.deduped).toHaveLength(1);
    // the kept K are the FIRST K in arrival order (deterministic selection).
    expect(deps.published.map((r) => r.requestId)).toEqual([
      '0xa'.padEnd(66, '0'),
      '0xb'.padEnd(66, '0'),
    ]);
  });

  it('a failed fetch does NOT consume a group slot — a later candidate backfills (#1478)', async () => {
    // groupCap=2, but the FIRST candidate's evidence fetch fails: the cap must
    // count successful bridges only, so the 2nd and 3rd still fill the group.
    let call = 0;
    const deps = coreDeps({
      groupCap: 2,
      fetchEvidence: async (r) => {
        if (++call === 1) throw new Error('3-hop join miss');
        return { taskSummary: `summary ${r.instanceId}`, patch: `patch ${r.instanceId}` };
      },
    });
    const passRefs = ['0xa', '0xb', '0xc'].map((p) => ref({ requestId: p.padEnd(66, '0') }));
    const res = await bridgeAttempts(passRefs, deps);
    expect(res.bridged).toHaveLength(2);       // the group still reached groupCap
    expect(res.errors).toHaveLength(1);        // the miss is recorded, not silent
    expect(res.deduped).toHaveLength(0);       // no valid candidate wrongly dropped as over-cap
  });

  it('caps each polarity independently (a group is per (instance, polarity)) (#1478)', async () => {
    const deps = coreDeps({ groupCap: 2 });
    const refs = [
      ...['0xa', '0xb', '0xc'].map((p) => ref({ requestId: p.padEnd(66, '0'), polarity: 'pass' })),
      ...['0xd', '0xe', '0xf'].map((p) => ref({ requestId: p.padEnd(66, '0'), polarity: 'fail' })),
    ];
    const res = await bridgeAttempts(refs, deps);
    expect(res.bridged.filter((b) => b.polarity === 'pass')).toHaveLength(2);
    expect(res.bridged.filter((b) => b.polarity === 'fail')).toHaveLength(2);
    expect(res.deduped).toHaveLength(2);
  });

  it('excludes held-out by instance_id AND by repo (derived)', async () => {
    const deps = coreDeps({ slateInstanceIds: new Set(['django__django-99999']) });
    const res = await bridgeAttempts(
      [
        ref({ instanceId: 'django__django-99999' }),  // slate instance → excluded (instance_id)
        ref({ instanceId: 'django__django-11333' }),  // same repo as a slate instance → excluded (repo)
        ref({ instanceId: 'flask__flask-4200' }),      // clean → bridged
      ],
      deps,
    );
    expect(res.bridged.map((b) => b.instanceId)).toEqual(['flask__flask-4200']);
    expect(res.excludedHeldOut.map((e) => e.reason).sort()).toEqual(['instance_id', 'repo']);
  });

  it('records an error without sinking the batch', async () => {
    const deps = coreDeps({ fetchEvidence: async (r) => { if (r.instanceId.includes('boom')) throw new Error('ipfs down'); return { taskSummary: 's', patch: 'p' }; } });
    const res = await bridgeAttempts([ref({ instanceId: 'boom__boom-1' }), ref({ instanceId: 'flask__flask-4200' })], deps);
    expect(res.errors).toHaveLength(1);
    expect(res.bridged).toHaveLength(1);
  });

  it('surfaces a slate instance_id whose repo cannot be derived (repo-exclusion incomplete, not silent)', async () => {
    const deps = coreDeps({ slateInstanceIds: new Set(['malformed-slate-id', 'django__django-99999']) });
    const res = await bridgeAttempts([ref({ instanceId: 'flask__flask-4200' })], deps);
    // The unparseable slate id is reported; the well-formed one is not.
    expect(res.unresolvedSlateIds).toEqual(['malformed-slate-id']);
    // Exact-id exclusion is unaffected; a clean instance still bridges.
    expect(res.bridged.map((b) => b.instanceId)).toEqual(['flask__flask-4200']);
  });

  it('reports no unresolved slate ids when every slate id is well-formed', async () => {
    const deps = coreDeps({ slateInstanceIds: new Set(['django__django-99999', 'flask__flask-1']) });
    const res = await bridgeAttempts([ref({ instanceId: 'sympy__sympy-27510' })], deps);
    expect(res.unresolvedSlateIds).toEqual([]);
  });
});

describe('buildBridgeEvidencePublisher (reuses capture→publish at layer-2 altitude)', () => {
  function publishDeps(): { deps: HarnessPublishDeps; artifacts: Array<{ artifactType: string; payload: unknown }> } {
    const artifacts: Array<{ artifactType: string; payload: unknown }> = [];
    const deps: HarnessPublishDeps = {
      participant: { safeAddress: `0x${'1'.repeat(40)}`, agentEoa: `0x${'2'.repeat(40)}` },
      signer: { address: `0x${'2'.repeat(40)}`, privateKey: `0x${'a'.repeat(64)}` },
      clientGitSha: 'sha',
      defaultArtifactEndpoint: 'http://127.0.0.1:7331',
      ledger: createMemoryLedger(),
      publishArtifact: async (i) => { artifacts.push(i); return { cid: 'bafyArt', sha256: 'a'.repeat(64) }; },
      publishEnvelope: async () => ({ cid: 'bafyEnv', sha256: 'b'.repeat(64) }),
      anchorEnvelope: async () => ({ txHash: `0x${'e'.repeat(64)}`, blockNumber: 1 }),
    };
    return { deps, artifacts };
  }

  it('publishes a jinn.trace-envelope.v0 with the patch scrubbed at layer-2 (secret gone, prose kept)', async () => {
    const { deps, artifacts } = publishDeps();
    const publisher = buildBridgeEvidencePublisher(deps);
    const task = toBridgeCapturedTask(
      ref(),
      { taskSummary: 'Fix the bug before you refactor', patch: 'use this token wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY here' },
      NOW,
    );
    const out = await publisher(task, ref());
    expect(out.envelopeRef).toBe('bafyEnv');

    const traceUpload = artifacts.find((a) => a.artifactType === 'jinn.trace-envelope.v0');
    expect(traceUpload).toBeTruthy();
    const env = parseTraceEnvelopeV0(traceUpload!.payload);
    const patchStep = env.steps.find((s) => s.name === 'tool:apply_patch');
    const patchVal = String(patchStep!.attributes.patch);
    expect(patchVal).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'); // secret redacted
    expect(patchVal).toContain('use this token'); // ordinary prose preserved (layer-2 altitude)
  });

  it('scrubs the solver-trajectory step at layer-2 too (a planted secret in the trace is redacted)', async () => {
    const { deps, artifacts } = publishDeps();
    const publisher = buildBridgeEvidencePublisher(deps);
    const task = toBridgeCapturedTask(
      ref(),
      {
        taskSummary: 'Fix the bug',
        patch: 'diff --git a/x b/x',
        stepTrace: '- read config using wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY [jinn.venue_io]\n- edit models.py [jinn.mcp_call]',
      },
      NOW,
    );
    await publisher(task, ref());

    const traceUpload = artifacts.find((a) => a.artifactType === 'jinn.trace-envelope.v0');
    const env = parseTraceEnvelopeV0(traceUpload!.payload);
    const traceStep = env.steps.find((s) => s.name === 'solver:trajectory')!;
    const traceVal = String(traceStep.attributes.trace);
    expect(traceVal).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'); // secret redacted
    expect(traceVal).toContain('edit models.py'); // ordinary prose preserved (layer-2 altitude)
  });

  it('bridges a patch larger than the 16 KiB step-attribute cap with a receipted truncation (not a crash, not silent)', async () => {
    const { deps, artifacts } = publishDeps();
    const publisher = buildBridgeEvidencePublisher(deps);
    const bigPatch = 'diff --git a/x b/x\n' + 'x'.repeat(20 * 1024); // exceeds MAX_STEP_ATTRIBUTES_BYTES (16 KiB)
    const task = toBridgeCapturedTask(ref(), { taskSummary: 'a very large patch', patch: bigPatch }, NOW);
    const out = await publisher(task, ref());
    expect(out.envelopeRef).toBe('bafyEnv');

    const traceUpload = artifacts.find((a) => a.artifactType === 'jinn.trace-envelope.v0');
    const env = parseTraceEnvelopeV0(traceUpload!.payload);
    const patchStep = env.steps.find((s) => s.name === 'tool:apply_patch')!;
    const stored = String(patchStep.attributes.patch);
    expect(stored.length).toBeLessThan(bigPatch.length); // truncated to fit the cap
    expect(patchStep.truncatedKeys ?? []).toContain('patch'); // receipted, never silent
  });
});
