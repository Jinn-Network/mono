/**
 * The work loop's `ArchiveSubscription` (finding E36, ruled "build it" — see
 * `docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md` appendix): turns the
 * projector's durable observation stream (`ProjectorCursorStore.readObservations()`) into
 * `AnnouncedSubmissionCard`s `work-loop.ts` can claim against. Task 13 built the
 * `ArchiveSubscription` interface and `main.ts` never fed it (`archive: { since: async () => [] }`)
 * — this module is that feed.
 *
 * `BASE_SEPOLIA_TODAY` (composition-root.ts's only real `MarketplaceChainConfig` today) is
 * today-generation only, and composition-root.ts's own file header (gap a) documents that every
 * `TaskCreated` on it resolves through the legacy-bridge synthesis path
 * (`bridge-legacy-delivery.ts`'s `synthesizeLegacyTaskProjection`) — there is no other production
 * Submission format yet. So every `network.jinn.task-execution.submission-accepted.v1` observation
 * this daemon durably projects is, today, a legacy-derived card; this module reuses
 * `synthesizeLegacyFactsCard` for the card shape rather than re-deriving it (per the E36 ruling),
 * which is also why it always carries `derivationKind: 'legacy'` plus `legacyManifestDigest`.
 *
 * The persisted observation (`observe.ts`'s `emit()`) carries only `{submission, task: taskDigest}`
 * in `data` (plus the CloudEvents `taskdigest` extension, the same value) and the EVM `derivation`
 * pointer (chainId/contract/blockHash/txHash/logIndex) — no `taskId`, `manifestDigest`, or budget,
 * all of which `synthesizeLegacyFactsCard` needs. Those are recovered by re-reading the EXACT log
 * the observation's own `derivation` names: one `getTransactionReceipt` + one `decodeEventLog`
 * against the router's `TaskCreated` ABI (the same ABI `adapters/mech/contracts.ts`'s
 * `decodeTaskCreatedLogs` already trusts for this router) — a single named log, not a range scan.
 * The decoded `taskCidDigest` is cross-checked against the observation's own `taskdigest` (inverse
 * of `observe.ts`'s own `digestFromBytes32` check) before trusting the decoded event at all, and
 * the fetched task bytes are cross-checked the same way (`documentDigest(taskBytes) === taskDigest`)
 * before being handed to `synthesizeLegacyFactsCard` — fails closed (skips the card, logs a
 * warning) on any mismatch or resolution failure rather than fabricating one.
 */
import { decodeEventLog, type Address, type Hex, type PublicClient } from 'viem';
import { documentDigest } from '@jinn-network/task-execution-protocol';
import { SUBMISSION_OBSERVATION_TYPES } from '@jinn-network/task-execution-protocol';
import type { MarketplaceProtocolObservation } from '@jinn-network/marketplace-projector';
import { JINN_ROUTER_ABI } from '../adapters/mech/types.js';
import { synthesizeLegacyFactsCard } from './bridge-legacy-delivery.js';
import type { AnnouncedSubmissionCard, ArchiveSubscription } from './work-loop.js';

const SUBMISSION_ACCEPTED_TYPE = SUBMISSION_OBSERVATION_TYPES[0];

type Logger = { info(m: string): void; warn(m: string): void };

const noopLogger: Logger = { info: (): void => undefined, warn: (): void => undefined };

