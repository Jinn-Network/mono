import { describe, expect, it, vi } from 'vitest';
import { assembleTaskLifecycleEvidence } from '../../src/discovery/task-lifecycle-evidence.js';
import { cidToDigestHex } from '../../src/adapters/mech/ipfs.js';
import type { SignedEnvelope } from '../../src/types/envelope.js';
import { authenticatePostedTaskEvidence } from '../../src/discovery/posted-task-evidence.js';

const CHAIN = 84532;
const OPERATOR = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`;
const EVALUATOR = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`;
const SOLVE_REQ = (`0x${'b0'.repeat(32)}`) as `0x${string}`;
const EVAL_REQ = (`0x${'d0'.repeat(32)}`) as `0x${string}`;
/** Raw sha2-256 CIDv1 hex form — digests cleanly via cidToDigestHex. */
const TASK_CID = `f01551220${'aa'.repeat(32)}`;
const TASK_CID_DIGEST = cidToDigestHex(TASK_CID);
const SOLUTION_HASH = (`0x${'71'.repeat(32)}`) as `0x${string}`;
const VERDICT_HASH = (`0x${'72'.repeat(32)}`) as `0x${string}`;

function baseSpine(over?: {
  attemptCandidates?: Parameters<typeof assembleTaskLifecycleEvidence>[0]['attemptCandidates'];
  verdictCandidates?: Parameters<typeof assembleTaskLifecycleEvidence>[0]['verdictCandidates'];
}) {
  const map = assembleTaskLifecycleEvidence({
    tasks: [{
      taskId: '7', chainId: CHAIN, manifestDigest: (`0x${'11'.repeat(32)}`) as `0x${string}`,
      taskCidDigest: TASK_CID_DIGEST, creator: (`0x${'aa'.repeat(20)}`) as `0x${string}`,
      maxClaims: 1, requiredVerdicts: 1, createdAtBlock: 10, finalized: false, refunded: false,
    }],
    attempts: [{
      taskId: '7', chainId: CHAIN, attemptIndex: 0, requestId: SOLVE_REQ,
      operator: OPERATOR, priorityMech: (`0x${'c0'.repeat(20)}`) as `0x${string}`,
      deliveryRate: '1', createdAtBlock: 20,
    }],
    verdicts: [{
      taskId: '7', chainId: CHAIN, attemptIndex: 0, verdictIndex: 0,
      requestId: EVAL_REQ, evaluator: EVALUATOR, verdictCode: 1, createdAtBlock: 30,
    }],
    attemptCandidates: over?.attemptCandidates,
    verdictCandidates: over?.verdictCandidates,
  });
  return map.get('7')!;
}

/** Minimal SignedEnvelope-shaped object returned by injected authenticateEnvelope. */
function opaqueEnvelope(args: {
  role: 'solution' | 'verdict' | 'restoration';
  requestId: `0x${string}`;
  safe: `0x${string}`;
  hash: `0x${string}`;
  generatedAt?: number;
  taskCid?: string;
  payload?: Record<string, unknown>;
}): SignedEnvelope {
  return {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'prediction.v0',
    role: args.role,
    generatedAt: args.generatedAt ?? 1_750_000_000,
    task: {
      cid: args.taskCid ?? TASK_CID,
      onchainCreationTx: (`0x${'11'.repeat(32)}`) as `0x${string}`,
      onchainCreationBlock: 1,
      requestId: args.requestId,
    },
    participant: {
      safeAddress: args.safe,
      agentEoa: (`0x${'f1'.repeat(20)}`) as `0x${string}`,
    },
    window: { startTs: 1_749_999_000, endTs: 1_750_000_000 },
    executor: {
      implName: 'fixture', implVersion: '0.0.1',
      clientGitSha: '0'.repeat(40),
      codeDigest: `sha256:${'a'.repeat(64)}`,
      runtimeBundleDigest: `sha256:${'b'.repeat(64)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: (`0x${'f1'.repeat(20)}`) as `0x${string}` },
      mode: 'frozen',
    },
    evidenceTier: 'self-signed',
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: args.payload ?? { opaque: true, unusedDomainKey: 1 },
    signature: {
      algo: 'secp256k1',
      signer: (`0x${'f1'.repeat(20)}`) as `0x${string}`,
      hash: args.hash,
      sig: (`0x${'99'.repeat(65)}`) as `0x${string}`,
    },
  } as SignedEnvelope;
}

describe('authenticatePostedTaskEvidence', () => {
  it('returns valid opaque carriers when one attempt + one verdict candidate bind', async () => {
    const evidence = baseSpine({
      attemptCandidates: [{
        requestId: SOLVE_REQ, chainId: CHAIN, manifestCid: 'bafySol',
        publisherAgentId: '1', manifestHash: SOLUTION_HASH, enrichedAtBlock: 25,
      }],
      verdictCandidates: [{
        requestId: EVAL_REQ, chainId: CHAIN, manifestCid: 'bafyVerd',
        publisherAgentId: '2', manifestHash: VERDICT_HASH, enrichedAtBlock: 35,
      }],
    });

    const ipfs = vi.fn(async (cid: string) => ({ cid }));
    const resolvePublisherSafe = vi.fn(async (_c: number, agentId: string) =>
      agentId === '1' ? OPERATOR : EVALUATOR,
    );
    const authenticateEnvelope = vi.fn(async (value: unknown) => {
      const cid = (value as { cid: string }).cid;
      if (cid === 'bafySol') {
        return opaqueEnvelope({
          role: 'solution', requestId: SOLVE_REQ, safe: OPERATOR, hash: SOLUTION_HASH,
          payload: { mustRemainOpaque: { nested: true } },
        });
      }
      return opaqueEnvelope({
        role: 'verdict', requestId: EVAL_REQ, safe: EVALUATOR, hash: VERDICT_HASH,
      });
    });

    const report = await authenticatePostedTaskEvidence({
      evidence,
      ports: { ipfs, resolvePublisherSafe, authenticateEnvelope },
    });

    expect(report.taskId).toBe('7');
    expect(report.authoritativeTask.taskCidDigest).toBe(TASK_CID_DIGEST);
    const attempt = report.attempts[0]!;
    expect(attempt.execution.status).toBe('valid');
    if (attempt.execution.status !== 'valid') throw new Error('unreachable');
    expect(attempt.execution.selected.binding.role).toBe('solution');
    expect(attempt.execution.selected.binding.requestId).toBe(SOLVE_REQ.toLowerCase());
    expect(attempt.execution.selected.binding.onchainRoleAddress).toBe(OPERATOR);
    expect(attempt.execution.selected.envelope.payload).toEqual({
      mustRemainOpaque: { nested: true },
    });
    // AC4: reader must not interpret payload — assert presence only, never domain keys.
    expect('mustRemainOpaque' in attempt.execution.selected.envelope.payload).toBe(true);

    const verdict = attempt.verdicts[0]!;
    expect(verdict.verdictCode).toBe(1); // on-chain code untouched
    expect(verdict.verdict.status).toBe('valid');
    if (verdict.verdict.status !== 'valid') throw new Error('unreachable');
    expect(verdict.verdict.selected.binding.role).toBe('verdict');
    expect(verdict.verdict.selected.binding.onchainRole).toBe('evaluator');

    expect(resolvePublisherSafe).toHaveBeenCalledWith(CHAIN, '1', 25n);
    expect(resolvePublisherSafe).toHaveBeenCalledWith(CHAIN, '2', 35n);
    expect(ipfs).toHaveBeenCalledWith('bafySol', 2_000_000);
  });
});
