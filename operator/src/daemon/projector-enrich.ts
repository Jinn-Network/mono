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
 *   - BRIDGE EXCEPTION (finding E32 / ruling E32): when the host-resolved bytes fail TEP
 *     `SubmissionRecordSchema` validation, `resolveTaskProjection` tries once more against the
 *     legacy `SignedTaskV1` shape the legacy `CreatorLoop` actually posts (no sealed Submission
 *     exists for these tasks until stage 3). A valid `SignedTaskV1` is admitted as a
 *     bridge-annotated synthetic Submission-equivalent (`legacy` derivation, see
 *     `bridge-legacy-delivery.ts`'s `synthesizeLegacyTaskProjection`) -- there is no separate
 *     Submission→Task indirection in this case, so the resolved bytes' own digest stands in for
 *     both legs of the join, still cross-checked against the on-chain anchor below. A document
 *     that is neither shape is genuinely malformed and still drops. Retires with the
 *     `legacyManifestDigest` bridge after stage 5.
 *   - For `TaskCreated` specifically, the RAW on-chain `taskCidDigest` is *also* compared against
 *     that joined value. A mismatch there is deliberately dropped too (never let a corrupted
 *     digest reach the reducer as if it were trustworthy) -- but note the reducer
 *     (`reduceMarketplaceProjection`) carries its own independent copy of this exact comparison
 *     for defense in depth; that is intentional redundancy, not dead code to remove.
 *   - `deliveryCorrespondence` (today-mode external Mech `Deliver` facts only) is a *different*
 *     kind of check: it recomputes the delivered content's real digests and compares them to
 *     on-chain facts, but a disagreement there is a legitimate protocol-level signal the reducer
 *     already knows how to reject on (`content-corruption`), not a reason to drop the event.
 *   - Unresolvable delivered content (the IPFS fetch itself fails) is DIFFERENT from a mismatch,
 *     and is a drop, not an admit-without-the-field: admitting is actively worse, because the event
 *     would be marked processed forever with the missing correspondence baked into
 *     `pendingMechDeliveries`, and the later router claim rejected for a fact that was merely slow
 *     to arrive. Fail-closed means dropping the ambiguous "not fetched yet" case, not admitting it
 *     as if it were a confirmed rejection.
 *
 *     A DROP IS NOT A RETRY (defect #47). Earlier revisions of this comment claimed the next tick
 *     re-attempts a dropped event because its log id never enters `processedLogIds`. That is false
 *     on the production wiring: `ChainLogSource.poll()` commits its advanced block cursor inside
 *     its own transaction BEFORE it returns the logs
 *     (`packages/marketplace/venue-base/src/log-source/chain-log-source.ts`), so each log is
 *     offered to `enrich` exactly once, ever. Every drop here is permanent for that log, and the
 *     only recovery is an explicit operator-run re-projection of the block range -- see
 *     `projector-replay.ts` and `docs/runbooks/projector-replay.md`. Fail-closed is still the right
 *     call for an ambiguous resolution; what it costs is a replay, not a free retry.
 *
 * Resolution goes entirely through host-injected ports (`ProjectorEnrichPorts`) -- this module
 * never hard-wires an IPFS gateway URL or duplicates ABI/contract-read logic that belongs to the
 * composition root (which already owns `createRegistryPinPort` and the IPFS fetch machinery
 * under `operator/src/adapters/mech/ipfs.ts`). Wiring real ports to real infrastructure is
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
import { SignedTaskV1Schema } from '../types/task-document.js';
import { synthesizeLegacyTaskProjection } from './bridge-legacy-delivery.js';

type Sha256Digest = `sha256:${string}`;

export interface ProjectorEnrichPorts {
  readonly chain: MarketplaceChainConfig;
  /**
   * Compatibility-only legacy CreatorLoop bridge. Native requester composition must set this to
   * false: it then drops a non-TEP document before SignedTaskV1 parsing or projection synthesis.
   * Omitted remains true only for the explicit legacy composition and its existing tests.
   */
  readonly allowLegacySignedTaskV1?: boolean;
  /** Live block reads, keyed by block hash so a reorg never serves a stale cached timestamp. */
  readonly publicClient: Pick<PublicClient, 'getBlock'>;
  /**
   * Fetches raw content bytes for a raw-codec sha256-CID digest anchor (IPFS). Undefined on any
   * failure (not found, gateway error, timeout) -- never throws. This module never trusts the
   * returned bytes without re-deriving and checking the digest itself.
   */
  readonly fetchIpfsBytes: (digest: Sha256Digest) => Promise<Uint8Array | undefined>;
  /**
   * Resolves a delivery record's raw content bytes for its sha256-CID anchor. Native deliveries are
   * HTTP-served and may never land on the queried IPFS gateway, so this port must try the configured
   * record-source locations first and only then fall back to IPFS (the #23/#2559/#2561 class, already
   * fixed on evaluator reads via the HTTP-first `recordFetcher`). Undefined on any miss; the caller
   * still re-derives and checks the digest, so untrusted bytes are never admitted. Absent falls back
   * to `fetchIpfsBytes` — the legacy composition has no HTTP record source.
   */
  readonly fetchDeliveryBytes?: (digest: Sha256Digest) => Promise<Uint8Array | undefined>;
  /**
   * Resolves a Task document's raw content bytes for its sha256-CID anchor -- the second leg of the
   * digest join below. Exactly the same #23/#2559/#2561 class as `fetchDeliveryBytes`: a native
   * Task record is HTTP-served off the requester's own record plane and may never land on the
   * queried IPFS gateway, so an IPFS-only resolver drops every event for a native task at
   * `resolveTaskProjection`'s content-fetch step even after its Submission resolves. Undefined on
   * any miss; the caller re-derives and checks the digest, so untrusted bytes are never admitted.
   * Absent falls back to `fetchIpfsBytes` -- the legacy composition has no HTTP record source.
   */
  readonly fetchTaskBytes?: (digest: Sha256Digest) => Promise<Uint8Array | undefined>;
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
    /** TaskCreated's canonical on-chain anchor, required by native association lookup. */
    readonly taskDigest?: Sha256Digest;
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
   * logic here).
   *
   * THREE answers, not two (#2647). `undefined` is reserved for a genuine ABSENCE -- the requestId
   * has no on-chain reference in either map yet -- and `'unavailable'` says the read itself failed.
   * The distinction is decidable rather than a guess: every view behind this port is a plain
   * mapping read (`contracts/src/tasks/TaskCoordinator.sol:437-465`) that returns a zero record or
   * `exists: false` for an unknown key and CANNOT revert, so a throw is always transport.
   */
  readonly readTodayDeliveryFacts: (requestId: Hex) => Promise<TodayDeliveryFacts | 'unavailable' | undefined>;
  /**
   * Defect #48, Gate C. Resolves the COUNTERPARTY's published solution-Delivery record for one
   * today-generation `SolutionDeliveryClaimed`, from the record plane rather than from a Mech
   * `Deliver` fact this operator does not subscribe to.
   *
   * Absent (the legacy composition, and any composition with no record plane) leaves the reducer's
   * mech-fact requirement untouched — this is purely additive. The port itself decides whether
   * this operator is the requester for the task; `enrich` only asks.
   *
   * Returns the two digests over the exact resolved bytes plus the coordinator's own anchor, so
   * the reducer can re-check the binding rather than trust this resolution — see
   * `ObservationProjectionContext.recordPlaneDelivery`.
   */
  readonly resolveRecordPlaneDelivery?: (input: {
    readonly chainId: number;
    readonly taskCoordinator: Address;
    readonly taskId: bigint;
    readonly attemptIndex: number;
    readonly requestId: Hex;
    readonly operator: Address;
  }) => Promise<RecordPlaneDeliveryResolution | undefined>;
  readonly logger?: { warn(message: string): void };
}

/** The on-chain delivery facts one requestId resolves to. */
export type TodayDeliveryFacts = {
  readonly taskId: bigint;
  readonly attemptIndex: number;
  readonly onChainKeccak: Hex;
};

/**
 * Defect #48, fix round. The resolver's answer is discriminated by ROLE, not by whether content
 * resolution happened to succeed.
 *
 * `undefined` — this operator is NOT the requester for this attempt (it is the solver, or it holds
 * no signed Submission for the task). The reducer's pre-existing mech-fact logic decides, exactly
 * as it did before #48; the solver path is untouched.
 *
 * `{ role: 'requester', witness }` — this operator IS the requester and resolved the counterparty's
 * published Delivery. The reducer re-checks the binding and records the delivery.
 *
 * `{ role: 'requester', witness: undefined }` — this operator IS the requester and could NOT
 * resolve the Delivery (serving plane down, record not yet published, catalog window exhausted).
 * A requester never witnesses the Mech `Deliver`, so it must NOT emit the reducer's
 * `rejected`/`invalid-reference` terminal on this: that terminal is permanent, lands beside the
 * verdict's own terminal, folds the Attempt `contradictory`, and makes `adoptPostedTask` throw
 * `attempt-contradictory` forever. `enrich` DROPS the event instead, which leaves the canonical log
 * clean and the event replayable once the plane is back.
 *
 * `{ role: 'undetermined', witness: undefined }` (#2647) — the role determination itself could not
 * complete, because a chain read it needs failed. Same DROP, and for the same reason: the resolver
 * may not report a role it does not know, and the one answer it must never give is the
 * not-the-requester `undefined`, which would hand the reducer a permanent false rejection on the
 * strength of a momentary RPC failure. Reached only after the free claimant gate has already ruled
 * this operator out as the solver, so dropping cannot cost a solver its own settlement.
 */
export type RecordPlaneDeliveryResolution =
  | {
    readonly role: 'requester';
    readonly witness: {
      readonly sha256Digest: Sha256Digest;
      readonly keccakEvidenceHash: Hex;
      readonly onChainKeccak: Hex;
    };
  }
  | {
    readonly role: 'requester' | 'undetermined';
    readonly witness: undefined;
    /**
     * The coordinator's anchor the missing record must hash to — the operator's search key. Absent
     * when the failure happened before that anchor was read, which is every `'undetermined'` case.
     */
    readonly onChainKeccak?: Hex;
    /** Diagnosable cause, logged verbatim at the drop site. */
    readonly reason: string;
  };

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

/** Decodes and JSON-parses resolved bytes. Never throws -- undefined on any decode failure. */
function decodeJsonDocument(bytes: Uint8Array): unknown | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseSubmissionBytes(bytes: Uint8Array): ReturnType<typeof SubmissionRecordSchema.parse> | undefined {
  const document = decodeJsonDocument(bytes);
  if (document === undefined) return undefined;
  const parsed = SubmissionRecordSchema.safeParse(document);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Bridge fallback (finding E32 / ruling E32): the legacy `CreatorLoop` posts a `SignedTaskV1`
 * document directly, with no sealed TEP Submission. Tried only after `parseSubmissionBytes`
 * fails -- a document that is neither shape is genuinely malformed and still drops.
 */
function parseLegacySignedTaskV1(bytes: Uint8Array): ReturnType<typeof SignedTaskV1Schema.parse> | undefined {
  const document = decodeJsonDocument(bytes);
  if (document === undefined) return undefined;
  const parsed = SignedTaskV1Schema.safeParse(document);
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
/**
 * Event kinds whose observation actually dereferences `projection.dispatchContext` — the
 * `attempt-engaged` emission in `packages/marketplace/projector/src/observe.ts`. For every other
 * kind the field is structurally required and functionally unread.
 */
const ENGAGEMENT_EVENTS: ReadonlySet<string> = new Set([
  'TaskAttemptCreated',
  'EvaluationAttemptCreated',
]);

/**
 * A descriptor for an event that carries `dispatchContext` without reading it. It names the task
 * it belongs to so it is never mistaken for a real engagement, and it is deliberately NOT a
 * sealed document: nothing has been engaged yet, so there is nothing to seal.
 */
function unengagedDispatchContext(chainId: number, taskId: bigint): ResourceDescriptor {
  return { uri: `urn:jinn:marketplace:unengaged:${chainId}:${taskId}` } as ResourceDescriptor;
}

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
    /** `"<event> at block <n>"` -- a drop is permanent, so the log line must name the replay range. */
    readonly origin: string;
  }): Promise<ResolvedTaskProjection | undefined> {
    const submissionBytes = await ports.resolveSubmissionBytes({
      chainId: input.chainId,
      taskCoordinator: ports.chain.taskCoordinator,
      taskId: input.taskId,
      generation: input.generation,
      taskDigest: input.onChainTaskDigest,
      submissionDigest: input.submissionDigest,
    });
    if (submissionBytes === undefined) {
      ports.logger?.warn(
        `[projector-enrich] no Submission resolved for task ${input.taskId} `
          + `(${input.origin}) -- dropping`,
      );
      return undefined;
    }
    const record = parseSubmissionBytes(submissionBytes);
    if (record === undefined) {
      if (ports.allowLegacySignedTaskV1 === false) {
        ports.logger?.warn(`[projector-enrich] native resolver returned a non-TEP Submission for task ${input.taskId} -- dropping`);
        return undefined;
      }
      // Bridge synthesis path (finding E32 / ruling E32): the resolved bytes failed TEP
      // `SubmissionRecordSchema` validation, but the legacy `CreatorLoop` posts a `SignedTaskV1`
      // document directly -- there is no sealed Submission to fail. Per the composition spec
      // §10 "Bridge-era document rules" and program cross-plan contract 9, a valid `SignedTaskV1`
      // is admitted as a bridge-annotated synthetic Submission-equivalent (`legacy` derivation,
      // same annotation contract as `synthesizeLegacyFactsCard`'s `AnnouncedSubmissionCard`,
      // Task 5/15 -- see `bridge-legacy-delivery.ts`'s `synthesizeLegacyTaskProjection`). A
      // document that is neither a valid Submission nor a valid `SignedTaskV1` is genuinely
      // malformed and still drops. Retires with the `legacyManifestDigest` bridge after stage 5.
      const legacyTask = parseLegacySignedTaskV1(submissionBytes);
      if (legacyTask === undefined) {
        ports.logger?.warn(`[projector-enrich] resolved Submission for task ${input.taskId} failed schema validation -- dropping`);
        return undefined;
      }
      const synthesized = synthesizeLegacyTaskProjection({ task: legacyTask, taskBytes: submissionBytes });
      if (input.onChainTaskDigest !== undefined && synthesized.taskDigest !== input.onChainTaskDigest) {
        ports.logger?.warn(
          `[projector-enrich] task ${input.taskId} digest join failed: on-chain anchor `
            + `${input.onChainTaskDigest} disagrees with synthesized legacy SignedTaskV1 digest `
            + `${synthesized.taskDigest} -- dropping`,
        );
        return undefined;
      }
      return synthesized;
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
    // Record-plane first (native Tasks are HTTP-served), IPFS gateway after -- `fetchTaskBytes`
    // already layers both; the legacy composition, which has no record source, stays IPFS-only.
    const taskBytes = await (ports.fetchTaskBytes ?? ports.fetchIpfsBytes)(claimedTaskDigest);
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
    if (facts === 'unavailable') {
      // Distinct from the absence below (#2647): the chain never answered, so nothing has been
      // learned about this requestId. Same drop -- the difference is what the operator goes and
      // fixes, and re-offering the event on the next replay is the whole point either way.
      ports.logger?.warn(
        `[projector-enrich] on-chain delivery facts for requestId ${requestId} unavailable (the `
          + 'request-reference read failed) -- dropping Deliver so a later tick can retry',
      );
      return undefined;
    }
    if (facts === undefined) {
      ports.logger?.warn(
        `[projector-enrich] no on-chain solution OR verdict request reference for requestId `
          + `${requestId} -- dropping Deliver`,
      );
      return undefined;
    }
    const onChainSha256CidDigest = digestFromBytes32(data);
    if (onChainSha256CidDigest === undefined) {
      // Not a canonical bytes32 anchor -- correspondence cannot even be attempted, but the
      // request/task identity we already resolved is still real, so admit the event without it
      // (mirrors the reducer's own `data.length === 66` gate, which handles absence explicitly).
      return { taskId: facts.taskId, attemptIndex: facts.attemptIndex, correspondence: undefined };
    }
    // HTTP-first (native records are HTTP-served), then IPFS. `fetchDeliveryBytes` already layers
    // both; only the legacy composition, which has no HTTP record source, falls back to IPFS alone.
    const deliveryBytes = await (ports.fetchDeliveryBytes ?? ports.fetchIpfsBytes)(onChainSha256CidDigest);
    if (deliveryBytes === undefined) {
      // Unresolvable-right-now is overwhelmingly transient (the record hasn't propagated yet).
      // Admitting instead would permanently mark this log id processed with no correspondence, so
      // a later, genuine "content is corrupt" rejection and a merely-not-yet-fetched delivery
      // would be indistinguishable and both permanent. The drop is permanent too (see the module
      // comment) -- recovery is an explicit replay, not the next tick.
      ports.logger?.warn(
        `[projector-enrich] delivery content ${onChainSha256CidDigest} for requestId ${requestId} `
          + 'unresolvable -- dropping Deliver so a later tick can retry',
      );
      return undefined;
    }
    const sha256Digest = computeRawCodecCid(deliveryBytes).sha256Digest;
    if (sha256Digest !== onChainSha256CidDigest) {
      // Fail closed: resolved bytes that do not hash to the on-chain anchor are forged or corrupt
      // (whichever source served them), never a correspondence to admit. Drop so a later tick can
      // re-resolve against an untampered replica.
      ports.logger?.warn(
        `[projector-enrich] delivery content ${onChainSha256CidDigest} for requestId ${requestId} `
          + `hashed to ${sha256Digest} -- dropping forged/corrupt Deliver bytes`,
      );
      return undefined;
    }
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

      // Defect #48, Gate C. Only the TODAY generation needs this: a revised
      // `SolutionDeliveryClaimed` carries `deliveryDigest` on the event itself, so the reducer
      // never consults a mech fact for its digest and the requester is already served.
      //
      // The resolver's answer is ROLE-discriminated (see `RecordPlaneDeliveryResolution`), and the
      // two non-witness answers are NOT the same fact:
      //   - `undefined` (not the requester) is a MISS — the reducer's pre-existing mech-fact branch
      //     runs and still decides. The solver path is untouched.
      //   - `{ witness: undefined }` (role `requester` or, since #2647, `undetermined`) is a DROP —
      //     a requester never witnesses the
      //     Mech `Deliver`, so handing the event to the reducer would emit `rejected`/
      //     `invalid-reference` on a delivery the coordinator itself settled. That terminal is
      //     permanent, folds the Attempt `contradictory` beside the verdict's terminal, and wedges
      //     `adoptPostedTask` on `attempt-contradictory` for good. Dropping leaves the canonical log
      //     clean and the event REPLAYABLE — the same contract `resolveSubmissionBytes` misses take,
      //     and what makes the runbook's rewind a recovery rather than a one-way door.
      let recordPlaneDelivery: ObservationProjectionContext['recordPlaneDelivery'];
      if (
        event.event === 'SolutionDeliveryClaimed'
        && !('deliveryDigest' in event.facts)
        && ports.resolveRecordPlaneDelivery !== undefined
        && attemptIndex !== undefined
      ) {
        let resolution: RecordPlaneDeliveryResolution | undefined;
        try {
          resolution = await ports.resolveRecordPlaneDelivery({
            chainId: event.derivation.chainId,
            taskCoordinator: ports.chain.taskCoordinator,
            taskId,
            attemptIndex,
            requestId: event.facts.requestId,
            operator: event.facts.operator,
          });
        } catch (error) {
          // A throw escapes the resolver only from its ROLE gates (the chain reads and the local
          // association lookup), i.e. before the role is known. That is a MISS, never a drop and
          // never a crash: this operator may well be the solver, and dropping a solver's settlement
          // would regress the pre-#48 behavior. Once the role IS known the resolver returns the
          // requester signal rather than throwing.
          ports.logger?.warn(
            `[projector-enrich] record-plane delivery resolution failed for task ${taskId} `
              + `attempt ${attemptIndex}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (resolution !== undefined) {
          if (resolution.witness === undefined) {
            ports.logger?.warn(
              `[projector-enrich] role=${resolution.role} DROPPING ${event.event} for task ${taskId} `
                + `attempt ${attemptIndex} (requestId ${event.facts.requestId}, anchor `
                + `${resolution.onChainKeccak ?? 'unread'}): no record-plane Delivery witness -- `
                + `${resolution.reason}. The event is NOT journaled and will be re-offered on the `
                + `next replay; bring the counterparty's serving plane up and rewind (defect #48).`,
            );
            return undefined;
          }
          recordPlaneDelivery = resolution.witness;
        }
      }

      const taskProjection = await resolveTaskProjection({
        chainId: event.derivation.chainId,
        taskId,
        generation: event.derivation.contractGeneration,
        submissionDigest,
        onChainTaskDigest,
        origin: `${event.event} at block ${event.derivation.blockNumber}`,
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
        // Only the `attempt-engaged` emission ever READS `dispatchContext`
        // (`packages/marketplace/projector/src/observe.ts:824`), and that emission is driven by
        // `TaskAttemptCreated` / `EvaluationAttemptCreated` — events that exist only *because*
        // this operator already claimed, which is the same moment the work loop seals the
        // descriptor into the engagement ledger. Every other event kind carries the field
        // structurally and never dereferences it.
        //
        // Requiring a resolved descriptor for all of them made the flow circular: `TaskCreated`
        // was dropped for want of a document that cannot exist until a claim that `TaskCreated`
        // is itself the trigger for. So the drop is scoped to the events that actually consume
        // it; the rest carry an explicitly unengaged descriptor that names the task it belongs
        // to and is never read.
        if (ENGAGEMENT_EVENTS.has(event.event)) {
          ports.logger?.warn(
            `[projector-enrich] no dispatch context resolved for engaged attempt on task ${taskId} -- dropping`,
          );
          return undefined;
        }
      }

      const projection: ObservationProjectionContext = {
        taskCoordinator: ports.chain.taskCoordinator,
        timestamp,
        submission: taskProjection.submission,
        taskDigest: taskProjection.taskDigest,
        effectiveDeadline: taskProjection.effectiveDeadline,
        dispatchContext:
          dispatchContext ?? unengagedDispatchContext(event.derivation.chainId, taskId),
        ...(deliveryCorrespondence === undefined ? {} : { deliveryCorrespondence }),
        ...(recordPlaneDelivery === undefined ? {} : { recordPlaneDelivery }),
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
