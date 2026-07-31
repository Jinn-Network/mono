/**
 * The projector's production enrich step (cutover stage 1, finding E20 / close-out plan §C4).
 *
 * `ProjectorLoopConfig.enrich` turns a decoded `MarketplaceEvent` into an
 * `ObservationMarketplaceEvent` (`event & { projection: ObservationProjectionContext }`) --
 * see `packages/marketplace/projector/src/observe.ts:18` for the authoritative field contract
 * and every consumer. This module is the first production implementation; before it, only Task
 * 9's unit-test fake existed.
 *
 * FAIL-CLOSED, NEVER FAKE: an event whose signed record cannot be honestly resolved this tick
 * returns `undefined` and is dropped -- `ProjectorLoop.tick()` already filters `undefined` out.
 * `enrich` never throws (every internal failure -- malformed bytes, an overflowing timestamp, a
 * port rejecting -- is caught and converted to a drop) because `projector-loop.ts` awaits every
 * event's enrichment with `Promise.all`, and one rejection there would abort the whole tick
 * rather than dropping just the one bad event.
 *
 * Digest-join model (the load-bearing part, per the close-out plan):
 *   - `taskDigest` is resolved from the SIGNED record chain only: the host-resolved Submission's
 *     own claim about its Task (`submission.task.digest.sha256`), cross-checked against the
 *     actual fetched Task bytes' locally-recomputed digest (`computeRawCodecCid`). Either leg
 *     failing to resolve, or the two legs disagreeing, is a drop.
 *   - For `TaskCreated` specifically, the RAW on-chain `taskCidDigest` is *also* compared against
 *     that joined value. A mismatch there is deliberately dropped too (never let a corrupted
 *     digest reach the reducer as if it were trustworthy) -- but note the reducer
 *     (`reduceMarketplaceProjection`) carries its own independent copy of this exact comparison
 *     for defense in depth; that is intentional redundancy, not dead code to remove.
 *   - `deliveryCorrespondence` (today-mode external Mech `Deliver` facts only) is a *different*
 *     kind of check: it recomputes the delivered content's real digests and compares them to
 *     on-chain facts, but a disagreement there is a legitimate protocol-level signal the reducer
 *     already knows how to reject on (`content-corruption`), not a reason to drop the event. Only
 *     genuine unresolvability (can't fetch the delivered bytes, can't read the on-chain fact) -
 *     leaves the field absent; the Deliver event itself is still admitted so its request/task
 *     identity is not silently lost.
 *
 * Resolution goes entirely through host-injected ports (`ProjectorEnrichPorts`) -- this module
 * never hard-wires an IPFS gateway URL or duplicates ABI/contract-read logic that belongs to the
 * composition root (which already owns `createRegistryPinPort` and the IPFS fetch machinery
 * under `client/src/adapters/mech/ipfs.ts`). Wiring real ports to real infrastructure is
 * out of this module's scope.
 */
import {
  computeRawCodecCid,
  decodeRevisedRequestData,
  keccakEvidenceHash,
  type ContractGeneration,
  type MarketplaceChainConfig,
} from '@jinn-network/marketplace-binding';
import type {
  MarketplaceEvent,
  ObservationMarketplaceEvent,
  ObservationProjectionContext,
} from '@jinn-network/marketplace-projector';
import { SubmissionRecordSchema, type ResourceDescriptor } from '@jinn-network/task-execution-protocol';
import type { Address, Hex, PublicClient } from 'viem';

type Sha256Digest = `sha256:${string}`;

