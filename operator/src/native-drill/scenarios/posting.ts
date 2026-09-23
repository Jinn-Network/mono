// operator/src/native-drill/scenarios/posting.ts
/**
 * Checkpoint `posting` (#2434).
 *
 * Boundary: the wallet invocation has returned a real transaction hash and the process is killed
 * before that hash is persisted — the runbook's "inject before broadcast and after wallet
 * invocation before hash persistence".
 *
 * Proof: the restarted requester reconciles canonical history from the node (by the transaction's
 * calldata and the sender's nonce history), posts nothing a second time, and signs its association
 * over the original Submission and the original posting terms.
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import {
  createNativeRequester,
  type NativeRequesterDeps,
  type NativeRequesterRoles,
} from '../../native-requester/requester.js';
import type { RunObservation } from '../observation.js';
import {
  DRILL_CLOCK,
  broadcastOnce,
  digestOf,
  observedMode,
  type ScenarioContext,
} from './support.js';

const CREATOR_SAFE = '0x1111111111111111111111111111111111111111' as const;
const REQUESTER_TERMS: NativeRequesterDeps['posting']['terms'] = {
  solutionMaxDeliveryRateWei: 2n,
  verdictMaxDeliveryRateWei: 3n,
  responseTimeoutSeconds: 60n,
  allowSolverSelfEvaluation: false,
};
/** Anvil's deterministic accounts make the posted task id a constant of the drill, not of a run. */
const POSTED_TASK_ID = 17n;

/**
 * Role keys are derived from the drill seed, not generated.
 *
 * The oracle lane and the recovery lane run in separate state directories, so a generated key pair
 * would differ between them — and because the requester's association digests are signed, that
 * difference alone would make the two runs diverge for a reason having nothing to do with recovery.
 * Ed25519 signing is deterministic (RFC 8032), so seed-derived keys make the whole association
 * byte-stable across both lanes and across re-runs.
 */
function drillRoles(seed: string): NativeRequesterRoles {
  /** The fixed PKCS#8 prefix for a raw 32-byte Ed25519 private key. */
  const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
  return {
    get(role) {
      const material = createHash('sha256').update(`jinn-restart-drill:${seed}:${role}`).digest();
      const privateKey = createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, material]),
        format: 'der',
        type: 'pkcs8',
      });
      return {
        keyId: `did:key:drill-${role}`,
        publicKey: createPublicKey(privateKey),
        sign: (payload: Uint8Array) => new Uint8Array(cryptoSign(null, payload, privateKey)),
      };
    },
  };
}

export async function runPostingScenario(context: ScenarioContext): Promise<RunObservation | undefined> {
  const roles = drillRoles(context.seed);
  const stateDir = join(context.stateDir, 'requester');
  mkdirSync(stateDir, { recursive: true });

  let broadcasts = 0;
  let recoveries = 0;

  /** The exact calldata identity of this posting, and the key its recovery reconciles on. */
  const postingKey = `${context.runId}:posting`;

  const deps: NativeRequesterDeps = {
    stateDir,
    requesterAgent: `urn:jinn:requester:${context.seed}`,
    admissionAgent: `urn:jinn:admission:${context.seed}`,
    publicBaseUrl: 'https://requester.example',
    readChain: async () => BASE_SEPOLIA_TODAY,
    authorityTime: async () => ({
      chainId: 84532 as const,
      blockNumber: '100',
      blockHash: `0x${'cd'.repeat(32)}` as const,
      timestamp: '2026-08-02T11:59:00.000Z',
      finalized: true as const,
    }),
    loadRoles: async () => roles,
    creatorSafe: CREATOR_SAFE,
    posting: {
      terms: REQUESTER_TERMS,
      recoverPosting: async () => ({
        resolvedScopes: [], uncertainScopes: [], retryableScopes: [], conflicts: [],
      }),
      post: async () => {
        // The wallet has returned by the time the boundary fires. Everything after it is hash
        // persistence, which is exactly what the injected boundary must interrupt.
        const posted = await broadcastOnce(context, postingKey, () => context.boundary());
        if (posted.broadcast) broadcasts += 1;
        return { taskId: POSTED_TASK_ID, txHash: posted.txHash };
      },
      recover: async () => {
        recoveries += 1;
        const history = await context.chain.findByDigest(postingKey);
        const first = history[0];
        return first === undefined ? null : { taskId: POSTED_TASK_ID, txHash: first.hash };
      },
      canonicalTaskCreated: async (expected) => ({ canonical: true as const, ...expected }),
    },
    now: () => DRILL_CLOCK,
  };

  const nonceBefore = await context.chain.senderNonce();
  const requester = createNativeRequester(deps);
  const outcome = await requester.request({
    network: 'base-sepolia',
    fixture: 'prediction-forecast-golden.json',
    runId: context.seed,
  });
  const association = outcome.association;

  const history = await context.chain.findByDigest(postingKey);
  const nonceAfter = await context.chain.senderNonce();

  return {
    checkpoint: 'posting',
    seed: context.seed,
    mode: observedMode(context.mode),
    finalState: 'published',
    graphDigest: digestOf({
      task: association.taskDigest,
      submission: association.submissionDigest,
      envelope: association.requesterEnvelopeDigest,
      receipt: association.admissionReceiptDigest,
      taskId: association.taskId.toString(10),
      submissionUri: association.submissionUri,
      nonce: association.nonce,
      postingTerms: association.postingTerms,
      intendedSpendWei: association.intendedSpendWei,
      source: {
        sequence: association.publication.sequence,
        entry: association.publication.entryDigest,
      },
    }),
    operationIds: [`post:${association.taskDigest}:${association.submissionDigest}`],
    transactionHashes: history.map(({ hash }) => hash),
    sourceHeads: [association.publication.entryDigest],
    effects: {
      posting: history.length === 0 ? 0 : 1,
      signedSourceEntries: 1,
      // Canonical history, not a local counter: two posts on chain would show up here.
      duplicatePosts: Math.max(history.length - 1, 0),
    },
    invocations: { broadcast: broadcasts, recover: recoveries },
    stateBefore: `sender nonce ${nonceBefore}; posting draft not yet broadcast`,
    stateAfter: `sender nonce ${nonceAfter}; ${history.length} canonical posting transaction(s) for one draft`,
  };
}
