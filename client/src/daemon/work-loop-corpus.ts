/**
 * Work-loop corpus persistence (#1393, E47).
 *
 * Stage-1 solution deliveries no longer pass through `TaskEngine.pack()`, so the
 * work loop must mirror pack()'s local corpus side effects: envelope projection,
 * served_artifacts, and task_runs.manifestCid after delivery; corpus-knowledge
 * autoload before harness submit on subsequent runs.
 */
import { computeRawCodecCid } from '@jinn-network/marketplace-binding';
import type { TaskExecutionBackend } from '@jinn-network/task-execution-backend';
import { sha256Hex } from '@jinn-network/task-execution-protocol';
import { canonicalJson } from '../harnesses/engine/canonical-json.js';
import {
  loadCorpusKnowledge,
  type CorpusKnowledgeRecordRef,
} from '../harnesses/engine/corpus-knowledge.js';
import { TaskRunPersistence } from '../harnesses/engine/persistence.js';
import { projectEnvelope } from '../corpus/envelope-projection.js';
import { emitEvent } from '../observability/emit-event.js';
import type { Store } from '../store/store.js';
import { SignedEnvelopeSchema } from '../types/envelope.js';
import type { Task } from '../types/task.js';
import {
  isBridgedTepDeliveryBytes,
  legacyRestorationResultFromDelivery,
} from './bridge-legacy-delivery.js';
import type { SubmissionFacts } from './native-submission-facts.js';

function envelopeCidFromSignedEnvelope(envelope: ReturnType<typeof SignedEnvelopeSchema.parse>): string {
  const jcsBytes = new TextEncoder().encode(canonicalJson(envelope));
  return computeRawCodecCid(jcsBytes).cid;
}

function minimalTaskForWorkLoop(facts: SubmissionFacts): Task {
  return {
    id: facts.taskId.toString(),
    solverType: facts.workKind,
    role: 'restoration',
    description: `work-loop ${facts.workKind}`,
    window: {
      startTs: Date.now() - 60_000,
      endTs: Date.now() + 3_600_000,
    },
  };
}

function ensureWorkLoopTaskRunRow(
  persistence: TaskRunPersistence,
  requestId: string,
  facts: SubmissionFacts,
): void {
  if (persistence.getByRequestId(requestId) !== null) return;
  persistence.insertDiscovered({
    requestId,
    taskId: facts.taskId.toString(),
    taskCid: facts.taskDigest,
    onchainCreationTx: '0x',
    onchainCreationBlock: 0,
    solverType: facts.workKind,
    taskRole: 'restoration',
    windowStartTs: Date.now() - 60_000,
    windowEndTs: Date.now() + 3_600_000,
    task: minimalTaskForWorkLoop(facts),
  });
}

/**
 * After a successful work-loop delivery, project the nested legacy envelope into
 * the local corpus index and persist manifestCid on the solution requestId row.
 * Never throws — corpus projection failure must not fail settlement.
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
  const persistence = new TaskRunPersistence(input.store.db);
  ensureWorkLoopTaskRunRow(persistence, input.requestId, input.facts);

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

  persistence.setManifestCid(input.requestId, envelopeCid);

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

async function injectCorpusKnowledgeBeforeSubmit(input: {
  readonly store: Store;
  readonly requestId: string;
  readonly solverType: string;
}): Promise<void> {
  const persistence = new TaskRunPersistence(input.store.db);
  const existing = persistence.getByRequestId(input.requestId);
  if (existing?.consumedRefsJson !== null && existing?.consumedRefsJson !== undefined) {
    return;
  }

  const knowledgePayload = await loadCorpusKnowledge({
    corpus: null,
    store: input.store,
    solverType: input.solverType,
  });
  if (!knowledgePayload) {
    persistence.setConsumedRefsJson(input.requestId, null);
    return;
  }

  const consumedRefsJson = JSON.stringify(knowledgePayload.records);
  persistence.setConsumedRefsJson(input.requestId, consumedRefsJson);
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
 * claim loads corpus knowledge into the persisted task_runs row (#1393).
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
            const persistence = new TaskRunPersistence(input.store.db);
            ensureWorkLoopTaskRunRow(persistence, requestId, input.facts);
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
