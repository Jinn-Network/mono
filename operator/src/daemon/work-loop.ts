/**
 * The work loop (cutover stage 1, Task 13): closes the claim-to-settle loop against the
 * composition root's (Task 12) merged pipeline/venue/backend stack. Per card announced by the
 * projector's local archive: gate on projector catch-up (contract 3, `ClaimGate`), map to
 * `SubmissionFacts` (Task 5), gate on the SQLite rolling-window AI-units/spend-cap accounting,
 * admit a claim intent in the engagement ledger strictly before any broadcast (contract 2,
 * Task 6), then drive `runPipeline` (`@jinn-network/marketplace-pipeline`) claim -> finalized ->
 * submit -> deliver -> settle, funneling the mech Deliver leg (Task 8,
 * `@jinn-network/marketplace-venue-base`) through the settlement port so the Deliver fact exists
 * before settlement reads it.
 *
 * PLAN-VS-CODE GAPS this file resolves (see the Task 13 execution report for detail; every one
 * confirmed against the real already-landed Tasks 5-12 shapes rather than guessed):
 *
 *  1. `ClaimGate.waitUntilOpen()` (Task 10, already landed) blocks indefinitely on a gate that
 *     never opens unless the caller passes an `AbortSignal` — it does NOT "return while still
 *     closed" on its own. Calling it unconditionally every tick is safe in production (a fresh
 *     gate opens once and then short-circuits forever), but this module still checks `isOpen()`
 *     immediately after awaiting it, matching the plan's literal "if still closed" framing
 *     without assuming a behavior the real Task-10 gate does not have.
 *  2. `venue.claim` (`composition.pipelinePorts.claim`, built by `createBaseVenue`) is only
 *     `{claimTask, preflight, priorityMech}` cast `as ClaimPorts` at construction. `runPipeline`
 *     itself spreads `taskDigest`/`submission`/`nonce`/`priorityMech` from `facts`/
 *     `config.priorityMech` onto `ports.claim` before calling `claimAttempt`, but it never
 *     supplies `capabilityMatch`. The explicit legacy compatibility branch therefore re-reads
 *     the backend capability snapshot and refuses a profile mismatch. Native mode never enters
 *     this pipeline: its evidence-bearing capability/launcher/preflight decision is persisted by
 *     `NativeClaimCoordinator` before the claim intent.
 *  3. `ArchiveSubscription.since(afterSequence)` returns only `AnnouncedSubmissionCard[]` — no
 *     card carries a sequence/cursor value a caller could feed back in. This loop therefore never
 *     advances its cursor; every tick re-lists the archive and relies on the engagement ledger's
 *     own dedupe (`admitClaimIntent` returning `false`) to skip cards already claimed. Correct,
 *     but not incremental — closing that needs the concrete archive adapter (out of this task's
 *     scope) to expose a real sequence.
 *  4. `PipelineRunInput.taskBytes`/`submissionBytes` (the sealed Task/Submission document bytes
 *     `backend.submit` needs) are not carried by `AnnouncedSubmissionCard` and no port for
 *     fetching them exists anywhere in the already-landed Task 5-12 surface. Added
 *     `readSealedDocuments` as a new host-supplied config port, matching the existing
 *     `archive`/`ledger`/`claimGate` pattern.
 *  5. `PipelineRunOutcome`'s `delivered` case carries only `{state: AttemptState}` — a bare
 *     state-name string, never a `receipt.record` the plan's prose names. There is no evidence
 *     record reference anywhere in `runPipeline`'s return value.
 *     `composition.evidence.ports.awaitIndexed` requires one (`EvidenceRecordReference`, i.e.
 *     `{family, digest}`). This loop derives one from the delivery bytes it already captured off
 *     the wrapped `deliveryWait` port, using the same `computeRawCodecCid` digest
 *     `deliverToMarketplace` computes for the mech Deliver call, tagged
 *     `family: 'execution-evidence'`.
 *
 * Also per execution-report Finding E20 (not fixed here, out of scope): the composition root's
 * `observations` port is stubbed `async () => []` and no `ProjectorLoopConfig.enrich`
 * implementation exists anywhere in `operator/src`, so `venue.observe`/`lifecycle`/`finality`
 * report "no Attempt" for every ref against live chain traffic today. This loop's own tests use
 * fakes and pass; that does not mean the loop works end-to-end against a live projector yet.
 */
