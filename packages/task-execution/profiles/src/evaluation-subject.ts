// SPDX-License-Identifier: Apache-2.0

import {
  DeliveryRecordSchema,
  TaskSpecificationSchema,
  documentDigest,
  sealDelivery,
  sealTask,
  type DeliveryRecord,
  type TaskSpecification,
} from "@jinn-network/task-execution-protocol";

import { bytesEqual, decodeUtf8 } from "./bytes.js";
import { ProfilesError } from "./errors.js";

export interface EvaluationSubjectResultMaterial {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface VerifyEvaluationSubjectInput {
  readonly taskBytes: Uint8Array;
  readonly deliveryBytes: Uint8Array;
  readonly results: readonly EvaluationSubjectResultMaterial[];
}

export interface VerifiedEvaluationMaterial {
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
}

export interface VerifiedEvaluationResult extends VerifiedEvaluationMaterial {
  readonly name: string;
  readonly mediaType: string;
}

export interface VerifiedEvaluationSpecification {
  readonly name: string;
  readonly digest: `sha256:${string}`;
  readonly uri?: string;
  readonly mediaType?: string;
}

/**
 * The minimal protocol view needed by an evaluator after exact-subject admission. It deliberately
 * exposes no Attempt, Submission, settlement, or marketplace selection state (program §7.56).
 */
export interface VerifiedEvaluationSubject {
  readonly task: VerifiedEvaluationMaterial;
  readonly delivery: VerifiedEvaluationMaterial;
  readonly results: readonly VerifiedEvaluationResult[];
  readonly evaluationSpecification: VerifiedEvaluationSpecification;
}

function invalid(message: string, cause?: unknown): never {
  throw new ProfilesError("invalid-document", message, { cause });
}

function schemaDetail(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  return issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  const text = decodeUtf8(bytes);
  try {
    return JSON.parse(text);
  } catch (cause) {
    invalid(`${label} bytes are not valid JSON.`, cause);
  }
}

function exactTask(bytes: Uint8Array): TaskSpecification {
  const parsed = TaskSpecificationSchema.safeParse(parseJson(bytes, "subject Task"));
  if (!parsed.success) {
    invalid(
      `subject Task failed protocol schema validation: ${
        schemaDetail(parsed.error.issues)
      }`,
    );
  }
  let canonical: Uint8Array;
  try {
    canonical = sealTask(parsed.data);
  } catch (cause) {
    invalid("subject Task cannot be sealed by the protocol sealer.", cause);
  }
  if (!bytesEqual(canonical, bytes)) {
    invalid("subject Task bytes are not the exact canonical protocol bytes.");
  }
  return parsed.data;
}

function exactDelivery(bytes: Uint8Array): DeliveryRecord {
  const parsed = DeliveryRecordSchema.safeParse(
    parseJson(bytes, "subject Delivery"),
  );
  if (!parsed.success) {
    invalid(
      `subject Delivery failed protocol schema validation: ${
        schemaDetail(parsed.error.issues)
      }`,
    );
  }
  let canonical: Uint8Array;
  try {
    canonical = sealDelivery(parsed.data);
  } catch (cause) {
    invalid("subject Delivery cannot be sealed by the protocol sealer.", cause);
  }
  if (!bytesEqual(canonical, bytes)) {
    invalid("subject Delivery bytes are not the exact canonical protocol bytes.");
  }
  return parsed.data;
}

function uniqueByName<T extends { readonly name: string }>(
  values: readonly T[],
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.name)) {
      invalid(`${label} names must be unique; repeated ${value.name}.`);
    }
    result.set(value.name, value);
  }
  return result;
}

function nonemptyOptional(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) invalid(`${label} must be non-empty when present.`);
  return value;
}

function evaluationSpecification(
  task: TaskSpecification,
): VerifiedEvaluationSpecification {
  const descriptor = task.evaluation;
  const sha256 = descriptor?.digest?.["sha256"];
  if (
    descriptor === undefined
    || typeof sha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(sha256)
  ) {
    invalid(
      "subject Task must declare the exact EvaluationSpec with a lowercase sha256 digest.",
    );
  }
  const name = descriptor.name ?? "evaluation-spec.json";
  if (name.length === 0) {
    invalid("subject Task EvaluationSpec descriptor name must be non-empty.");
  }
  const uri = nonemptyOptional(
    descriptor.uri,
    "subject Task EvaluationSpec descriptor uri",
  );
  const mediaType = nonemptyOptional(
    descriptor.mediaType,
    "subject Task EvaluationSpec descriptor mediaType",
  );
  return {
    name,
    digest: `sha256:${sha256}`,
    ...(uri === undefined ? {} : { uri }),
    ...(mediaType === undefined ? {} : { mediaType }),
  };
}

/**
 * Verifies the exact Task/Delivery/Result subject before any evaluation derivation, adapter
 * execution, or signing. Protocol schemas and sealers remain the sole Task/Delivery authority;
 * profiles owns only this evaluation-specific join (program §7.56).
 */
export function verifyEvaluationSubject(
  input: VerifyEvaluationSubjectInput,
): VerifiedEvaluationSubject {
  const task = exactTask(input.taskBytes);
  const delivery = exactDelivery(input.deliveryBytes);
  const taskDigest = documentDigest(input.taskBytes);
  if (delivery.task !== taskDigest) {
    invalid("subject Delivery is bound to a different exact Task.");
  }

  const taskOutputs = uniqueByName(task.outputs, "subject Task output");
  const deliveryOutputs = uniqueByName(
    delivery.outputs,
    "subject Delivery output",
  );
  const resultMaterials = uniqueByName(
    input.results,
    "supplied Result material",
  );
  if (
    delivery.outputs.length !== input.results.length
    || deliveryOutputs.size !== resultMaterials.size
  ) {
    invalid(
      "subject Delivery output cardinality does not match the supplied Results.",
    );
  }

  const verifiedResults = new Map<string, VerifiedEvaluationResult>();
  for (const output of delivery.outputs) {
    const declaration = taskOutputs.get(output.name);
    if (declaration === undefined) {
      invalid(`subject Delivery output ${output.name} is not declared by the Task.`);
    }
    if (
      output.mediaType === undefined
      || output.mediaType !== declaration.mediaType
    ) {
      invalid(
        `subject Delivery output ${output.name} media type does not match the Task declaration.`,
      );
    }
    const declaredDigest = output.digest?.["sha256"];
    if (
      typeof declaredDigest !== "string"
      || !/^[0-9a-f]{64}$/u.test(declaredDigest)
    ) {
      invalid(
        `subject Delivery output ${output.name} must carry an exact lowercase sha256 digest.`,
      );
    }
    const material = resultMaterials.get(output.name);
    if (material === undefined) {
      invalid(
        `subject Delivery output ${output.name} has no exact supplied Result.`,
      );
    }
    const observedDigest = documentDigest(material.bytes);
    if (observedDigest !== `sha256:${declaredDigest}`) {
      invalid(
        `supplied Result ${output.name} does not match the subject Delivery digest.`,
      );
    }
    verifiedResults.set(output.name, {
      name: output.name,
      mediaType: output.mediaType,
      bytes: material.bytes,
      digest: observedDigest,
    });
  }
  const results = input.results.map((material) =>
    verifiedResults.get(material.name)!
  );

  return {
    task: { bytes: input.taskBytes, digest: taskDigest },
    delivery: {
      bytes: input.deliveryBytes,
      digest: documentDigest(input.deliveryBytes),
    },
    results,
    evaluationSpecification: evaluationSpecification(task),
  };
}
