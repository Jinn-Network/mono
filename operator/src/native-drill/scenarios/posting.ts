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
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import {
  createNativeRequester,
  type NativeRequesterRoles,
} from '../../native-requester/requester.js';
import type { RunObservation } from '../observation.js';
import { DRILL_CLOCK, digestOf, observedMode, type ScenarioContext } from './support.js';

const CREATOR_SAFE = '0x1111111111111111111111111111111111111111' as const;
const REQUESTER_TERMS = {
  solutionMaxDeliveryRateWei: 2n,
  verdictMaxDeliveryRateWei: 3n,
  responseTimeoutSeconds: 60n,
  allowSolverSelfEvaluation: false,
} as const;
/** Anvil's deterministic accounts make the posted task id a constant of the drill, not of a run. */
const POSTED_TASK_ID = 17n;

/**
 * Role keys must be byte-identical across the crash and resume processes, or the association the
 * restarted requester signs would differ for a reason that has nothing to do with recovery. They
 * are generated once per pair and persisted inside the pair's own state directory.
 */
function durableRoles(stateDir: string): NativeRequesterRoles {
  const path = join(stateDir, 'roles', 'requester-roles.json');
  mkdirSync(join(stateDir, 'roles'), { recursive: true });
  let stored: Record<string, string>;
  try {
    stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch {
    stored = {};
    for (const role of ['requester-submission', 'admission', 'requester-discovery']) {
      stored[role] = generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey;
    }
    writeFileSync(path, JSON.stringify(stored), 'utf8');
  }
  return {
    get(role) {
      const pem = stored[role];
      if (pem === undefined) throw new Error(`restart drill has no requester role key for ${role}`);
      const privateKey = createPrivateKey(pem);
      return {
        keyId: `did:key:drill-${role}`,
        publicKey: createPublicKey(privateKey),
        sign: (payload: Uint8Array) => new Uint8Array(cryptoSign(null, payload, privateKey)),
      };
    },
  };
}

export async function runPostingScenario(context: ScenarioContext): Promise<RunObservation | undefined> {
  const roles = durableRoles(context.stateDir);
  const stateDir = join(context.stateDir, 'requester');
  mkdirSync(stateDir, { recursive: true });

  let broadcasts = 0;
  let recoveries = 0;

  /** The exact calldata identity of this posting, and the key its recovery reconciles on. */
  const postingKey = `${context.runId}:posting`;

  const deps = {
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
        broadcasts += 1;
        const txHash = await context.chain.broadcast(postingKey);
        // The wallet has returned. Everything after this line is hash persistence, which is
        // exactly what the injected boundary must interrupt.
        await context.boundary();
        return { taskId: POSTED_TASK_ID, txHash };
      },
      recover: async () => {
        recoveries += 1;
        const history = await context.chain.findByDigest(postingKey);
        const first = history[0];
        return first === undefined ? null : { taskId: POSTED_TASK_ID, txHash: first.hash };
      },
      canonicalTaskCreated: async (expected: {
        chainId: number; coordinator: string; creator: string; taskId: bigint;
        taskDigest: `sha256:${string}`; txHash: `0x${string}`;
        terms: typeof REQUESTER_TERMS; maxClaims: 1;
      }) => ({ canonical: true as const, ...expected }),
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