import {
  resolveWiringEntry,
  runPipeline,
  type ExecutionWiringEntry,
  type PipelinePorts,
  type PipelineRunOutcome,
} from '@jinn-network/marketplace-pipeline';
import { computeRawCodecCid, deriveMarketplaceAttemptUri } from '@jinn-network/marketplace-binding';
import { deliverToMarketplace } from '@jinn-network/marketplace-venue-base';
import {
  documentDigest,
  serializeCanonicalJson,
  type DispatchContext,
} from '@jinn-network/task-execution-protocol';
import type { Store } from '../store/store.js';
import type { EngagementLedger } from './engagement-ledger.js';
import type { ClaimGate } from './claim-gate.js';
import type { OperatorComposition } from './composition-root.js';
import type { NativeDiscoveryConsumer, NativeDiscoveryQueuedCard } from './native-discovery.js';
import { drainNativeDiscoveryWithdrawals } from './native-discovery-withdrawals.js';
import type { NativeSolutionCorrections } from './native-solution-corrections.js';
import type {
  NativeClaimCoordinator,
  NativeClaimCoordinatorResult,
} from './native-claim-coordinator.js';
import type { NativeSolutionCoordinator } from './native-solution-coordinator.js';
import { runLoop } from './loop-heartbeat.js';
import { gateClaimByAiUnits } from './ai-units-gate.js';
import { gateClaimBySpendCap } from './spend-cap-gate.js';
import { blockIdUtc } from '../spend/ai-units.js';
import {
  persistWorkLoopDeliveredCorpus,
  wrapBackendWithWorkLoopCorpus,
} from './work-loop-corpus.js';
import {
  mapAnnouncedSubmissionToFacts,
  type AnnouncedSubmissionCard,
  type SubmissionFacts,
} from './native-submission-facts.js';
import { recordPhaseDTransitionUse } from '../compatibility/phase-d-transition-usage.js';

export type { AnnouncedSubmissionCard };

/** Local-archive announcements the projector wrote since `afterSequence`. */
export interface ArchiveSubscription {
  since(afterSequence: string): Promise<readonly AnnouncedSubmissionCard[]>;
}

/** The sealed Task/Submission document bytes `backend.submit` needs (gap 4, file header). */
export interface SealedDocuments {
  readonly taskBytes: Uint8Array;
  readonly submissionBytes: Uint8Array;
}

/** Flat single-credential AI-units gate config for this loop — see gap discussion, file header. */
export interface AiUnitsConfig {
  readonly credentialId: string;
  readonly capPerBlockUsdMicros: number;
  readonly capPerWeekUsdMicros: number;
}

/** Flat single-credential spend-cap gate config for this loop. */
export interface SpendCapConfig {
  readonly credentialId: string;
  readonly capUsd: number;
}

export interface WorkLoopConfig {
  readonly composition: OperatorComposition;
  /** Explicit legacy-only compatibility adapter. Native work never reads this source. */
  readonly archive?: ArchiveSubscription;
  /** Verified, checkpointed native source consumer. Mutually exclusive with native archive use. */
  readonly nativeDiscovery?: NativeDiscoveryConsumer;
  readonly nativeClaimCoordinator?: Pick<NativeClaimCoordinator, 'startWorker' | 'renewWorker' | 'reconcileStartup' | 'process'>;
  readonly nativeSolutionCoordinator?: Pick<NativeSolutionCoordinator, 'reconcileStartup' | 'reconcileEngagement'>;
  /**
   * Append-only signed corrections to already-published delivery announcements when a reorg
   * orphans (or re-canonicalises) their settlement event — `native-solution-corrections.ts`.
   *
   * Required in native mode, like the other three. The solver host ran this every tick before
   * consuming its source (one-swap M3, #2461); the fleet loop runs it in the same position, so a
   * card is never admitted while this operator's own published deliveries still advertise an
   * orphaned block as available.
   */
  readonly nativeSolutionCorrections?: NativeSolutionCorrections;
  readonly ledger: EngagementLedger;
  readonly claimGate: ClaimGate;
  readonly store: Store;
  readonly estimateAiUnits: (workKind: string) => number;
  /** Fetches the sealed Task/Submission bytes for a card (gap 4, file header). */
  readonly readSealedDocuments: (card: AnnouncedSubmissionCard) => Promise<SealedDocuments>;
  readonly aiUnits?: AiUnitsConfig;
  readonly spendCap?: SpendCapConfig;
  readonly pollIntervalMs: number;
  /**
   * How often the native loop re-drives its in-flight engagements, in milliseconds (#2540).
   * Defaults to `NATIVE_RECONCILE_INTERVAL_MS`. `0` reconciles on every tick.
   */
  readonly nativeReconcileIntervalMs?: number;
  /**
   * How long an unchanged tick summary may go unlogged, in milliseconds (#2540). Defaults to
   * `TICK_SUMMARY_MAX_SILENCE_MS`. `0` disables the dedupe entirely (log every tick).
   */
  readonly tickSummaryMaxSilenceMs?: number;
  readonly acceptLegacyCards: boolean;
  readonly logger?: { info(m: string): void; warn(m: string): void };
  /** Injectable clock for the two cadences above. Production uses `Date.now`. */
  readonly now?: () => number;
}

