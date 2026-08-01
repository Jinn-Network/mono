/**
 * The evaluator loop (cutover stage 2, Task 13): closes the observe-to-settle path for
 * evaluation-profile Attempts on the embedded backend. Each opportunity drives the eleven-step
 * sequence (opportunity → material → bridge subject → dispatch → pin → intent → claim → execute →
 * deliver → settle → emit) without skipping a leg.
 */
import {
  decodeRawCodecCidDigestHex,
  deriveMarketplaceAttemptUri,
  keccakEvidenceHash,
  uploadRawCodecCid,
  type PostingIntent,
  type PostingIntentStore,
} from '@jinn-network/marketplace-binding';
import type { VerdictPorts } from '@jinn-network/marketplace-venue-base';
import type { ExecutionWiringEntry } from '@jinn-network/marketplace-pipeline';
import type { TaskExecutionBackend } from '@jinn-network/task-execution-backend';
import { parseEvaluationSpec } from '@jinn-network/task-execution-profiles';
import {
  type DispatchContext,
  type SubmissionRecord,
} from '@jinn-network/task-execution-protocol';
import type { DsseSigner } from '@jinn-network/trust-core';
import type { Store } from '../store/store.js';
import { emitEvent } from '../observability/emit-event.js';
import { runLoop } from './loop-heartbeat.js';
import { synthesizeBridgeSubject } from '../evaluator/bridge-subject.js';
import {
  admitVerdictIntent,
  verdictIdempotencyKey,
  type VerdictIntentLedger,
} from '../evaluator/intents.js';
import {
  createOpportunitySource,
  type EvaluationOpportunity,
} from '../evaluator/opportunities.js';
import {
  evaluationCarveOutRefusal,
  buildEvaluationDispatch,
  type CarveOutRefusal,
} from '../evaluator/submission.js';
import { settleVerdict } from '../evaluator/settle.js';
import {
  acquireSubjectMaterial,
  type FetchBytesByDigest,
  SubjectMaterialError,
} from '../evaluator/subject-material.js';

export type EvaluatorSkipReason =
  | CarveOutRefusal['kind']
  | 'subject-unavailable'
  | 'intent-not-admitted'
  | 'cannot-open-verdict';

export interface EvaluatorLoopConfig {
  readonly chain: {
    readonly chainId: number;
    readonly taskCoordinator: `0x${string}`;
  };
  readonly venue: { readonly verdict: VerdictPorts };
  readonly backend: TaskExecutionBackend;
  readonly opportunities: ReturnType<typeof createOpportunitySource>;
  readonly fetcher: FetchBytesByDigest;
  readonly ledger: VerdictIntentLedger;
  readonly intents: PostingIntentStore;
  readonly creatorSafe: `0x${string}`;
  readonly pin: { pin(bytes: Uint8Array): Promise<void> };
  readonly store: Store;
  readonly bridgeSigner: DsseSigner;
  readonly admissionAgentIri: string;
  readonly requesterAgentIri: string;
  readonly evaluatorAgentIri: string;
  readonly wiring: ExecutionWiringEntry;
  readonly evaluationDeadline: string;
  readonly pollIntervalMs: number;
  readonly maxConcurrent?: number;
  readonly onSkip?: (
    reason: EvaluatorSkipReason,
    opportunity: EvaluationOpportunity,
    detail?: string,
  ) => void;
  readonly logger?: { info(m: string): void; warn(m: string): void };
}

const noopLogger = { info: (): void => undefined, warn: (): void => undefined };

function extractStatementVerdict(deliveryBytes: Uint8Array): unknown {
  const delivery = JSON.parse(new TextDecoder().decode(deliveryBytes)) as {
    outputs?: readonly { name: string; content?: string }[];
  };
  const verdictOutput = delivery.outputs?.find((output) => output.name === 'verdict');
  if (verdictOutput?.content === undefined) {
    throw new Error('delivery verdict output missing inline content');
  }
  const envelopeBytes = Buffer.from(verdictOutput.content, 'base64');
  const envelope = JSON.parse(new TextDecoder().decode(envelopeBytes)) as { payload?: string };
  if (envelope.payload === undefined) {
    throw new Error('verdict DSSE envelope missing payload');
  }
  const statement = JSON.parse(
    new TextDecoder().decode(Buffer.from(envelope.payload, 'base64')),
  ) as { predicate?: { verdict?: unknown } };
  if (statement.predicate?.verdict === undefined) {
    throw new Error('Result Evaluation Statement missing predicate.verdict');
  }
  return statement.predicate.verdict;
}

