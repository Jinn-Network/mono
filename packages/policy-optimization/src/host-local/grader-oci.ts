// SPDX-License-Identifier: MIT

import {
  ResultEvaluationStatementSchema,
  type ResultEvaluationStatement,
} from "@jinn-network/evidence-protocol";
import { canonicalAttestationJsonBytes } from "@jinn-network/attestation-issuer";
import {
  createEvaluatorDeployment,
  type EvaluatorDeploymentOptions,
} from "@jinn-network/task-execution-evaluator-adapters";
import {
  DSSE_PAYLOAD_TYPE,
  parseExactDsseEnvelope,
  sealSignedPayload,
  type DsseSigner,
  type SealedRecord,
} from "@jinn-network/trust-core";
import { HostStateError } from "./state.js";

// The optimizer owns binding verification and evaluator signing. OCI process construction and
// execution are the neutral shared capability, not a product-local fork.
export {
  buildPinnedOciInvocation,
  ensurePinnedOciImage,
  runPinnedOciGrader,
  type HostNumericIdentity,
  type PinnedOciGraderInput,
  type PinnedOciInvocation,
  type PinnedOciRunnerOptions,
} from "@jinn-network/task-execution-oci-grader";

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function descriptorKey(descriptor: { name: string; digest: { sha256: string } }): string {
  return `${descriptor.name}\0${descriptor.digest.sha256}`;
}

export interface ExpectedEvaluationBindings {
  readonly task: { readonly name: string; readonly digest: { readonly sha256: string } };
  readonly results: readonly { readonly name: string; readonly digest: { readonly sha256: string } }[];
  readonly evaluatorId: string;
  readonly evaluatorSigningKeyId: string;
  readonly evaluationSpecification: { readonly name: string; readonly digest: { readonly sha256: string } };
  readonly evaluationMethod: { readonly name: string; readonly digest: { readonly sha256: string } };
}

/** Exact-parse every sandbox binding, then and only then invoke the evaluator-role signer. */
export async function validateAndSignEvaluatorStatement(input: {
  readonly statementBytes: Uint8Array;
  readonly expected: ExpectedEvaluationBindings;
  readonly signer: DsseSigner;
  readonly signal?: AbortSignal;
}): Promise<SealedRecord> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.statementBytes)); }
  catch { throw new HostStateError("state-io", "evaluator statement is not UTF-8 JSON"); }
  const parsed = ResultEvaluationStatementSchema.safeParse(value);
  if (!parsed.success || !sameBytes(canonicalAttestationJsonBytes(parsed.data), input.statementBytes)) {
    throw new HostStateError("state-io", "evaluator statement is not exact canonical data");
  }
  const statement: ResultEvaluationStatement = parsed.data;
  const expectedSubjects = [input.expected.task, ...input.expected.results].map(descriptorKey).sort();
  const actualSubjects = statement.subject.map(descriptorKey).sort();
  const predicate = statement.predicate;
  const actualResultNames = [...predicate.resultSubjects].sort();
  const expectedResultNames = input.expected.results.map((result) => result.name).sort();
  if (JSON.stringify(actualSubjects) !== JSON.stringify(expectedSubjects)
    || predicate.taskSubject !== input.expected.task.name
    || JSON.stringify(actualResultNames) !== JSON.stringify(expectedResultNames)
    || predicate.evaluator.id !== input.expected.evaluatorId
    || predicate.evaluationSpecification === undefined
    || descriptorKey(predicate.evaluationSpecification) !== descriptorKey(input.expected.evaluationSpecification)
    || predicate.evaluationMethod === undefined
    || descriptorKey(predicate.evaluationMethod) !== descriptorKey(input.expected.evaluationMethod)) {
    throw new HostStateError("state-io", "evaluator statement binding does not match the exact evaluation dispatch");
  }
  const sealed = await sealSignedPayload({
    payloadBytes: input.statementBytes,
    payloadType: DSSE_PAYLOAD_TYPE,
    signer: input.signer,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!sameBytes(sealed.payloadBytes, input.statementBytes)) {
    throw new HostStateError("state-io", "host signer did not preserve exact evaluator statement bytes");
  }
  const signedEnvelope = parseExactDsseEnvelope(sealed.envelopeBytes);
  if (input.expected.evaluatorSigningKeyId.length === 0
    || signedEnvelope.signatures.some((signature) =>
      signature.keyid !== input.expected.evaluatorSigningKeyId)) {
    throw new HostStateError("state-io", "evaluator signer key is not bound to the evaluator verdict role");
  }
  return sealed;
}

/** Concrete adapter composition stays private to host-local. */
export function createLiveEvaluatorDeployment(options: EvaluatorDeploymentOptions) {
  return createEvaluatorDeployment(options);
}