export type WorkLoopOutcome =
  | {
      readonly kind: 'skipped';
      readonly reason:
        | 'gate-closed'
        | 'mapping-refused'
        | 'ai-units-capped'
        | 'spend-capped'
        | 'already-engaged';
    }
  | { readonly kind: 'pipeline'; readonly result: PipelineRunOutcome }
  | { readonly kind: 'native-claim'; readonly result: NativeClaimCoordinatorResult };

const noopLogger = { info: (): void => undefined, warn: (): void => undefined };
const LEGACY_ARCHIVE_START_SEQUENCE = '';

/**
 * #2540: how often the native fleet loop re-drives its in-flight engagements.
 *
 * `initialize()` reconciled once and never again, and `tick()` only ever processes PENDING
 * discovery cards — a card is acknowledged inside the coordinator's claim-admission transaction,
 * so the moment a claim is admitted nothing re-drives it. A claim whose next step is a later
 * on-chain promotion therefore just sits: live, task 1221 stayed at `observed-safe` for 35 minutes
 * with the projector's finalized cursor 855 blocks past it, and restarting the daemon — which is
 * to say, running `initialize()` again — advanced it to `finalized` in 35 seconds. A restart is
 * not a recovery mechanism.
 *
 * 30s rather than every tick: both reconciles walk only non-terminal rows, so an idle operator
 * pays one empty SELECT, but a busy one pays a canonical chain read per in-flight operation. The
 * shortest promotion this can delay is bounded by that interval, which is far inside the finality
 * horizon these promotions wait on anyway.
 */
const NATIVE_RECONCILE_INTERVAL_MS = 30_000;

/**
 * #2540: how long the tick-summary dedupe may stay silent before re-logging an unchanged summary.
 *
 * This deliberately reverses the call recorded in `logOutcomes`'s own doc comment below, which
 * rejected a bounded re-log on the grounds that "an operator can already tell the loop is alive
 * from other loops' liveness signals". Round 8 disproved that: operator B logged one work line at
 * 03:12:06 and nothing for the next 25 minutes while ticking normally every few seconds, and a
 * whole diagnostic round was spent on a solver loop that had never stopped. A healthy idle loop
 * and a dead one have to be distinguishable from the loop's OWN output.
 */
const TICK_SUMMARY_MAX_SILENCE_MS = 60_000;

function idempotencyKeyFor(chain: { chainId: number; taskCoordinator: string }, taskId: bigint): string {
  return `${chain.chainId}:${chain.taskCoordinator}:${taskId.toString()}`;
}

/**
 * Finding E39 (diagnose→fix cycle 1): resolves a legacy-bridged card's real `workKind` against
 * this operator's wiring config, by anchored manifest digest.
 *
 * `mapAnnouncedSubmissionToFacts` (package `facts-mapper.ts`) sets `facts.workKind` to the raw
 * anchored `legacyManifestDigest` itself for any legacy-derivation card -- not a human-readable
 * workKind -- because the projector that synthesizes these cards
 * (`bridge-legacy-delivery.ts`'s `synthesizeLegacyFactsCard`) only ever sees the on-chain
 * `TaskCreated` args, never the operator's wiring config, so it has no human name to put there.
 * Every downstream consumer of `facts.workKind` disagrees with that: `buildClaimPredicate`'s
 * `byWorkKind` lookup (`composition-root.ts`), this loop's own `resolveWiringEntry` call below,
 * and `runPipeline`'s internal `resolveWiringEntry` call (`pipeline.ts`) all expect it to already
 * be the wiring's own human key -- confirmed against `claim-predicate.test.ts`'s
 * `matchLegacyManifestDigest` fixture, which models a legacy card as `{workKind: "repo-fix",
 * legacyManifestDigest: "sha256:manifest-a"}`, i.e. `legacyManifestDigest` as a side-channel
 * verification field, `workKind` unchanged. Left unfixed, EVERY legacy-bridged card is declined
 * at the very first gate (`predicate-declined`) regardless of wiring, because no wiring entry's
 * `workKind` string ever equals a digest.
 *
 * This is the one place with both the raw card and the operator's wiring in hand, so it resolves
 * the substitution host-side rather than reaching into the package: find the wiring entry whose
 * declared `legacyManifestDigest` matches this card's anchored one, and use ITS `workKind` from
 * here on. No match -> `workKind` is left as the digest, and the pre-existing
 * `wiring-missing`/`predicate-declined` refusal still fires correctly for a digest this operator
 * genuinely has no wiring for.
 */
function resolveLegacyWorkKind(
  legacyManifestDigest: string,
  wiring: readonly ExecutionWiringEntry[],
): string | undefined {
  return wiring.find((entry) => entry.legacyManifestDigest === legacyManifestDigest)?.workKind;
}

