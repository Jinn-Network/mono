import { createHash } from 'node:crypto';
import {
  DeliveryRecordSchema,
  TaskSpecificationSchema,
} from '@jinn-network/task-execution-protocol';
import type { EvaluationOpportunity } from './opportunities.js';

export interface FetchBytesByDigest {
  byCid(cid: string): Promise<Uint8Array>;
  byDigest(digest: `sha256:${string}`): Promise<Uint8Array>;
}

export interface SubjectMaterial {
  readonly task: { readonly name: string; readonly digest: `sha256:${string}`; readonly bytes: Uint8Array };
  readonly delivery: { readonly name: string; readonly digest: `sha256:${string}`; readonly bytes: Uint8Array };
  readonly results: readonly { readonly name: string; readonly digest: `sha256:${string}`; readonly bytes: Uint8Array }[];
  readonly evaluationSpec: { readonly digest: `sha256:${string}`; readonly bytes: Uint8Array };
}

export class SubjectMaterialError extends Error {
  readonly kind: 'unavailable' | 'digest-mismatch' | 'no-evaluation-spec';

  constructor(kind: SubjectMaterialError['kind'], message?: string) {
    super(message ?? kind);
    this.name = 'SubjectMaterialError';
    this.kind = kind;
  }
}

function sha256Digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function requireDigest(bytes: Uint8Array, expected: `sha256:${string}`): void {
  const actual = sha256Digest(bytes);
  if (actual !== expected) {
    throw new SubjectMaterialError('digest-mismatch', `expected ${expected}, got ${actual}`);
  }
}

function descriptorSha256Digest(descriptor: { digest?: Record<string, string> | undefined }): `sha256:${string}` | undefined {
  const hex = descriptor.digest?.sha256;
  return typeof hex === 'string' ? `sha256:${hex}` : undefined;
}

async function fetchByDigest(
  fetcher: FetchBytesByDigest,
  digest: `sha256:${string}`,
): Promise<Uint8Array> {
  try {
    return await fetcher.byDigest(digest);
  } catch {
    throw new SubjectMaterialError('unavailable', `failed to fetch ${digest}`);
  }
}

export async function acquireSubjectMaterial(
  opportunity: EvaluationOpportunity,
  fetcher: FetchBytesByDigest,
): Promise<SubjectMaterial> {
  let deliveryBytes: Uint8Array;
  try {
    deliveryBytes = await fetcher.byCid(opportunity.deliveryCid);
  } catch {
    throw new SubjectMaterialError('unavailable', 'failed to fetch delivery by CID');
  }

  let deliveryJson: unknown;
  try {
    deliveryJson = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(deliveryBytes));
  } catch {
    throw new SubjectMaterialError('unavailable', 'delivery bytes are not valid UTF-8 JSON');
  }

  const deliveryParsed = DeliveryRecordSchema.safeParse(deliveryJson);
  if (!deliveryParsed.success) {
    throw new SubjectMaterialError('unavailable', 'delivery failed schema validation');
  }
  const delivery = deliveryParsed.data;
  const deliveryDigest = sha256Digest(deliveryBytes);
  requireDigest(deliveryBytes, deliveryDigest);

  const taskDigest = delivery.task;
  const taskBytes = await fetchByDigest(fetcher, taskDigest);
  requireDigest(taskBytes, taskDigest);

  let taskJson: unknown;
  try {
    taskJson = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(taskBytes));
  } catch {
    throw new SubjectMaterialError('unavailable', 'task bytes are not valid UTF-8 JSON');
  }

  const taskParsed = TaskSpecificationSchema.safeParse(taskJson);
  if (!taskParsed.success) {
    throw new SubjectMaterialError('unavailable', 'task failed schema validation');
  }
  const task = taskParsed.data;

  const evaluationSpecDigest = descriptorSha256Digest(task.evaluation ?? {});
  if (evaluationSpecDigest === undefined) {
    throw new SubjectMaterialError('no-evaluation-spec');
  }

  const evaluationSpecBytes = await fetchByDigest(fetcher, evaluationSpecDigest);
  requireDigest(evaluationSpecBytes, evaluationSpecDigest);

  const results: SubjectMaterial['results'] = [];
  for (const output of delivery.outputs) {
    const resultDigest = descriptorSha256Digest(output);
    if (resultDigest === undefined) {
      throw new SubjectMaterialError('unavailable', `output "${output.name}" has no digest`);
    }
    const resultBytes = await fetchByDigest(fetcher, resultDigest);
    requireDigest(resultBytes, resultDigest);
    results.push({
      name: output.name,
      digest: resultDigest,
      bytes: resultBytes,
    });
  }

  return {
    task: { name: 'task', digest: taskDigest, bytes: taskBytes },
    delivery: { name: 'delivery', digest: deliveryDigest, bytes: deliveryBytes },
    results,
    evaluationSpec: { digest: evaluationSpecDigest, bytes: evaluationSpecBytes },
  };
}
