/**
 * Work-loop corpus persistence (#1393, E47).
 *
 * Stage-1 solution deliveries no longer pass through `TaskEngine.pack()`, so the
 * work loop must mirror pack()'s local corpus side effects: envelope projection
 * and served_artifacts after delivery; corpus-knowledge autoload before harness
 * submit on subsequent runs. Knowledge skip-state lives on activity events, not
 * a retired engine table.
 */
import { computeRawCodecCid } from '@jinn-network/marketplace-binding';
import type { TaskExecutionBackend } from '@jinn-network/task-execution-backend';
import { sha256Hex } from '@jinn-network/task-execution-protocol';
import { canonicalJson } from '../util/canonical-json.js';
import {
  loadCorpusKnowledge,
  type CorpusKnowledgeRecordRef,
} from '../harnesses/engine/corpus-knowledge.js';
import { projectEnvelope } from '../corpus/envelope-projection.js';
import { emitEvent } from '../observability/emit-event.js';
import type { Store } from '../store/store.js';
import { SignedEnvelopeSchema } from '../types/envelope.js';
import {
  isBridgedTepDeliveryBytes,
  legacyRestorationResultFromDelivery,
} from './bridge-legacy-delivery.js';
import type { SubmissionFacts } from './native-submission-facts.js';

function envelopeCidFromSignedEnvelope(envelope: ReturnType<typeof SignedEnvelopeSchema.parse>): string {
  const jcsBytes = new TextEncoder().encode(canonicalJson(envelope));
  return computeRawCodecCid(jcsBytes).cid;
}

/**
 * After a successful work-loop delivery, project the nested legacy envelope into
 * the local corpus index. Never throws — corpus projection failure must not fail
 * settlement.
 */
export function persistWorkLoopDeliveredCorpus(input: {
  readonly store: Store;
  readonly deliveryBytes: Uint8Array;
  readonly requestId: string;
  readonly facts: SubmissionFacts;
}): void {
  if (!isBridgedTepDeliveryBytes(input.deliveryBytes)) return;

  const nestedJson = legacyRestorationResultFromDelivery(input.deliveryBytes);
  if (nestedJson === undefined) return;

  let envelope: ReturnType<typeof SignedEnvelopeSchema.parse>;
  try {
    envelope = SignedEnvelopeSchema.parse(JSON.parse(nestedJson));
  } catch (err) {
    console.warn(
      `[work] envelope parse failed for corpus projection (non-fatal, requestId=${input.requestId}): `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const envelopeCid = envelopeCidFromSignedEnvelope(envelope);

  try {
    input.store.saveEnvelopeProjection({
      ...projectEnvelope(envelope, { envelopeCid }),
      evidenceTier: 'self-signed',
    });
  } catch (err) {
    console.warn(
      `[work] envelope projection failed (non-fatal, requestId=${input.requestId}): `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (envelope.solverType === 'prediction.v1' && envelope.payload != null) {
    try {
      const content = Buffer.from(JSON.stringify(envelope.payload));
      const hash = sha256Hex(content);
      const now = new Date().toISOString();
      input.store.saveServedArtifact({
        sha256: hash,
        artifactType: 'prediction_v1_solution',
        requestId: input.requestId,
        content,
        priceUsdc: '0',
        createdAt: now,
      });
      input.store.setServedArtifactEnvelopeCid(hash, envelopeCid);
    } catch (err) {
      console.warn(
        `[work] solution artifact persist failed (non-fatal, requestId=${input.requestId}): `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function alreadyLoadedCorpusKnowledge(store: Store, requestId: string): boolean {
  return store.db.prepare(
    `SELECT 1 AS ok FROM activity_events WHERE request_id = ? AND kind = 'corpus_knowledge' LIMIT 1`,
  ).get(requestId) !== undefined;
}

async function injectCorpusKnowledgeBeforeSubmit(input: {
  readonly store: Store;
  readonly requestId: string;
  readonly solverType: string;
}): Promise<void> {
  if (alreadyLoadedCorpusKnowledge(input.store, input.requestId)) return;

  const knowledgePayload = await loadCorpusKnowledge({
    corpus: null,
    store: input.store,
    solverType: input.solverType,
  });
  if (!knowledgePayload) return;

  emitEvent(input.store, {
    kind: 'corpus_knowledge',
    requestId: input.requestId,
    solverType: input.solverType,
    outcome: 'ok',
    detail: JSON.stringify(knowledgePayload.records.map((record: CorpusKnowledgeRecordRef) => ({
      envelopeCid: record.envelopeCid,
      artifacts: record.artifacts.map((artifact) => artifact.sha256),
    }))),
  }, 'work');
}

/**
 * Wraps the composition backend so the first `submit()` for a today-generation
 * claim loads corpus knowledge (#1393). Skip-state is the corpus_knowledge
 * activity event for this request.
 */
export function wrapBackendWithWorkLoopCorpus(
  backend: TaskExecutionBackend,
  input: {
    readonly store: Store;
    readonly facts: SubmissionFacts;
    readonly getRequestId: () => `0x${string}` | undefined;
  },
): TaskExecutionBackend {
  return new Proxy(backend, {
    get(target, prop, receiver) {
      if (prop === 'submit') {
        return async (
          taskBytes: Uint8Array,
          submissionBytes: Uint8Array,
          engagement?: Parameters<TaskExecutionBackend['submit']>[2],
        ) => {
          const requestId = input.getRequestId();
          if (requestId !== undefined) {
            await injectCorpusKnowledgeBeforeSubmit({
              store: input.store,
              requestId,
              solverType: input.facts.workKind,
            });
          }
          return target.submit(taskBytes, submissionBytes, engagement);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    },
  });
}

/** Parse a bridged delivery's nested envelope when present. Exported for tests. */
export function parseBridgedDeliveryEnvelope(
  deliveryBytes: Uint8Array,
): ReturnType<typeof SignedEnvelopeSchema.parse> | undefined {
  if (!isBridgedTepDeliveryBytes(deliveryBytes)) return undefined;
  const nestedJson = legacyRestorationResultFromDelivery(deliveryBytes);
  if (nestedJson === undefined) return undefined;
  return SignedEnvelopeSchema.parse(JSON.parse(nestedJson));
}