/**
 * Renders a `WorkLoopOutcome` down to one diagnostic string. Skip reasons pass through as-is;
 * pipeline outcomes are prefixed `pipeline:<kind>` and, for the two kinds that carry a
 * machine-readable reason/detail beyond their `kind` tag, that reason is appended -- this is what
 * makes `not-claimed` (predicate-declined / caps-exceeded / wiring-missing / ...) legible instead
 * of collapsing to the same opaque "pipeline:not-claimed" line regardless of cause.
 */
function describeOutcome(outcome: WorkLoopOutcome): string {
  if (outcome.kind === 'skipped') return outcome.reason;
  if (outcome.kind === 'native-claim') return `native-claim:${outcome.result.kind}`;
  const result = outcome.result;
  switch (result.kind) {
    case 'not-claimed':
      return `pipeline:not-claimed:${result.reason}`;
    case 'claim-refused':
      return `pipeline:claim-refused:${result.reason}`;
    case 'finality-failed':
      return `pipeline:finality-failed:${result.finalityKind}`;
    case 'submit-rejected':
      return `pipeline:submit-rejected:${result.detail}`;
    case 'delivery-wait-failed':
      return `pipeline:delivery-wait-failed:${result.waitKind}`;
    case 'settlement-failed': {
      const gate = result.result;
      const detail =
        gate !== undefined && typeof gate === 'object' && 'kind' in gate
          ? String((gate as { kind: unknown }).kind)
          : 'unknown';
      return `pipeline:settlement-failed:${detail}`;
    }
    default:
      return `pipeline:${result.kind}`;
  }
}

export class WorkLoop {
  private stopped = false;
  private nativeInitialized = false;
  /** Last tick's serialized per-card outcome summary, for the log-on-change dedupe (E39). */
  private lastLoggedOutcomeSummary: string | undefined;
  /** When that summary was last actually emitted, for the dedupe's time bound (#2540). */
  private lastLoggedOutcomeAt: number | undefined;
  /** When the steady-state native reconcile last ran (#2540). */
  private lastNativeReconcileAt: number | undefined;

  constructor(private readonly config: WorkLoopConfig) {
    if (config.composition.mode === 'native') {
      if (config.acceptLegacyCards || config.archive !== undefined) {
        throw new Error('native work loop requires acceptLegacyCards=false and no legacy archive');
      }
      if (
        config.nativeDiscovery === undefined
        || config.nativeClaimCoordinator === undefined
        || config.nativeSolutionCoordinator === undefined
        || config.nativeSolutionCorrections === undefined
      ) {
        throw new Error(
          'native work loop requires verified discovery, durable claim/solution coordinators, '
          + 'and the signed reorg-correction reconciler',
        );
      }
    } else if (
      config.nativeDiscovery !== undefined
      || config.nativeClaimCoordinator !== undefined
      || config.nativeSolutionCoordinator !== undefined
      || config.nativeSolutionCorrections !== undefined
    ) {
      throw new Error('legacy work loop cannot receive native discovery, claim, or solution coordinator');
    }
  }

  /** Native startup order: own the worker, reconcile chain effects, then accept a signed source head. */
  async initialize(): Promise<void> {
    if (this.config.composition.mode !== 'native') return;
    this.config.nativeClaimCoordinator!.startWorker();
    await this.config.nativeClaimCoordinator!.reconcileStartup();
    await this.config.nativeSolutionCoordinator!.reconcileStartup();
    await this.config.nativeDiscovery!.sync();
    this.nativeInitialized = true;
    this.lastNativeReconcileAt = this.now();
  }

  private now(): number {
    return (this.config.now ?? Date.now)();
  }

