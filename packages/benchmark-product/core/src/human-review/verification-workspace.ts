// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { verify as verifySignature } from "node:crypto";
import { dssePreAuthEncoding, parseExactDsseEnvelope } from "@jinn-network/trust-core";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { readEvaluatorPublicKeyRecords } from "../venue/signing.js";
import { loadOrCreateReportSigningKey, verifyReportEnvelopeSignatures } from "../report/signing.js";
import {
  verifyBinaryJudgmentAdmissionClosure,
  type BinaryJudgmentAdmissionClosurePorts,
  type VerifiedBinaryJudgmentAdmissionClosure,
} from "./verification.js";

export interface VerifyBinaryJudgmentAdmissionClosureInWorkspaceInput {
  readonly workspaceDir: string;
  readonly admissionManifestSha256: `sha256:${string}`;
  readonly expectedDraftId: string;
}

export function buildBinaryJudgmentAdmissionClosureWorkspacePorts(
  workspaceDir: string,
): BinaryJudgmentAdmissionClosurePorts {
  const evaluatorKeys = readEvaluatorPublicKeyRecords(workspaceDir);
  const authorityKey = loadOrCreateReportSigningKey(workspaceDir);
  return {
    resolveExactRecord: (digest) => getSealedBytes(workspaceDir, digest.slice("sha256:".length)),
    verifyReviewerSignature: ({ envelopeBytes, evaluatorId, keyId }) => {
      const key = evaluatorKeys.get(evaluatorId);
      if (key === undefined || key.keyId !== keyId) return false;
      try {
        const envelope = parseExactDsseEnvelope(envelopeBytes);
        if (envelope.signatures.length !== 1 || envelope.signatures[0]?.keyid !== keyId) return false;
        return verifySignature(
          null,
          Buffer.from(dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes)),
          key.publicKey,
          Buffer.from(envelope.signatures[0].sig, "base64"),
        );
      } catch {
        return false;
      }
    },
    verifyAuthoritySignature: ({ envelopeBytes, keyId }) =>
      keyId === authorityKey.keyId
      && verifyReportEnvelopeSignatures(envelopeBytes, authorityKey).validSignerKeyids.includes(keyId),
  };
}

/** Product-owned trust adapter for F1/C1. Portable readers should use the injected-port core. */
export function verifyBinaryJudgmentAdmissionClosureInWorkspace(
  input: VerifyBinaryJudgmentAdmissionClosureInWorkspaceInput,
): VerifiedBinaryJudgmentAdmissionClosure {
  return verifyBinaryJudgmentAdmissionClosure({
    admissionManifestSha256: input.admissionManifestSha256,
    expectedDraftId: input.expectedDraftId,
  }, buildBinaryJudgmentAdmissionClosureWorkspacePorts(input.workspaceDir));
}
