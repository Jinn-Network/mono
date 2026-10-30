// SPDX-License-Identifier: Apache-2.0

/**
 * The evidence-native signature check runs only on a `/5` bundle, which the conformance kit does not
 * carry. This builds the smallest `/5` bundle that reaches it: every document parses, and the one
 * evidence record is a signed Result Evaluation.
 *
 * It is not a complete bundle, on purpose. The execution it cites is not carried, so a correctly
 * signed bundle ends at the Matrix replay that follows the signature check, which is what proves
 * the check said yes. A bundle that passes every check needs the evidence builder, which this
 * package does not depend on.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildEvidenceNativeBundleManifestV5,
  EVIDENCE_NATIVE_BUNDLE_V5_CHECKS,
} from "@jinn-network/benchmarking-evidence";
import {
  BENCHMARKING_PROTOCOL_V2,
  CLAIM_PACKAGE_V3_PROFILE,
  EXECUTION_BATCH_CAPTURE_RECORD_KIND,
  sealBenchmarkAnalysisManifest,
  sealBenchmarkDefinitionV2,
  sealEvidenceCohort,
  sealEvidenceNativeClaimPackageV3,
  sealMatrixV2,
} from "@jinn-network/benchmarking-protocol";
import {
  IN_TOTO_STATEMENT_TYPE,
  RESULT_EVALUATION_PREDICATE_TYPE,
  VERDICT_DSSE_PAYLOAD_TYPE,
} from "@jinn-network/task-execution-profiles";
import {
  sealSigned,
  signedBy,
  signerFromLabel,
  type DsseSignatures,
} from "./signers.js";

const METHOD_ID = "jinn.benchmarking.method/binary-instrument";
const EVALUATOR_ID = "urn:evaluator:characterization";

export const EVIDENCE_NATIVE_EVALUATOR = signerFromLabel(EVALUATOR_ID);

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function descriptor(name: string, sha256: string, mediaType?: string) {
  return { name, digest: { sha256 }, ...(mediaType === undefined ? {} : { mediaType }) };
}

function labelled(name: string) {
  return descriptor(name, sha256Hex(name));
}

function sealedAs(name: string, sealed: { readonly digest: string }) {
  return descriptor(name, sealed.digest.slice("sha256:".length));
}

export interface EvidenceNativeBundleOptions {
  readonly signatures?: DsseSignatures;
  /** The bytes carried as the evaluator's public key. Defaults to its real SPKI. */
  readonly publicKeyBytes?: Uint8Array;
}