  /**
   * #2540: the steady-state half of `initialize()`'s reconcile.
   *
   * Same two calls, same order, on a cadence instead of once. It never blocks the tick that
   * follows it: a reconcile is RECOVERY, and a recovery that cannot run is not a reason to stop
   * taking new work — that is the same collateral-damage shape as #2529/#2530/#2533/#2539, and it
   * would be a poor trade to fix the "nothing re-drives an admitted claim" freeze by introducing a
   * "one unreconcilable operation blocks every claim" freeze. The failure is named and logged, and
   * the cadence timestamp still advances so a persistent failure retries on the next interval
   * rather than on every tick.
   */
  private async reconcileInFlight(): Promise<void> {
    const interval = this.config.nativeReconcileIntervalMs ?? NATIVE_RECONCILE_INTERVAL_MS;
    const at = this.now();
    if (this.lastNativeReconcileAt !== undefined && at - this.lastNativeReconcileAt < interval) return;
    this.lastNativeReconcileAt = at;
    try {
      await this.config.nativeClaimCoordinator!.reconcileStartup();
      await this.config.nativeSolutionCoordinator!.reconcileStartup();
    } catch (cause) {
      this.logger().warn(
        `[work] steady-state reconcile failed (non-fatal, retrying next cadence): `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /** One pass over new archive cards. Returns per-card outcomes for assertions. */
  async tick(): Promise<readonly { card: string; outcome: WorkLoopOutcome }[]> {
    const nativeQueued = await this.readNativeCards();
    // This legacy-only compatibility branch remains deliberately separate from native source
    // consumption. Native work has no call path to ArchiveSubscription at all.
    const cards = nativeQueued === undefined
      ? await this.readLegacyCards()
      : nativeQueued.map((item) => item.card);
    const results: { card: string; outcome: WorkLoopOutcome }[] = [];
    for (const [index, card] of cards.entries()) {
      const outcome = nativeQueued === undefined
        ? await this.processCard(card)
        : await this.processNativeCard(nativeQueued[index]!);
      results.push({ card: card.chain.submission, outcome });
      // Native acknowledgement is part of the coordinator's admission transaction. Retryable
      // deferrals and failures remain pending; the work loop never acknowledges independently.
    }
    this.logOutcomes(cards, results);
    return results;
  }

  private async processNativeCard(queued: NativeDiscoveryQueuedCard): Promise<WorkLoopOutcome> {
    await this.config.claimGate.waitUntilOpen();
    if (!this.config.claimGate.isOpen()) return { kind: 'skipped', reason: 'gate-closed' };
    const documents = await this.config.readSealedDocuments(queued.card);
    const result = await this.config.nativeClaimCoordinator!.process(queued, documents);
    if (result.kind === 'claim-finalized') {
      await this.config.nativeSolutionCoordinator!.reconcileEngagement(result.engagementId);
    }
    return { kind: 'native-claim', result };
  }

  private async readNativeCards(): Promise<readonly NativeDiscoveryQueuedCard[] | undefined> {
    const native = this.config.nativeDiscovery;
    if (native === undefined) return undefined;
    if (!this.nativeInitialized) throw new Error('native work loop must initialize before polling');
    this.config.nativeClaimCoordinator!.renewWorker();
    // #2540: re-drive whatever is already in flight before looking for anything new. Same position
    // and same order as `initialize()`, so an admitted claim awaiting a later on-chain promotion
    // reaches its terminal state on a cadence rather than at the next daemon restart.
    await this.reconcileInFlight();
    // Before consuming any source: correct this operator's own already-published delivery
    // announcements against the current canonical chain. Same position the native solver host ran
    // it in (one-swap M3, #2461) — a reorged delivery must be signed-withdrawn before new work is
    // admitted, not after.
    await this.config.nativeSolutionCorrections!.reconcile();
    // `sync()` is the verified signed-head gate. A stale/tampered/rewound head rejects before
    // `takePending()` is reached, so even previously queued cards cannot start native work under
    // a failed current sync.
    await native.sync();
    // A requester's signed withdrawal retires the cards it retracts BEFORE this tick decides what
    // to claim, so a retracted announcement cannot be picked up in the same pass that learned of
    // its retraction. `drainNativeDiscoveryWithdrawals` refuses a withdrawal naming an
    // announcement absent from this operator's authenticated local history.
    await drainNativeDiscoveryWithdrawals({ store: this.config.store, discovery: native });
    return native.takePending();
  }

  private async readLegacyCards(): Promise<readonly AnnouncedSubmissionCard[]> {
    if (this.config.archive === undefined) {
      throw new Error('work loop requires archive in legacy mode or nativeDiscovery in native mode');
    }
    return this.config.archive.since(LEGACY_ARCHIVE_START_SEQUENCE);
  }

  private logger(): { info(m: string): void; warn(m: string): void } {
    return this.config.logger ?? noopLogger;
  }

  /**
   * Finding E39: `WorkLoopOutcome`s were computed and thrown away every tick, so an operator (or
   * this diagnostic session) debugging "why didn't I claim?" had nothing to read. This is the
   * permanent fix: one structured log line per tick naming every announced card's outcome by card
   * identity + workKind, including the zero-cards case (itself diagnostic -- it pins the refusal
   * to "the archive subscription produced nothing" rather than "the work loop skipped it").
   *
   * Dedupe: log only when the serialized outcome set differs from the last logged one. A steady
   * daemon polling every few seconds against an unchanged archive would otherwise repeat the same
   * line forever; this mirrors `SkipLogDeduper`'s log-on-transition-only pattern already used by
   * the engine-watcher loop (`skip-log-dedup.ts`) rather than inventing a second convention. A
   * bounded-interval re-log (e.g. "at least once a minute even if unchanged") was considered and
   * rejected: a steady-state refusal needs exactly one clear line, not a heartbeat of copies -- an
   * operator can already tell the loop is alive from other loops' liveness signals.
   *
   * #2540 REVERSES that last sentence, because round 8 disproved it. B logged one line at 03:12:06
   * and nothing for 25 minutes while ticking normally the whole time, and the resulting "the
   * solver loop died silently" diagnosis cost a round and produced a fix (#2535) for a defect that
   * did not exist. The dedupe still collapses a steady state to one line per change; it is now
   * bounded by `tickSummaryMaxSilenceMs`, so an unchanged summary is re-emitted at most once a
   * minute and a working loop is never mistakable for a stopped one from its own output.
   */
  private logOutcomes(
    cards: readonly AnnouncedSubmissionCard[],
    results: readonly { card: string; outcome: WorkLoopOutcome }[],
  ): void {
    const summary = results.map((r, i) => ({
      card: r.card,
      workKind: cards[i]?.facts.workKind,
      reason: describeOutcome(r.outcome),
    }));
    const serialized = JSON.stringify(summary);
    const at = this.now();
    const maxSilence = this.config.tickSummaryMaxSilenceMs ?? TICK_SUMMARY_MAX_SILENCE_MS;
    const silent = this.lastLoggedOutcomeAt === undefined ? Number.POSITIVE_INFINITY : at - this.lastLoggedOutcomeAt;
    if (serialized === this.lastLoggedOutcomeSummary && silent < maxSilence) return;
    this.lastLoggedOutcomeSummary = serialized;
    this.lastLoggedOutcomeAt = at;
    const payload = {
      ts: new Date().toISOString(),
      level: 'info',
      component: 'work',
      msg:
        summary.length === 0
          ? 'no announced cards this tick'
          : `${summary.length} announced card(s) this tick`,
      cards: summary,
    };
    this.logger().info(JSON.stringify(payload));
  }

  private async processCard(card: AnnouncedSubmissionCard): Promise<WorkLoopOutcome> {
    // 1. Contract 3 — no new claim until the projector catch-up gate opens.
    await this.config.claimGate.waitUntilOpen();
    if (!this.config.claimGate.isOpen()) {
      return { kind: 'skipped', reason: 'gate-closed' };
    }

    // 2. Facts mapping.
    const mapped = mapAnnouncedSubmissionToFacts(card, {
      estimateAiUnits: this.config.estimateAiUnits,
      acceptLegacyCards: this.config.acceptLegacyCards,
    });
    if (!mapped.ok) {
      return { kind: 'skipped', reason: 'mapping-refused' };
    }
    // E39 diagnose→fix cycle 1 (see `resolveLegacyWorkKind`'s doc comment): substitute the real
    // wiring workKind in for a legacy card's raw manifest-digest placeholder before any
    // downstream gate reads `facts.workKind`.
    const facts =
      mapped.facts.legacyManifestDigest === undefined
        ? mapped.facts
        : {
            ...mapped.facts,
            workKind:
              resolveLegacyWorkKind(
                mapped.facts.legacyManifestDigest,
                this.config.composition.pipelineConfig.wiring,
              ) ?? mapped.facts.workKind,
          };

    // 3. Spend gates against the existing SQLite rolling-window accounting (spec §6.5). The
    // gate's `projectedUsdMicros` reuses the host's single `estimateAiUnits` figure — no separate
    // USD-projection port exists yet in this loop's config.
    const aiUnitsCfg = this.config.aiUnits;
    if (aiUnitsCfg) {
      const now = new Date();
      const block = this.config.store.usdMicrosThisBlock(aiUnitsCfg.credentialId, now);
      const week = this.config.store.usdMicrosThisWeek(aiUnitsCfg.credentialId, now);
      const decision = gateClaimByAiUnits({
        credentialId: aiUnitsCfg.credentialId,
        projectedUsdMicros: facts.intendedAiUnits,
        usdMicrosThisBlock: block.usdMicros,
        usdMicrosThisWeek: week.usdMicros,
        capPerBlockUsdMicros: aiUnitsCfg.capPerBlockUsdMicros,
        capPerWeekUsdMicros: aiUnitsCfg.capPerWeekUsdMicros,
        blockId: blockIdUtc(now),
        logger: this.logger(),
      });
      if (!decision.proceed) {
        return { kind: 'skipped', reason: 'ai-units-capped' };
      }
    }
    const spendCapCfg = this.config.spendCap;
    if (spendCapCfg) {
      const spentTodayUsd = this.config.store.spentTodayMicros(spendCapCfg.credentialId) / 1_000_000;
      const decision = gateClaimBySpendCap({
        credentialId: spendCapCfg.credentialId,
        capUsd: spendCapCfg.capUsd,
        spentTodayUsd,
        logger: this.logger(),
      });
      if (!decision.proceed) {
        return { kind: 'skipped', reason: 'spend-capped' };
      }
    }

    // 4. Resolve wiring. Undefined -> let `runPipeline` return `not-claimed/wiring-missing`
    // (it re-resolves wiring itself); this loop only needs the entry to populate the ledger row.
    const wiring = resolveWiringEntry(facts.workKind, this.config.composition.pipelineConfig.wiring);

    // 5. Contract 2 — admit the claim intent strictly before any broadcast. No wiring means no
    // broadcast is possible either (runPipeline bails at wiring-missing before ever claiming), so
    // there is nothing to admit.
    const chain = this.config.composition.chain;
    const idempotencyKey = idempotencyKeyFor(chain, facts.taskId);
    let admitted = false;
    if (wiring !== undefined) {
      admitted = this.config.ledger.admitClaimIntent({
        idempotencyKey,
        chainId: chain.chainId,
        taskCoordinator: chain.taskCoordinator,
        taskId: facts.taskId,
        workKind: facts.workKind,
        wiring,
      });
      if (!admitted) {
        return { kind: 'skipped', reason: 'already-engaged' };
      }
    }

    // 6. Drive the pipeline, with the deliver leg funneled through the settlement port so the
    // mech Deliver fact exists before settlement reads it.
    const { taskBytes, submissionBytes } = await this.config.readSealedDocuments(card);
    let claimedRequestId: `0x${string}` | undefined;
    const { ports, getDeliveryBytes } = this.buildPorts(
      idempotencyKey,
      admitted,
      facts,
      (requestId) => { claimedRequestId = requestId; },
    );
    const backend = wrapBackendWithWorkLoopCorpus(this.config.composition.backend, {
      store: this.config.store,
      facts,
      getRequestId: () => claimedRequestId,
    });
    recordPhaseDTransitionUse('marketplace-pipeline-invocation');
    const result = await runPipeline(
      { facts, taskBytes, submissionBytes },
      this.config.composition.pipelineConfig,
      backend,
      ports,
    );

    // 8/9. Record the terminal outcome (only when a ledger row was actually admitted).
    await this.recordOutcome(
      idempotencyKey,
      admitted,
      facts,
      result,
      getDeliveryBytes(),
      claimedRequestId,
    );

    return { kind: 'pipeline', result };
  }

  private buildPorts(
    idempotencyKey: string,
    admitted: boolean,
    facts: SubmissionFacts,
    setClaimedRequestId: (requestId: `0x${string}`) => void,
  ): { readonly ports: PipelinePorts; readonly getDeliveryBytes: () => Uint8Array | undefined } {
    const composition = this.config.composition;
    const base = composition.pipelinePorts;
    const chain = composition.chain;

    // Shared per-card mutable capture: `deliveryWait.waitForDelivery` always resolves before
    // `settlement.readMechDeliveryFacts` is invoked (pipeline.ts's own sequencing), so by the
    // time the settlement wrapper runs, this is populated.
    let deliveryBytes: Uint8Array | undefined;

    const ports: PipelinePorts = {
      ...base,
      claim: {
        ...base.claim,
        // Legacy compatibility only (file-header item 2): `runPipeline` itself spreads `taskDigest`/`submission`/`nonce`/
        // `priorityMech` from `facts`/`config.priorityMech` onto `ports.claim` before calling
        // `claimAttempt` — but it does NOT supply `capabilityMatch`, and nothing in venue-base or
        // the composition root constructs one either (`venue.claim` is only
        // `{claimTask, preflight, priorityMech}` cast `as ClaimPorts`). Re-read the real backend
        // snapshot here; no unconditional support answer remains.
        capabilityMatch: async () => {
          const capabilities = await composition.backend.capabilities();
          return capabilities.taskProfiles.includes(facts.profileUri)
            ? { ok: true }
            : { ok: false, reason: 'profile-mismatch' };
        },
        claimTask: async (input) => {
          const receipt = await base.claim.claimTask(input);
          if (receipt.requestId !== undefined) {
            setClaimedRequestId(receipt.requestId);
          }
          const attemptUri = deriveMarketplaceAttemptUri({
            chainId: chain.chainId,
            coordinator: chain.taskCoordinator,
            taskId: input.taskId,
            attemptIndex: receipt.attemptIndex,
          });
          if (admitted) {
            // Finding E35 (ruled, "seal at claim time; the engagement ledger is the home"):
            // `claimAttempt` (packages/marketplace/binding/src/claim.ts) builds this exact
            // dispatch-context document in memory and discards it -- this loop is the AUTHOR of
            // that document (same taskDigest/submission/nonce this claim already carries, same
            // deterministic attemptUri derivation `claimAttempt` uses internally), so it is
            // reconstructed here byte-identically and sealed exactly once: I-JSON, JCS, sha256
            // (TEP §9.1; `docs/superpowers/specs/2026-07-30-stack-design-principles.md` §5
            // "Sealed once, forever"). The sealed bytes + digest are stored on this same ledger
            // row (spec §4: the engagement ledger holds "which wiring entry served a claim" --
            // operator-local claim-time decisions), which Contract 2 already covers as written
            // strictly before broadcast for the row itself. `settlement-grade.ts`'s
            // `checkDispatchBinding` and `composition-root.ts`'s dispatch-context resolver both
            // read this sealed digest back rather than recomputing or fabricating one.
            const dispatchContext: DispatchContext = {
              taskDigest: facts.taskDigest,
              submission: facts.submission,
              nonce: facts.nonce,
              attempt: attemptUri,
            };
            const dispatchContextBytes = serializeCanonicalJson(
              dispatchContext as Parameters<typeof serializeCanonicalJson>[0],
            );
            const dispatchContextDigest = documentDigest(dispatchContextBytes);

            // 7. On claim.ok, observed through the wrapped claimTask port. `receipt.requestId` is
            // present only for today-generation claims (revised-generation claims never mint
            // one) -- carried through so `settlement-grade.ts`'s `checkDispatchBinding` can
            // correlate a today-generation settlement back to this row (C1 / finding E24 gap 2).
            this.config.ledger.recordClaimed(idempotencyKey, {
              attemptIndex: receipt.attemptIndex,
              attemptUri,
              claimTxHash: receipt.txHash,
              requestId: receipt.requestId,
              dispatchContext: { digest: dispatchContextDigest, bytes: dispatchContextBytes },
            });
            // C7 workKind seam (finding E24): note it here, strictly before `backend.submit()` is
            // ever called below -- `attemptUri` is deterministic (same derivation `claimAttempt`
            // uses internally for this same claim), so it is already known. Gated on `admitted`
            // like the ledger write above it — an unadmitted claim never reaches `submit()`
            // either. The composition's own `noteAttemptWorkKind` is a no-op when no legacy-
            // bridge signer was ever supplied to this composition.
            composition.noteAttemptWorkKind(attemptUri, facts.workKind, receipt.requestId);
          }
          return receipt;
        },
      },
      deliveryWait: {
        ...base.deliveryWait,
        waitForDelivery: async (input) => {
          const result = await base.deliveryWait.waitForDelivery(input);
          if (result.ok) deliveryBytes = result.deliveryBytes;
          return result;
        },
      },
      settlement: {
        ...base.settlement,
        readMechDeliveryFacts: async (input) => {
          if (deliveryBytes === undefined) {
            throw new Error(
              'work-loop: readMechDeliveryFacts invoked before deliveryWait resolved',
            );
          }
          // Sequenced BEFORE the base read: the deliver leg (Task 8) must land before settlement
          // reads the mech Deliver fact it produces.
          await deliverToMarketplace(
            { mechAddress: composition.mechAddress, requestId: input.requestId, deliveryBytes },
            composition.deliveryBroadcaster,
          );
          return base.settlement.readMechDeliveryFacts(input);
        },
      },
    };

    return { ports, getDeliveryBytes: () => deliveryBytes };
  }

  private async recordOutcome(
    idempotencyKey: string,
    admitted: boolean,
    facts: SubmissionFacts,
    result: PipelineRunOutcome,
    deliveryBytes: Uint8Array | undefined,
    requestId: `0x${string}` | undefined,
  ): Promise<void> {
    if (!admitted) return;

    if (result.kind === 'delivered') {
      if (deliveryBytes !== undefined) {
        const digest = computeRawCodecCid(deliveryBytes).sha256Digest;
        await this.config.composition.evidence.ports.awaitIndexed({
          family: 'execution-evidence',
          digest,
        });
        if (requestId !== undefined) {
          persistWorkLoopDeliveredCorpus({
            store: this.config.store,
            deliveryBytes,
            requestId,
            facts,
          });
        }
      }
      this.config.ledger.recordOutcome(idempotencyKey, 'settled');
      return;
    }

    if (result.kind === 'race-lost') {
      this.config.ledger.recordOutcome(idempotencyKey, 'race-lost');
      return;
    }

    // 9. Every other non-delivered outcome -> abandoned.
    this.config.ledger.recordOutcome(idempotencyKey, 'abandoned');
    if ('released' in result && result.released === false) {
      this.logger().warn(
        `[work] unreleased attempt for task ${facts.taskId} on ${this.config.composition.chain.taskCoordinator}: `
          + `${result.kind} did not release the venue reservation`,
      );
    }
  }

  async run(): Promise<void> {
    await runLoop({
      name: 'work',
      store: this.config.store,
      tick: () => this.tick().then(() => undefined),
      intervalMs: this.config.pollIntervalMs,
      stopSignal: () => this.stopped,
      emitSource: 'work',
      onError: (err) => {
        this.logger().warn(
          `[work] tick failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    });
  }

  stop(): void {
    this.stopped = true;
  }
}
