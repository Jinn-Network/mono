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
  type ExecutionWiringEntry,
  type PipelinePorts,
  type PipelineRunOutcome,
  type SubmissionFacts,
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
import { runLoop } from './loop-heartbeat.js';
import { gateClaimByAiUnits } from './ai-units-gate.js';
import { gateClaimBySpendCap } from './spend-cap-gate.js';
import { blockIdUtc } from '../spend/ai-units.js';
import {
  persistWorkLoopDeliveredCorpus,
  wrapBackendWithWorkLoopCorpus,
} from './work-loop-corpus.js';

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
  /** Last tick's serialized per-card outcome summary, for the log-on-change dedupe (E39). */
  private lastLoggedOutcomeSummary: string | undefined;

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
    this.logOutcomes(cards, results);
    return results;
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
    if (serialized === this.lastLoggedOutcomeSummary) return;
    this.lastLoggedOutcomeSummary = serialized;
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
        // Gap 2 (file header): `runPipeline` itself spreads `taskDigest`/`submission`/`nonce`/
        // `priorityMech` from `facts`/`config.priorityMech` onto `ports.claim` before calling
        // `claimAttempt` — but it does NOT supply `capabilityMatch`, and nothing in venue-base or
        // the composition root constructs one either (`venue.claim` is only
        // `{claimTask, preflight, priorityMech}` cast `as ClaimPorts`). Without this, calling
        // `ports.capabilityMatch()` inside `claimAttempt` throws "not a function".
        capabilityMatch: async () => ({ ok: true }),
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