export interface ArchiveSubscriptionDeps {
  /** The same accessor `composition-root.ts`'s `buildProjector` already exposes over its own
   *  `ProjectorCursorStore` — kept as a plain sync accessor here (not the async venue-typed
   *  `observations` port) so this module can filter/iterate without an extra await per card. */
  readonly readObservations: () => readonly MarketplaceProtocolObservation[];
  readonly publicClient: PublicClient;
  readonly fetchIpfsBytes: (digest: `sha256:${string}`) => Promise<Uint8Array | undefined>;
  readonly logger?: Logger;
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

/** Inverse of `observe.ts`'s own `digestFromBytes32` — the two representations of one digest. */
function taskCidDigestFromTaskDigest(taskDigest: `sha256:${string}`): Hex {
  return `0x${taskDigest.slice('sha256:'.length)}` as Hex;
}

function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

interface DecodedTaskCreatedArgs {
  readonly creator: Address;
  readonly taskId: bigint;
  readonly manifestDigest: Hex;
  readonly taskCidDigest: Hex;
  readonly maxClaims: number;
  readonly solutionBudget: bigint;
  readonly verdictBudget: bigint;
}

async function cardFromObservation(
  observation: MarketplaceProtocolObservation,
  publicClient: PublicClient,
  fetchIpfsBytes: ArchiveSubscriptionDeps['fetchIpfsBytes'],
  logger: Logger,
): Promise<AnnouncedSubmissionCard | undefined> {
  const taskDigest = observation.taskdigest;
  if (!isSha256(taskDigest)) {
    logger.warn(`[archive] observation ${observation.id} carries no valid taskdigest — skipping`);
    return undefined;
  }
  const derivation = observation.derivation;

  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: derivation.txHash });
  } catch (err) {
    logger.warn(
      `[archive] could not fetch receipt for ${derivation.txHash}: ` +
        `${err instanceof Error ? err.message : String(err)} — skipping`,
    );
    return undefined;
  }
  const log = receipt.logs.find((entry) => entry.logIndex === derivation.logIndex);
  if (log === undefined) {
    logger.warn(
      `[archive] no log at index ${derivation.logIndex} in receipt ${derivation.txHash} — skipping`,
    );
    return undefined;
  }

  let decoded;
  try {
    decoded = decodeEventLog({ abi: JINN_ROUTER_ABI, data: log.data, topics: log.topics });
  } catch (err) {
    logger.warn(
      `[archive] could not decode log at ${derivation.txHash}:${derivation.logIndex}: ` +
        `${err instanceof Error ? err.message : String(err)} — skipping`,
    );
    return undefined;
  }
  if (decoded.eventName !== 'TaskCreated') {
    logger.warn(
      `[archive] log at ${derivation.txHash}:${derivation.logIndex} decoded as ` +
        `"${decoded.eventName}", expected "TaskCreated" — skipping`,
    );
    return undefined;
  }
  const args = decoded.args as unknown as DecodedTaskCreatedArgs;

  const expectedTaskCidDigest = taskCidDigestFromTaskDigest(taskDigest);
  if (!sameHex(args.taskCidDigest, expectedTaskCidDigest)) {
    logger.warn(
      `[archive] decoded taskCidDigest for task ${args.taskId} does not match the observation's ` +
        'own taskdigest — refusing',
    );
    return undefined;
  }

  let taskBytes: Uint8Array | undefined;
  try {
    taskBytes = await fetchIpfsBytes(taskDigest);
  } catch {
    taskBytes = undefined;
  }
  if (taskBytes === undefined) {
    logger.warn(`[archive] could not resolve task bytes for ${taskDigest} (task ${args.taskId}) — skipping`);
    return undefined;
  }
  if (documentDigest(taskBytes) !== taskDigest) {
    logger.warn(
      `[archive] fetched task bytes for task ${args.taskId} do not hash to the observation's own ` +
        'taskdigest — refusing',
    );
    return undefined;
  }

  return synthesizeLegacyFactsCard({
    taskId: args.taskId,
    manifestDigest: args.manifestDigest,
    taskCidDigest: args.taskCidDigest,
    taskBytes,
    solutionBudgetWei: args.solutionBudget,
  });
}

/** Builds the `ArchiveSubscription` `work-loop.ts`'s `WorkLoopConfig.archive` consumes. */
export function buildArchiveSubscription(deps: ArchiveSubscriptionDeps): ArchiveSubscription {
  const logger = deps.logger ?? noopLogger;
  return {
    since: async (afterSequence: string): Promise<readonly AnnouncedSubmissionCard[]> => {
      const candidates = deps
        .readObservations()
        .filter((observation) => observation.type === SUBMISSION_ACCEPTED_TYPE)
        .filter((observation) => observation.sequence > afterSequence);

      const cards: AnnouncedSubmissionCard[] = [];
      for (const observation of candidates) {
        const card = await cardFromObservation(observation, deps.publicClient, deps.fetchIpfsBytes, logger);
        if (card !== undefined) cards.push(card);
      }
      return cards;
    },
  };
}