export interface ProjectorEnrichPorts {
  readonly chain: MarketplaceChainConfig;
  /** Live block reads, keyed by block hash so a reorg never serves a stale cached timestamp. */
  readonly publicClient: Pick<PublicClient, 'getBlock'>;
  /**
   * Fetches raw content bytes for a raw-codec sha256-CID digest anchor (IPFS). Undefined on any
   * failure (not found, gateway error, timeout) -- never throws. This module never trusts the
   * returned bytes without re-deriving and checking the digest itself.
   */
  readonly fetchIpfsBytes: (digest: Sha256Digest) => Promise<Uint8Array | undefined>;
  /**
   * Host-resolved signed Submission bytes for an on-chain task. Revised generation supplies the
   * on-chain `submissionDigest` anchor as a hint; today generation has no on-chain anchor at all,
   * so the host resolves purely from task identity (e.g. its own creation record). Undefined when
   * unresolvable.
   */
  readonly resolveSubmissionBytes: (input: {
    readonly chainId: number;
    readonly taskCoordinator: Address;
    readonly taskId: bigint;
    readonly generation: ContractGeneration;
    readonly submissionDigest?: Sha256Digest;
  }) => Promise<Uint8Array | undefined>;
  /**
   * Host-sealed dispatch-context descriptor (TEP §9.3) for the task/attempt this event pertains
   * to. `attemptIndex`/`actor` are omitted for task-level events (`TaskCreated`,
   * `TaskBudgetRefunded`, `AttemptsAdded`, `TaskClosed`) that precede any attempt engagement.
   * Undefined when unresolvable.
   */
  readonly resolveDispatchContext: (input: {
    readonly chainId: number;
    readonly taskCoordinator: Address;
    readonly taskId: bigint;
    readonly attemptIndex?: number;
    readonly actor?: Address;
  }) => Promise<ResourceDescriptor | undefined>;
  /**
   * Today-mode on-chain delivery facts for a requestId: `TaskCoordinator.getRequestRef` then
   * `getAttempt.solutionCidDigest` (mirrors `packages/marketplace/venue-base/src/writers/
   * settlement.ts`'s `readMechDeliveryFacts`/`readRouterDeliveryFacts`, which are not exported
   * from that package -- read via this host-injected port instead of duplicating the ABI/read
   * logic here). Undefined when the requestId has no on-chain reference yet.
   */
  readonly readTodayDeliveryFacts: (requestId: Hex) => Promise<
    { readonly taskId: bigint; readonly attemptIndex: number; readonly onChainKeccak: Hex } | undefined
  >;
  readonly logger?: { warn(message: string): void };
}

/** Reinterprets an on-chain bytes32 anchor as its sha256 digest string. Never throws. */
function digestFromBytes32(value: Hex): Sha256Digest | undefined {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return undefined;
  return `sha256:${value.slice(2).toLowerCase()}`;
}

/** Never throws: an out-of-range timestamp is a drop, not a crash. */
function unixSecondsToRfc3339(seconds: bigint): string | undefined {
  const milliseconds = seconds * 1000n;
  if (milliseconds < 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return new Date(Number(milliseconds)).toISOString();
}

function parseSubmissionBytes(bytes: Uint8Array): ReturnType<typeof SubmissionRecordSchema.parse> | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = SubmissionRecordSchema.safeParse(document);
  return parsed.success ? parsed.data : undefined;
}

interface ResolvedTaskProjection {
  readonly submission: `urn:uuid:${string}`;
  readonly taskDigest: Sha256Digest;
  readonly effectiveDeadline: string;
}

/** Which task/attempt/generation an event pertains to, resolved from its own decoded facts. */
interface EventIdentity {
  readonly taskId: bigint;
  readonly attemptIndex?: number;
  readonly actor?: Address;
  /** `TaskCreated` only: the on-chain digest to cross-check the joined Submission/Task against. */
  readonly onChainTaskDigest?: Sha256Digest;
  /** `TaskCreated` (revised) only: the on-chain anchor for the Submission itself. */
  readonly submissionDigest?: Sha256Digest;
}

/** `TaskCreated`, `TaskAttemptCreated`, etc. all carry `taskId: bigint` in `facts` -- everything but `Deliver`. */
type TaskScopedEvent = Exclude<MarketplaceEvent, { event: 'Deliver' }>;

function eventIdentity(event: TaskScopedEvent): EventIdentity {
  switch (event.event) {
    case 'TaskCreated':
      return {
        taskId: event.facts.taskId,
        actor: event.facts.creator,
        onChainTaskDigest: digestFromBytes32(event.facts.taskCidDigest),
        submissionDigest: 'submissionDigest' in event.facts
          ? digestFromBytes32(event.facts.submissionDigest)
          : undefined,
      };
    case 'TaskAttemptCreated':
      return { taskId: event.facts.taskId, attemptIndex: event.facts.attemptIndex, actor: event.facts.operator };
    case 'EvaluationAttemptCreated':
      return { taskId: event.facts.taskId, attemptIndex: event.facts.attemptIndex, actor: event.facts.evaluator };
    case 'SolutionDeliveryPrepared':
      return { taskId: event.facts.taskId, attemptIndex: event.facts.attemptIndex, actor: event.facts.operator };
    case 'VerdictDeliveryPrepared':
      return { taskId: event.facts.taskId, attemptIndex: event.facts.attemptIndex, actor: event.facts.evaluator };
    case 'SolutionDeliveryClaimed':
      return { taskId: event.facts.taskId, attemptIndex: event.facts.attemptIndex, actor: event.facts.operator };
    case 'VerdictDeliveryClaimed':
      return { taskId: event.facts.taskId, attemptIndex: event.facts.attemptIndex, actor: event.facts.evaluator };
    case 'AttemptExpired':
    case 'AttemptReleased':
    case 'AttemptForfeited':
      return { taskId: event.facts.taskId, attemptIndex: event.facts.attemptIndex, actor: event.facts.operator };
    case 'VerdictForfeited':
      return { taskId: event.facts.taskId, attemptIndex: event.facts.attemptIndex, actor: event.facts.evaluator };
    case 'ReservationForfeited':
      return { taskId: event.facts.taskId, attemptIndex: event.facts.attemptIndex };
    case 'TaskBudgetRefunded':
    case 'AttemptsAdded':
    case 'TaskClosed':
      return { taskId: event.facts.taskId, actor: event.facts.creator };
  }
}