export class EvaluatorLoop {
  private stopped = false;
  private draining = false;
  private inFlight = 0;
  private readonly drainWaiters: Array<() => void> = [];
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly config: EvaluatorLoopConfig) {}

  async run(): Promise<void> {
    this.unsubscribe = this.config.opportunities.subscribe((opportunity) => {
      void this.enqueue(opportunity);
    });
    try {
      await runLoop({
        name: 'evaluator',
        store: this.config.store,
        tick: async () => undefined,
        intervalMs: this.config.pollIntervalMs,
        stopSignal: () => this.stopped,
        emitSource: 'evaluator',
        onError: (err) => {
          this.logger().warn(
            `[evaluator] tick failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      });
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** Drain: stop accepting opportunities, finish in-flight evaluations. */
  drain(): Promise<void> {
    this.draining = true;
    return new Promise((resolve) => {
      const finish = (): void => {
        if (this.inFlight === 0) resolve();
        else this.drainWaiters.push(resolve);
      };
      queueMicrotask(finish);
    });
  }

  private logger(): { info(m: string): void; warn(m: string): void } {
    return this.config.logger ?? noopLogger;
  }

  private resolveDrainIfIdle(): void {
    if (!this.draining || this.inFlight > 0) return;
    while (this.drainWaiters.length > 0) {
      this.drainWaiters.shift()?.();
    }
  }

  private skip(
    reason: EvaluatorSkipReason,
    opportunity: EvaluationOpportunity,
    detail?: string,
  ): void {
    this.config.onSkip?.(reason, opportunity, detail);
    this.logger().info(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      component: 'evaluator',
      msg: 'evaluation skipped',
      reason,
      detail: detail ?? null,
      taskId: opportunity.taskId.toString(),
      attemptIndex: opportunity.attemptIndex,
    }));
  }

  private async enqueue(opportunity: EvaluationOpportunity): Promise<void> {
    if (this.stopped || this.draining) return;
    const maxConcurrent = this.config.maxConcurrent ?? 1;
    if (this.inFlight >= maxConcurrent) return;

    this.inFlight++;
    try {
      await this.processOpportunity(opportunity);
    } catch (err) {
      this.logger().warn(
        `[evaluator] unreleased attempt for task ${opportunity.taskId} attempt ${opportunity.attemptIndex}: `
          + `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight--;
      this.resolveDrainIfIdle();
    }
  }

  private async processOpportunity(opportunity: EvaluationOpportunity): Promise<void> {
    // 2. Acquire subject material; carve-out refusal on the parsed spec.
    let material;
    try {
      material = await acquireSubjectMaterial(opportunity, this.config.fetcher);
    } catch (err) {
      if (err instanceof SubjectMaterialError) {
        this.skip('subject-unavailable', opportunity, err.message);
        return;
      }
      throw err;
    }

    const spec = parseEvaluationSpec(material.evaluationSpec.bytes);
    const refusal = evaluationCarveOutRefusal(spec);
    if (refusal !== undefined) {
      this.skip(refusal.kind, opportunity, refusal.detail);
      return;
    }

    // 3. Synthesize the bridge subject.
    const subject = await synthesizeBridgeSubject({
      subjectTaskDigest: material.task.digest,
      evaluationSpecDigest: material.evaluationSpec.digest,
      requesterAgentIri: this.config.requesterAgentIri,
      admissionAgentIri: this.config.admissionAgentIri,
      legacyAnchor: {
        chainId: opportunity.chainId,
        taskId: opportunity.taskId,
        blockHash: opportunity.blockHash,
      },
      now: new Date().toISOString(),
      signer: this.config.bridgeSigner,
    });

    // 4. Build the evaluation dispatch.
    const dispatch = buildEvaluationDispatch({
      material,
      subject,
      evaluatorAgentIri: this.config.evaluatorAgentIri,
      deadline: this.config.evaluationDeadline,
    });

    // 5. Pin the sealed evaluation Task bytes.
    const taskCid = await uploadRawCodecCid(dispatch.task.bytes, this.config.pin);
    const evaluationTaskCidDigest = `0x${decodeRawCodecCidDigestHex(taskCid.cid)}` as `0x${string}`;

    // 6. Admit the verdict intent ledger-first.
    const idempotencyKey = verdictIdempotencyKey({
      chainId: this.config.chain.chainId,
      taskId: opportunity.taskId,
      attemptIndex: opportunity.attemptIndex,
      evaluationTaskDigest: dispatch.task.digest,
    });
    const submissionDocument = dispatch.submission.document as SubmissionRecord;
    const postingIntent: PostingIntent = {
      creatorSafe: this.config.creatorSafe,
      taskCidDigest: dispatch.task.digest,
      submissionDigest: dispatch.submission.digest,
      idempotencyKey: `evaluation-post:${dispatch.submission.digest}`,
      createdAt: new Date().toISOString(),
    };
    const admitted = await admitVerdictIntent(
      {
        ledger: this.config.ledger,
        intents: this.config.intents,
        postingIntent,
      },
      {
        idempotencyKey,
        taskId: opportunity.taskId,
        attemptIndex: opportunity.attemptIndex,
        evaluationTaskDigest: dispatch.task.digest,
        wiringEntryId: this.config.wiring.workKind,
      },
    );
    if (!admitted.admitted) {
      this.skip('intent-not-admitted', opportunity);
      return;
    }

    // 7. Open the verdict attempt on-chain.
    const canOpen = await this.config.venue.verdict.canOpenVerdictAttempt({
      taskId: opportunity.taskId,
      attemptIndex: opportunity.attemptIndex,
    });
    if (!canOpen.ok) {
      this.skip('cannot-open-verdict', opportunity, canOpen.reason);
      return;
    }

    const opened = await this.config.venue.verdict.openVerdictAttempt({
      taskId: opportunity.taskId,
      attemptIndex: opportunity.attemptIndex,
      evaluationTaskCidDigest,
    });

    // 8. Submit to the embedded backend under a deterministic Attempt URI.
    const attemptUri = deriveMarketplaceAttemptUri({
      chainId: this.config.chain.chainId,
      coordinator: this.config.chain.taskCoordinator,
      taskId: opportunity.taskId,
      attemptIndex: opened.verdictIndex,
    });
    const dispatchContext: DispatchContext = {
      taskDigest: dispatch.task.digest,
      submission: submissionDocument.submission,
      nonce: submissionDocument.nonce,
      attempt: attemptUri,
    };
    const ack = await this.config.backend.submit(
      dispatch.task.bytes,
      dispatch.submission.bytes,
      { attemptUri, dispatchContext },
    );
    if (!ack.accepted) {
      throw new Error(
        `backend rejected evaluation submit: ${ack.error?.message ?? 'unknown'}`,
      );
    }

    // 9. Await the backend's sealed Delivery.
    let deliveryBytes: Uint8Array | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const refs = await this.config.backend.deliveries(attemptUri);
      if (refs.length > 0) {
        deliveryBytes = await this.config.backend.fetchDelivery(refs[0]!);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (deliveryBytes === undefined) {
      throw new Error(`delivery never appeared for ${attemptUri}`);
    }

    // 10. Settle: pin, deliver through the mech, claim with envelope-authoritative code.
    const statementVerdict = extractStatementVerdict(deliveryBytes);
    await settleVerdict({
      requestId: opened.requestId,
      sealedDeliveryBytes: deliveryBytes,
      statementVerdict,
      pin: this.config.pin,
      verdict: this.config.venue.verdict,
      keccakEvidenceHash: keccakEvidenceHash(deliveryBytes),
    });

    // 11. Emit evaluation_submitted.
    emitEvent(this.config.store, {
      kind: 'evaluation_submitted',
      requestId: opened.requestId,
      outcome: 'ok',
    }, 'evaluator');
  }
}
