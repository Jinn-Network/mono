// operator/src/native-drill/checkpoints.ts
/**
 * The six restart-drill checkpoints named by the Phase B closure manifest (#2434, umbrella #2429).
 *
 * The names are not re-declared here: they are bound to `PHASE_B_RESTART_CHECKPOINT_SET`, so a
 * change to the manifest's required set is a compile-time and test-time break rather than a silent
 * drift between the drill's output and the field it is produced for.
 */
import { PHASE_B_RESTART_CHECKPOINT_SET } from '../daemon/phase-b-closure-manifest.js';

export type DrillCheckpoint = (typeof PHASE_B_RESTART_CHECKPOINT_SET)[number];

export const DRILL_CHECKPOINTS: readonly DrillCheckpoint[] = PHASE_B_RESTART_CHECKPOINT_SET;

export interface DrillCheckpointSpec {
  readonly checkpoint: DrillCheckpoint;
  /** Deterministic seed reused as the run id, so a re-run reproduces the same operation ids. */
  readonly seed: string;
  /** Which role host is killed and restarted. */
  readonly role: 'requester' | 'solver' | 'evaluator';
  /** The exact point at which the parent SIGKILLs the child. */
  readonly boundary: string;
  /** The runbook's required recovery proof for this checkpoint. */
  readonly proof: string;
  /**
   * Effect counters whose recovered value must be exactly this. These are the runbook's
   * "zero duplicate posts/claims/deliveries/settlements" assertions made machine-checkable.
   */
  readonly requiredEffects: Readonly<Record<string, number>>;
  /**
   * The terminal lifecycle state a completed run must report. A matching pair of failures
   * (`compareRuns` equal, `requiredEffects` satisfied) must not seal: both lanes agreeing on
   * `failed` or on a non-terminal hang is a red drill, not a green report (#4196).
   */
  readonly expectedFinalState: string;
}

/**
 * Seeds continue the B8xx series the in-process matrix uses (`test/fixtures/native-recovery-matrix.v1.json`
 * runs B800-B807) so the two coverages never collide on a run id.
 */
export const DRILL_SPECS: readonly DrillCheckpointSpec[] = [
  {
    checkpoint: 'posting',
    seed: 'B810',
    role: 'requester',
    boundary: 'after the posting wallet invocation returns, before the transaction hash is persisted',
    proof: 'Reconcile canonical TaskCreated/nonce history; zero duplicate posts; the signed '
      + 'association uses the original Submission and posting terms. Duplicate-freedom is '
      + 'canonical history; broadcastOnce is the harness fence that absorbs a re-drive, and '
      + 'invocations.broadcast vs invocations.broadcastSent distinguish the two',
    requiredEffects: { posting: 1, signedSourceEntries: 1, duplicatePosts: 0 },
    expectedFinalState: 'published',
  },
  {
    checkpoint: 'claim',
    seed: 'B811',
    role: 'solver',
    boundary: 'after the claim transaction is broadcast, before the hash is attached to the claim operation',
    proof: 'One logical claimOperationId; replacement hashes remain attached to it; execution '
      + 'starts only after canonical finality. Duplicate-freedom is canonical history; '
      + 'broadcastOnce is the harness fence that absorbs a re-drive, and invocations.broadcast '
      + 'vs invocations.broadcastSent distinguish the two',
    requiredEffects: { claims: 1, claimOperations: 1, duplicateClaims: 0 },
    expectedFinalState: 'claim-finalized',
  },
  {
    checkpoint: 'backend-submit',
    seed: 'B812',
    role: 'solver',
    boundary: 'after the dispatch context is durable, before the backend submit is recorded',
    proof: 'backend.recover reports matching; no second Attempt or divergent submit',
    requiredEffects: { backendSubmissions: 1, duplicateSubmits: 0 },
    expectedFinalState: 'solution-settled',
  },
  {
    checkpoint: 'evidence',
    seed: 'B813',
    role: 'solver',
    boundary: 'after the execution evidence and Delivery are sealed, before publication completes',
    proof: 'Every Delivery.evidenceRecords digest resolves; publication resumes once; Delivery '
      + 'bytes do not change',
    // Four records: the solution output, its execution evidence, the Delivery, and the Delivery
    // envelope. Pinned, so a change in what the solution path publishes fails this drill rather
    // than quietly redefining what "publication resumes once" was measured against.
    requiredEffects: { publishedRecords: 4 },
    expectedFinalState: 'solution-settled',
  },
  {
    checkpoint: 'solution-settlement',
    seed: 'B814',
    role: 'solver',
    boundary: 'after the solution settlement transaction is broadcast, before it is reconciled',
    proof: 'Receipt/replacement/canonical logs reconcile to one finalized solution operation. '
      + 'Duplicate-freedom is canonical history; broadcastOnce is the harness fence that '
      + 'absorbs a re-drive, and invocations.settlementBroadcast vs '
      + 'invocations.settlementBroadcastSent distinguish the two',
    requiredEffects: { settlements: 1, duplicateSettlements: 0 },
    expectedFinalState: 'solution-settled',
  },
  {
    checkpoint: 'verdict-settlement',
    seed: 'B815',
    role: 'evaluator',
    boundary: 'after the verdict settlement transaction is broadcast, before it is reconciled',
    proof: 'Decision-grade gate reruns over public bytes; one finalized verdict operation; '
      + 'consumer graph equals uninterrupted run. Duplicate-freedom is canonical history; '
      + 'broadcastOnce is the harness fence that absorbs a re-drive, and '
      + 'invocations.verdictClaim vs invocations.verdictClaimSent distinguish the two',
    requiredEffects: { canonicalVerdictSettlements: 1, duplicateVerdictSettlements: 0 },
    expectedFinalState: 'complete',
  },
];

export function drillSpec(checkpoint: DrillCheckpoint): DrillCheckpointSpec {
  const spec = DRILL_SPECS.find((candidate) => candidate.checkpoint === checkpoint);
  if (spec === undefined) throw new Error(`no drill specification for checkpoint ${checkpoint}`);
  return spec;
}
