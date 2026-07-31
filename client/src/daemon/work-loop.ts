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
 *     supplies `capabilityMatch` — and nothing in venue-base or the composition root constructs
 *     one either (confirmed: `grep capabilityMatch` across both finds only the doc comment
 *     naming it, no implementation). Calling `ports.capabilityMatch()` inside `claimAttempt`
 *     would throw "not a function" without it, so this loop supplies a permissive
 *     `async () => ({ ok: true })` — the operator-policy/backend-capability checks earlier in
 *     `runPipeline` (`evaluateClaimPredicate`, `checkCaps`, `verifyPreclaim`) already gate the
 *     claim; this port has no separate on-chain capability signal to check yet.
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
 * implementation exists anywhere in `client/src`, so `venue.observe`/`lifecycle`/`finality`
 * report "no Attempt" for every ref against live chain traffic today. This loop's own tests use
 * fakes and pass; that does not mean the loop works end-to-end against a live projector yet.
 */
import {
  mapAnnouncedSubmissionToFacts,
  resolveWiringEntry,
  runPipeline,
  type AnnouncedSubmissionCard,
  type PipelinePorts,
  type PipelineRunOutcome,
} from '@jinn-network/marketplace-pipeline';
import { computeRawCodecCid, deriveMarketplaceAttemptUri } from '@jinn-network/marketplace-binding';
import { deliverToMarketplace } from '@jinn-network/marketplace-venue-base';
import type { Store } from '../store/store.js';
import type { EngagementLedger } from './engagement-ledger.js';
import type { ClaimGate } from './claim-gate.js';
import type { OperatorComposition } from './composition-root.js';
import { runLoop } from './loop-heartbeat.js';
import { gateClaimByAiUnits } from './ai-units-gate.js';
import { gateClaimBySpendCap } from './spend-cap-gate.js';
import { blockIdUtc } from '../spend/ai-units.js';

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
  readonly archive: ArchiveSubscription;
  readonly ledger: EngagementLedger;
  readonly claimGate: ClaimGate;
  readonly store: Store;
  readonly estimateAiUnits: (workKind: string) => number;
  /** Fetches the sealed Task/Submission bytes for a card (gap 4, file header). */
  readonly readSealedDocuments: (card: AnnouncedSubmissionCard) => Promise<SealedDocuments>;
  readonly aiUnits?: AiUnitsConfig;
  readonly spendCap?: SpendCapConfig;
  readonly pollIntervalMs: number;
  readonly acceptLegacyCards: boolean;
  readonly logger?: { info(m: string): void; warn(m: string): void };
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
  | { readonly kind: 'pipeline'; readonly result: PipelineRunOutcome };

const noopLogger = { info: (): void => undefined, warn: (): void => undefined };

function idempotencyKeyFor(chain: { chainId: number; taskCoordinator: string }, taskId: bigint): string {
  return `${chain.chainId}:${chain.taskCoordinator}:${taskId.toString()}`;
}

export class WorkLoop {
  private stopped = false;

  constructor(private readonly config: WorkLoopConfig) {}

  /** One pass over new archive cards. Returns per-card outcomes for assertions. */
  async tick(): Promise<readonly { card: string; outcome: WorkLoopOutcome }[]> {
    // Gap 3 (file header): no cursor is derivable from a card, so every tick re-lists from the
    // start; the engagement ledger's own dedupe makes re-processing an already-claimed card safe.
    const cards = await this.config.archive.since('');
    const results: { card: string; outcome: WorkLoopOutcome }[] = [];
    for (const card of cards) {
      results.push({ card: card.chain.submission, outcome: await this.processCard(card) });
    }
    return results;
  }

  private logger(): { info(m: string): void; warn(m: string): void } {
    return this.config.logger ?? noopLogger;
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
    const facts = mapped.facts;

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
    const { ports, getDeliveryBytes } = this.buildPorts(idempotencyKey, admitted);
    const result = await runPipeline(
      { facts, taskBytes, submissionBytes },
      this.config.composition.pipelineConfig,
      this.config.composition.backend,
      ports,
    );

    // 8/9. Record the terminal outcome (only when a ledger row was actually admitted).
    await this.recordOutcome(
      idempotencyKey,
      admitted,
      facts.taskId,
      chain.taskCoordinator,
      result,
      getDeliveryBytes(),
    );

    return { kind: 'pipeline', result };
  }

  private buildPorts(
    idempotencyKey: string,
    admitted: boolean,
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
        // Gap 2 (file header): `runPipeline` itself spreads `taskDigest`/`submission`/`nonce`/
        // `priorityMech` from `facts`/`config.priorityMech` onto `ports.claim` before calling
        // `claimAttempt` — but it does NOT supply `capabilityMatch`, and nothing in venue-base or
        // the composition root constructs one either (`venue.claim` is only
        // `{claimTask, preflight, priorityMech}` cast `as ClaimPorts`). Without this, calling
        // `ports.capabilityMatch()` inside `claimAttempt` throws "not a function".
        capabilityMatch: async () => ({ ok: true }),
        claimTask: async (input) => {
          const receipt = await base.claim.claimTask(input);
          if (admitted) {
            const attemptUri = deriveMarketplaceAttemptUri({
              chainId: chain.chainId,
              coordinator: chain.taskCoordinator,
              taskId: input.taskId,
              attemptIndex: receipt.attemptIndex,
            });
            // 7. On claim.ok, observed through the wrapped claimTask port.
            this.config.ledger.recordClaimed(idempotencyKey, {
              attemptIndex: receipt.attemptIndex,
              attemptUri,
              claimTxHash: receipt.txHash,
            });
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
            composition.venue.safe,
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
    taskId: bigint,
    taskCoordinator: string,
    result: PipelineRunOutcome,
    deliveryBytes: Uint8Array | undefined,
  ): Promise<void> {
    if (!admitted) return;

    if (result.kind === 'delivered') {
      if (deliveryBytes !== undefined) {
        const digest = computeRawCodecCid(deliveryBytes).sha256Digest;
        await this.config.composition.evidence.ports.awaitIndexed({
          family: 'execution-evidence',
          digest,
        });
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
        `[work] unreleased attempt for task ${taskId} on ${taskCoordinator}: `
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
