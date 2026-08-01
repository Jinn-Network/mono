import { createHash } from 'node:crypto';
import type { ExecutionWiringEntry } from '@jinn-network/marketplace-pipeline';
import type {
  PostingIntent,
  PostingIntentStore,
  PostingOwnerToken,
} from '@jinn-network/marketplace-binding';
import type { EngagementLedger } from '../daemon/engagement-ledger.js';

export interface VerdictIntent {
  readonly idempotencyKey: string;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly evaluationTaskDigest: `sha256:${string}`;
  readonly wiringEntryId: string;
}

/** Thin ledger port the evaluator loop satisfies from {@link EngagementLedger}. */
export interface VerdictIntentLedger {
  admitIntent(idempotencyKey: string): void | Promise<void>;
}

export interface AdmitVerdictIntentDeps {
  readonly ledger: VerdictIntentLedger;
  readonly intents: PostingIntentStore;
  readonly postingIntent: PostingIntent;
}

export function verdictIdempotencyKey(input: {
  readonly chainId: number;
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly evaluationTaskDigest: string;
}): string {
  const logical =
    `verdict:${input.chainId}:${input.taskId.toString()}:${input.attemptIndex}:${input.evaluationTaskDigest}`;
  return createHash('sha256').update(logical).digest('hex');
}

export function wrapEngagementLedgerForVerdictIntent(
  ledger: EngagementLedger,
  context: {
    readonly chainId: number;
    readonly taskCoordinator: string;
    readonly taskId: bigint;
    readonly workKind: string;
    readonly wiring: ExecutionWiringEntry;
  },
): VerdictIntentLedger {
  return {
    admitIntent(idempotencyKey: string) {
      ledger.admitClaimIntent({
        idempotencyKey,
        chainId: context.chainId,
        taskCoordinator: context.taskCoordinator,
        taskId: context.taskId,
        workKind: context.workKind,
        wiring: context.wiring,
      });
    },
  };
}

export async function admitVerdictIntent(
  deps: AdmitVerdictIntentDeps,
  intent: VerdictIntent,
): Promise<{ readonly admitted: boolean; readonly ownerToken?: PostingOwnerToken }> {
  // Program §6.2: ledger row strictly before the durable intent row. The engagement ledger
  // (client Store) and venue posting_intents (VenueStateDatabase) are separate databases —
  // no shared SQLite transaction is exposed by the as-built APIs; call order preserves
  // ledger-before-intent until a shared transaction port exists.
  await deps.ledger.admitIntent(intent.idempotencyKey);

  const claim = await deps.intents.claim(deps.postingIntent);
  if (claim.kind === 'owner') {
    return { admitted: true, ownerToken: claim.ownerToken };
  }
  return { admitted: false };
}
