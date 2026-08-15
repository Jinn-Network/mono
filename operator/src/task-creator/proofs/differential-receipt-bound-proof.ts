// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed binding for proof/lifecycle consumers of a real Jinn
 * differential-admission receipt. This is deliberately separate from the
 * synthetic Vitest JSON parser-contract fixture: receipt absence or drift
 * must stop a task before it can be posted or evaluated.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../util/canonical-json.js';
import {
  hashDifferentialAdmissionReceiptV2,
  verifyDifferentialAdmissionReceiptV2,
  type DifferentialAdmissionReceiptV2,
} from '../../solver-types/_swe-rebench-v2-differential-admission.js';
import type { MintedEnvironmentBindingV1 } from '../../solver-types/_swe-rebench-v2-minted-pool.js';
import { verifyEnvironmentAttestationV1 } from '../environment/contracts.js';
import {
  JINN_MONO_DIFFERENTIAL_PROOF_SOURCE,
  type JinnDifferentialProofSource,
} from './public-repo-fixtures.js';
import { isAcceptedIpfsCid } from './ipfs-cid.js';

type Sha256 = `sha256:${string}`;

export type ReceiptBoundJinnDifferentialProof = {
  source: JinnDifferentialProofSource;
  receipt: DifferentialAdmissionReceiptV2;
  receiptCid: string;
  receiptHash: Sha256;
  environment: MintedEnvironmentBindingV1;
  testPatch: string;
};

export type BindJinnDifferentialReceiptToProofInput = {
  source: JinnDifferentialProofSource;
  receipt: unknown;
  receiptCid: string;
  /** Caller-provided artifact hash. If omitted, canonical receipt content supplies it. */
  receiptHash?: Sha256;
  environment: MintedEnvironmentBindingV1;
  testPatch: string;
};

function sha256(value: string): Sha256 {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function fail(message: string): never {
  throw new Error(`receipt-bound Jinn proof: ${message}`);
}

function assertCanonicalJinnSource(source: JinnDifferentialProofSource): void {
  const expected = JINN_MONO_DIFFERENTIAL_PROOF_SOURCE;
  if (
    source.id !== expected.id ||
    source.repo !== expected.repo ||
    source.baseCommit !== expected.baseCommit ||
    source.fixCommit !== expected.fixCommit ||
    source.instanceId !== expected.instanceId ||
    source.language !== expected.language ||
    source.evidenceKind !== expected.evidenceKind ||
    !sameCanonical(source.testPaths, expected.testPaths)
  ) {
    fail('source must equal the reviewed Jinn #1422 base/fix/instance/path identity');
  }
}

/**
 * Verify the generated receipt and all public bindings needed before a Jinn
 * task can be posted, evaluated, or represented in a proof record.
 */
export async function bindJinnDifferentialReceiptToProof(
  input: BindJinnDifferentialReceiptToProofInput,
): Promise<ReceiptBoundJinnDifferentialProof> {
  assertCanonicalJinnSource(input.source);
  if (!isAcceptedIpfsCid(input.receiptCid)) fail('receipt CID must use a CIDv0 or lowercase-base32 CIDv1 format');
  if (input.testPatch.trim() === '') fail('public test patch is required');

  const receipt = verifyDifferentialAdmissionReceiptV2(input.receipt);
  const receiptHash = hashDifferentialAdmissionReceiptV2(receipt);
  if (input.receiptHash !== undefined && input.receiptHash !== receiptHash) {
    fail('receipt hash does not match canonical receipt content');
  }
  if (!sameCanonical(receipt.task, {
    instanceId: input.source.instanceId,
    repo: input.source.repo,
    baseCommit: input.source.baseCommit,
    fixCommit: input.source.fixCommit,
  })) {
    fail('receipt task identity does not match the reviewed Jinn source');
  }
  if (!sameCanonical(receipt.testPaths.map((path) => path.testPath), input.source.testPaths)) {
    fail('receipt test paths do not match the reviewed Jinn regression paths');
  }
  if (receipt.testPatchHash !== sha256(input.testPatch)) {
    fail('receipt public test-patch hash drifted');
  }
  if (
    receipt.environment.environmentHash !== input.environment.environmentHash ||
    !sameCanonical(receipt.environment.image, input.environment.image) ||
    !sameCanonical(receipt.environment.parser, input.environment.parser) ||
    receipt.environment.platform !== input.environment.platform
  ) {
    fail('receipt environment binding drifted');
  }
  if (input.environment.attestation.environmentHash !== input.environment.environmentHash) {
    fail('environment attestation does not bind its declared environment hash');
  }
  if (!await verifyEnvironmentAttestationV1(input.environment.attestation)) {
    fail('environment attestation signature is invalid');
  }
  return {
    source: input.source,
    receipt,
    receiptCid: input.receiptCid,
    receiptHash,
    environment: input.environment,
    testPatch: input.testPatch,
  };
}