export function evidenceNativeBundle(options: EvidenceNativeBundleOptions = {}): string {
  const taskDigest = sha256Hex("task");
  const resultDigest = sha256Hex("result");
  const evaluationBytes = sealSigned(
    VERDICT_DSSE_PAYLOAD_TYPE,
    new TextEncoder().encode(JSON.stringify({
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [
        descriptor("candidate-answer.json", resultDigest, "application/json"),
        descriptor("task.json", taskDigest, "application/json"),
      ],
      predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
      predicate: {
        evaluatedAt: "2026-08-16T11:00:01.000Z",
        evaluator: { id: EVALUATOR_ID },
        evaluationMethod: descriptor("method.json", sha256Hex("method"), "application/json"),
        taskSubject: "task.json",
        resultSubjects: ["candidate-answer.json"],
        verdict: "pass",
        measurements: [{ name: "binary-opinion", value: "ACCEPT" }, { name: "parseValid", value: true }],
        evidence: [],
        limitations: [],
      },
    })),
    options.signatures ?? signedBy(EVIDENCE_NATIVE_EVALUATOR),
  );
  const evaluation = {
    family: "result-evaluation",
    record: descriptor("evaluation.dsse.json", sha256Hex(evaluationBytes)),
  } as const;
  const execution = { family: "execution-evidence", record: labelled("ro-crate-metadata.json") } as const;
  const publicKeyBytes = options.publicKeyBytes
    ?? new Uint8Array(EVIDENCE_NATIVE_EVALUATOR.publicKey.export({ format: "der", type: "spki" }));
  const publicKey = descriptor("evaluator.ed25519-public-key.der", sha256Hex(publicKeyBytes));

  const benchmark = sealBenchmarkDefinitionV2({
    protocol: BENCHMARKING_PROTOCOL_V2,
    name: "Characterization",
    description: "One execution, one evaluation.",
    version: "1.0.0",
    items: [{ task: descriptor("task.json", taskDigest), identifiers: [] }],
    reveal: { policy: "immediate" },
  });
  const source = { recordKind: EXECUTION_BATCH_CAPTURE_RECORD_KIND, record: labelled("capture.json") };
  const manifest = sealBenchmarkAnalysisManifest({
    protocol: BENCHMARKING_PROTOCOL_V2,
    benchmark: sealedAs("benchmark.json", benchmark),
    owner: "urn:agent:owner",
    sources: [{ source, cutoff: "2026-08-16T10:00:00Z" }],
    groups: [{ groupId: "memory", selection: labelled("group") }],
    taskRelation: { exactDigestRequired: true },
    multiplicity: {
      correlationUnit: "execution",
      duplicatePolicy: "retain-distinct",
      retryPolicy: "correlated",
      assignmentPolicy: labelled("assignment"),
    },
    evaluationAdmission: {
      evaluatorAllowlist: [EVALUATOR_ID],
      methodAllowlist: [],
      minimumClaims: 1,
      distinctEvaluators: false,
      humanLabelPolicy: "not-required",
      conflictPolicy: "preserve-unresolved",
      supersessionPolicy: "preserve-all",
      trustPolicy: labelled("evaluation-trust"),
    },
    verificationAdmission: {
      requiredChecks: [],
      trustPolicy: labelled("verification-trust"),
      failurePolicy: "disclose",
    },
    completeness: {
      required: "complete",
      unavailableSource: "indeterminate",
      discoveredOmission: "fail",
      excludedMember: "count-attrition",
    },
    analysisPlan: [{ id: METHOD_ID, version: "1", parameters: { k: 1 } }],
    closeAt: "2026-08-16T10:00:00Z",
    preregistration: "post-hoc-exploratory",
  });
  const closure = {
    status: "complete-relative-to-sealed-source",
    candidateCount: 1,
    admittedCount: 1,
    excludedCount: 0,
    unavailableCount: 0,
    limitations: [],
  } as const;
  const member = {
    memberKey: "memory/0001/0",
    execution,
    taskDigest: `sha256:${taskDigest}`,
    resultDigests: [`sha256:${resultDigest}`],
    groupId: "memory",
    slotId: "0001",
    replicate: 0,
  };
  const cohort = sealEvidenceCohort({
    protocol: BENCHMARKING_PROTOCOL_V2,
    manifest: sealedAs("analysis-manifest.json", manifest),
    boundary: { sources: [{ source }], resolvedAt: "2026-08-16T10:00:01Z" },
    members: [{
      ...member,
      correlationKey: "job/trial-0001",
      evaluations: { considered: [evaluation], admitted: [evaluation], excluded: [] },
      verifications: { considered: [], admitted: [], excluded: [] },
      labelResolutions: { considered: [], admitted: [], excluded: [] },
      assurance: {
        origin: "native-direct",
        timing: "prospective-native-observed",
        closure: "complete-relative-to-sealed-source",
        availability: "digest-only",
        limitations: [],
      },
    }],
    excludedExecutions: [],
    closure,
  });
  const matrix = sealMatrixV2({
    protocol: BENCHMARKING_PROTOCOL_V2,
    manifest: sealedAs("analysis-manifest.json", manifest),
    cohort: sealedAs("cohort.json", cohort),
    cells: [{
      ...member,
      consideredEvaluations: [evaluation],
      admittedEvaluations: [evaluation],
      consideredVerifications: [],
      admittedVerifications: [],
      admittedLabelResolutions: [],
      outcome: "accepted",
      integrity: "re-derivable",
      measurements: [],
      trust: {
        signatureValid: "pass",
        identityBound: "pass",
        purposeAuthorized: "pass",
        policyTrusted: "pass",
        partyIndependenceEstablished: "unknown",
      },
      disclosures: [],
    }],
    completeness: { expected: 1, admitted: 1, excluded: 0, unavailable: 0, status: "complete" },
    assembly: {
      procedure: "jinn.benchmarking.assembly",
      version: "3.0",
      implementation: labelled("assembler"),
    },
  });
  // Read only after the Matrix replay, which this bundle never passes.
  const reportBytes = new TextEncoder().encode("{}");
  const reportEnvelopeBytes = new TextEncoder().encode("{}");
  const claim = sealEvidenceNativeClaimPackageV3({
    claimSchema: "benchmark-product.claim-package/3",
    profile: CLAIM_PACKAGE_V3_PROFILE,
    records: {
      benchmark: sealedAs("benchmark.json", benchmark),
      manifest: sealedAs("analysis-manifest.json", manifest),
      cohort: sealedAs("cohort.json", cohort),
      matrix: sealedAs("matrix.json", matrix),
      reportPayload: descriptor("report.json", sha256Hex(reportBytes)),
      reportEnvelope: descriptor("report-envelope.json", sha256Hex(reportEnvelopeBytes)),
      evidence: [evaluation],
      artifacts: [publicKey],
    },
    method: { id: METHOD_ID, version: "1", parameters: { k: 1 } },
    results: {},
    closure,
    trust: {
      signers: [{
        keyId: EVIDENCE_NATIVE_EVALUATOR.keyId,
        identity: EVALUATOR_ID,
        purpose: "automated-evaluator",
        publicKey,
        algorithm: "ed25519",
      }],
      signatureValidityIsNotAuthorization: true,
    },
    verification: { checks: [...EVIDENCE_NATIVE_BUNDLE_V5_CHECKS], command: "colophon-check" },
    issuedAt: "2026-08-16T16:00:00.000Z",
  });

  const files = new Map<string, Uint8Array>([
    ["benchmark.json", benchmark.bytes],
    ["analysis-manifest.json", manifest.bytes],
    ["cohort.json", cohort.bytes],
    ["matrix.json", matrix.bytes],
    ["report.json", reportBytes],
    ["report-envelope.json", reportEnvelopeBytes],
    ["claim-package.json", claim.bytes],
    [`records/${evaluation.record.digest.sha256}.bin`, evaluationBytes],
    [`artifacts/${publicKey.digest.sha256}.bin`, publicKeyBytes],
  ]);
  files.set("bundle.json", buildEvidenceNativeBundleManifestV5(files).bytes);

  const bundleDir = join(mkdtempSync(join(tmpdir(), "checker-characterization-")), "bundle");
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(bundleDir, path)), { recursive: true });
    writeFileSync(join(bundleDir, path), bytes);
  }
  return bundleDir;
}