/** Builds the enrich function `ProjectorLoopConfig.enrich` consumes. */
export function createProjectorEnrich(
  ports: ProjectorEnrichPorts,
): (event: MarketplaceEvent) => Promise<ObservationMarketplaceEvent | undefined> {
  // Keyed by block HASH, not number: a reorg mines a different block at the same height, and a
  // number-keyed cache would silently keep serving the orphaned block's timestamp.
  const blockTimestampCache = new Map<Hex, Promise<bigint | undefined>>();

  function blockTimestampSeconds(blockHash: Hex): Promise<bigint | undefined> {
    const cached = blockTimestampCache.get(blockHash);
    if (cached !== undefined) return cached;
    const promise = ports.publicClient
      .getBlock({ blockHash })
      .then((block) => block.timestamp)
      .catch(() => undefined);
    blockTimestampCache.set(blockHash, promise);
    return promise;
  }

  async function resolveTaskProjection(input: {
    readonly chainId: number;
    readonly taskId: bigint;
    readonly generation: ContractGeneration;
    readonly submissionDigest?: Sha256Digest;
    readonly onChainTaskDigest?: Sha256Digest;
  }): Promise<ResolvedTaskProjection | undefined> {
    const submissionBytes = await ports.resolveSubmissionBytes({
      chainId: input.chainId,
      taskCoordinator: ports.chain.taskCoordinator,
      taskId: input.taskId,
      generation: input.generation,
      submissionDigest: input.submissionDigest,
    });
    if (submissionBytes === undefined) {
      ports.logger?.warn(`[projector-enrich] no Submission resolved for task ${input.taskId} -- dropping`);
      return undefined;
    }
    const record = parseSubmissionBytes(submissionBytes);
    if (record === undefined) {
      ports.logger?.warn(`[projector-enrich] resolved Submission for task ${input.taskId} failed schema validation -- dropping`);
      return undefined;
    }
    const claimedHex = record.task.digest?.sha256;
    if (typeof claimedHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(claimedHex)) {
      ports.logger?.warn(`[projector-enrich] Submission for task ${input.taskId} carries no valid task sha256 digest -- dropping`);
      return undefined;
    }
    const claimedTaskDigest: Sha256Digest = `sha256:${claimedHex.toLowerCase()}`;
    if (input.onChainTaskDigest !== undefined && claimedTaskDigest !== input.onChainTaskDigest) {
      ports.logger?.warn(
        `[projector-enrich] task ${input.taskId} digest join failed: on-chain anchor `
          + `${input.onChainTaskDigest} disagrees with Submission's claimed ${claimedTaskDigest} -- dropping`,
      );
      return undefined;
    }
    const taskBytes = await ports.fetchIpfsBytes(claimedTaskDigest);
    if (taskBytes === undefined) {
      ports.logger?.warn(`[projector-enrich] Task content ${claimedTaskDigest} for task ${input.taskId} unresolvable -- dropping`);
      return undefined;
    }
    const actualTaskDigest = computeRawCodecCid(taskBytes).sha256Digest;
    if (actualTaskDigest !== claimedTaskDigest) {
      ports.logger?.warn(
        `[projector-enrich] task ${input.taskId} digest join failed: fetched Task bytes hash to `
          + `${actualTaskDigest}, Submission claimed ${claimedTaskDigest} -- dropping`,
      );
      return undefined;
    }
    return { submission: record.submission as `urn:uuid:${string}`, taskDigest: claimedTaskDigest, effectiveDeadline: record.deadline };
  }

  async function resolveTodayDeliveryCorrespondence(
    requestId: Hex,
    data: Hex,
  ): Promise<{
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly correspondence: ObservationProjectionContext['deliveryCorrespondence'];
  } | undefined> {
    const facts = await ports.readTodayDeliveryFacts(requestId);
    if (facts === undefined) {
      ports.logger?.warn(`[projector-enrich] no on-chain request reference for requestId ${requestId} -- dropping Deliver`);
      return undefined;
    }
    const onChainSha256CidDigest = digestFromBytes32(data);
    if (onChainSha256CidDigest === undefined) {
      // Not a canonical bytes32 anchor -- correspondence cannot even be attempted, but the
      // request/task identity we already resolved is still real, so admit the event without it
      // (mirrors the reducer's own `data.length === 66` gate, which handles absence explicitly).
      return { taskId: facts.taskId, attemptIndex: facts.attemptIndex, correspondence: undefined };
    }
    const deliveryBytes = await ports.fetchIpfsBytes(onChainSha256CidDigest);
    if (deliveryBytes === undefined) {
      ports.logger?.warn(
        `[projector-enrich] delivery content ${onChainSha256CidDigest} for requestId ${requestId} unresolvable `
          + '-- admitting Deliver without deliveryCorrespondence',
      );
      return { taskId: facts.taskId, attemptIndex: facts.attemptIndex, correspondence: undefined };
    }
    const sha256Digest = computeRawCodecCid(deliveryBytes).sha256Digest;
    const evidenceHash = keccakEvidenceHash(deliveryBytes);
    return {
      taskId: facts.taskId,
      attemptIndex: facts.attemptIndex,
      correspondence: {
        sha256Digest,
        keccakEvidenceHash: evidenceHash,
        onChainSha256CidDigest,
        onChainKeccak: facts.onChainKeccak,
      },
    };
  }

  return async function enrich(event: MarketplaceEvent): Promise<ObservationMarketplaceEvent | undefined> {
    try {
      const timestampSeconds = await blockTimestampSeconds(event.derivation.blockHash);
      if (timestampSeconds === undefined) {
        ports.logger?.warn(`[projector-enrich] block ${event.derivation.blockHash} timestamp unresolvable -- dropping`);
        return undefined;
      }
      const timestamp = unixSecondsToRfc3339(timestampSeconds);
      if (timestamp === undefined) {
        ports.logger?.warn(`[projector-enrich] block ${event.derivation.blockHash} timestamp out of range -- dropping`);
        return undefined;
      }

      let taskId: bigint;
      let attemptIndex: number | undefined;
      let actor: Address | undefined;
      let onChainTaskDigest: Sha256Digest | undefined;
      let submissionDigest: Sha256Digest | undefined;
      let deliveryCorrespondence: ObservationProjectionContext['deliveryCorrespondence'];

      if (event.event === 'Deliver') {
        if ('requestData' in event.facts) {
          // Revised mode: taskId/attemptIndex are self-contained in the signed request data --
          // no chain read needed, and `deliveryCorrespondence` is a today-mode-only obligation
          // (revised settlement keeps sha256 only; see `packages/marketplace/binding/src/
          // delivery.ts`'s `DeliveryCorrespondence` doc comment), so it is left absent.
          const decoded = decodeRevisedRequestData(event.facts.requestData);
          taskId = decoded.taskId;
          attemptIndex = decoded.attemptIndex;
        } else {
          const resolved = await resolveTodayDeliveryCorrespondence(event.facts.requestId, event.facts.data);
          if (resolved === undefined) return undefined;
          taskId = resolved.taskId;
          attemptIndex = resolved.attemptIndex;
          deliveryCorrespondence = resolved.correspondence;
        }
      } else {
        const identity = eventIdentity(event);
        taskId = identity.taskId;
        attemptIndex = identity.attemptIndex;
        actor = identity.actor;
        onChainTaskDigest = identity.onChainTaskDigest;
        submissionDigest = identity.submissionDigest;
      }

      const taskProjection = await resolveTaskProjection({
        chainId: event.derivation.chainId,
        taskId,
        generation: event.derivation.contractGeneration,
        submissionDigest,
        onChainTaskDigest,
      });
      if (taskProjection === undefined) return undefined;

      const dispatchContext = await ports.resolveDispatchContext({
        chainId: event.derivation.chainId,
        taskCoordinator: ports.chain.taskCoordinator,
        taskId,
        attemptIndex,
        actor,
      });
      if (dispatchContext === undefined) {
        ports.logger?.warn(`[projector-enrich] no dispatch context resolved for task ${taskId} -- dropping`);
        return undefined;
      }

      const projection: ObservationProjectionContext = {
        taskCoordinator: ports.chain.taskCoordinator,
        timestamp,
        submission: taskProjection.submission,
        taskDigest: taskProjection.taskDigest,
        effectiveDeadline: taskProjection.effectiveDeadline,
        dispatchContext,
        ...(deliveryCorrespondence === undefined ? {} : { deliveryCorrespondence }),
      };
      return { ...event, projection } as ObservationMarketplaceEvent;
    } catch (error) {
      ports.logger?.warn(
        `[projector-enrich] unexpected enrichment failure, dropping event: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };
}
