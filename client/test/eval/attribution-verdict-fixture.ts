import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

import { VerdictCode } from '../../src/adapters/mech/verdict-code.js';
import type { AttributionVerdictProof } from '../../src/eval/attribution-verdict-evidence.js';
import { signCanonical } from '../../src/harnesses/engine/signing.js';

const SOLUTION_KEY =
  '0xac0974bec39a6ba6ba2366ba6ba2366ba6ba2366ba6ba2366ba6ba2366ba6ba6' as const;
const VERDICT_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
export const ATTRIBUTION_OPERATOR_SAFE = `0x${'aa'.repeat(20)}`;
export const ATTRIBUTION_EVALUATOR_SAFE = `0x${'bb'.repeat(20)}`;

function requestId(label: string): `0x${string}` {
  return `0x${createHash('sha256').update(label).digest('hex')}`;
}

async function signedEnvelope(args: {
  role: 'solution' | 'verdict';
  requestId: string;
  instanceId: string;
  safeAddress: string;
  privateKey: `0x${string}`;
  payload: Record<string, unknown>;
}) {
  const account = privateKeyToAccount(args.privateKey);
  const unsigned = {
    schemaVersion: 'jinn.execution.v1',
    solverType: 'swe-rebench-v2.v1',
    role: args.role,
    generatedAt: 1_753_088_400_000,
    task: {
      cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3pt5gnxjywjd5dpgzud42n5by',
      onchainCreationTx: `0x${'33'.repeat(32)}`,
      onchainCreationBlock: 123,
      requestId: args.requestId,
      instanceId: args.instanceId,
      repo: 'django/django',
      baseCommit: '4bb1c1a21b9cc8966fa29ba67b3211eca3a676fa',
    },
    participant: {
      safeAddress: args.safeAddress,
      agentEoa: account.address,
    },
    window: { startTs: 1_753_088_000_000, endTs: 1_753_095_200_000 },
    executor: {
      implName: args.role === 'solution' ? 'codex' : 'swe-rebench-v2-evaluator',
      implVersion: '1.0.0',
      clientGitSha: '4bb1c1a21b9cc8966fa29ba67b3211eca3a676fa',
      codeDigest: `sha256:${'44'.repeat(32)}`,
      runtimeBundleDigest: `sha256:${'55'.repeat(32)}`,
      plugins: [],
      signingKey: { kind: 'agent-eoa', pubkey: account.address },
      mode: 'frozen',
    },
    evidenceTier: 'committed',
    attestation: null,
    trajectory: null,
    artifacts: [],
    payload: args.payload,
    distributionClass: 'restricted-tos',
  };
  const signed = await signCanonical(unsigned, args.privateKey, account.address);
  return {
    ...unsigned,
    signature: {
      algo: 'secp256k1',
      signer: account.address,
      hash: signed.hash,
      sig: signed.sig,
    },
  };
}

export async function createAttributionVerdictProof(args: {
  instanceId: string;
  acceptedDiff: boolean;
  nonce: number;
}): Promise<AttributionVerdictProof> {
  const solutionRequest = requestId(`solution:${args.nonce}`);
  const verdictRequest = requestId(`verdict:${args.nonce}`);
  const solutionEnvelope = await signedEnvelope({
    role: 'solution',
    requestId: solutionRequest,
    instanceId: args.instanceId,
    safeAddress: ATTRIBUTION_OPERATOR_SAFE,
    privateKey: SOLUTION_KEY,
    payload: {
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    },
  });
  const verdictEnvelope = await signedEnvelope({
    role: 'verdict',
    requestId: verdictRequest,
    instanceId: args.instanceId,
    safeAddress: ATTRIBUTION_EVALUATOR_SAFE,
    privateKey: VERDICT_KEY,
    payload: {
      schemaVersion: 'swe-rebench-v2-verdict.v1',
      score: args.acceptedDiff ? 1 : 0,
      passed_match: args.acceptedDiff,
      evaluator_cost_usd: 0.01,
    },
  });
  return {
    schema: 'jinn.attribution-marketplace-verdict-proof.v1',
    marketplace: {
      attempt: {
        chainId: 84532,
        taskId: String(args.nonce + 1),
        attemptIndex: 0,
        requestId: solutionRequest,
        operator: ATTRIBUTION_OPERATOR_SAFE,
        evidenceHash: solutionEnvelope.signature.hash,
      },
      verdict: {
        chainId: 84532,
        taskId: String(args.nonce + 1),
        attemptIndex: 0,
        verdictIndex: 0,
        requestId: verdictRequest,
        evaluator: ATTRIBUTION_EVALUATOR_SAFE,
        verdictCode: args.acceptedDiff ? VerdictCode.Pass : VerdictCode.Fail,
        evidenceHash: verdictEnvelope.signature.hash,
      },
    },
    solutionEnvelope,
    verdictEnvelope,
  };
}
