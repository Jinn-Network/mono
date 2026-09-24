import { describe, expect, test } from "vitest";
import {
  BENCHMARKING_PROTOCOL_V2,
  EXECUTION_BATCH_CAPTURE_RECORD_KIND,
  documentDigest,
  evidenceReferenceKey,
  sealEvidenceCohort,
  sealEvidenceNativeClaimPackageV3,
  type EvidenceRecordReference,
} from "@jinn-network/benchmarking-protocol";
import { sealDsseEnvelope } from "@jinn-network/trust-core";
import { evidenceNativeBundleSigners, legacyBundleSigners } from "./signers.js";
import { BundleTrustSchema, BundleV4TrustSchema } from "./schema.js";

const REPORT = {
  keyId: "did:key:zReport",
  algorithm: "ed25519",
  spkiDerBase64: "AA==",
  author: "did:key:zReport",
  didKey: "did:key:zReport",
  validFrom: "2026-08-18T11:41:56.880Z",
} as const;

function evaluator(name: string, keyId: string) {
  return { evaluator: `urn:jinn:evaluator:${name}`, keyId, algorithm: "ed25519", spkiDerBase64: "AA==" } as const;
}

describe("legacy bundle signers", () => {
  test("the report author is the publisher and every evaluator is an automated grader", () => {
    const trust = BundleTrustSchema.parse({
      format: "benchmark-product-public-trust/2",
      selfRun: { custody: "workspace-minted", evaluatorDistinctness: "agent-distinctness-only", partyIndependence: "not-established" },
      report: REPORT,
      evaluators: [evaluator("one", "k1"), evaluator("two", "k2")],
    });
    expect(legacyBundleSigners(trust, new Set(["urn:jinn:evaluator:one", "urn:jinn:evaluator:two"]))).toEqual([
      { role: "publisher", identity: "did:key:zReport", keyId: "did:key:zReport", custody: "same-operator" },
      { role: "automated-grader", identity: "urn:jinn:evaluator:one", keyId: "k1", custody: "same-operator" },
      { role: "automated-grader", identity: "urn:jinn:evaluator:two", keyId: "k2", custody: "same-operator" },
    ]);
  });

  test("grading and reviewing are read from their own sets, and the authorities are not a second key", () => {
    const trust = BundleV4TrustSchema.parse({
      format: "benchmark-product-public-trust/4",
      selfRun: { custody: "workspace-minted", evaluatorDistinctness: "agent-distinctness-only", partyIndependence: "not-established" },
      report: REPORT,
      evaluators: [evaluator("one", "k1"), evaluator("two", "k2")],
      admission: {
        reviewers: [{ evaluator: "urn:jinn:evaluator:one", keyId: "k1" }, { evaluator: "urn:jinn:evaluator:two", keyId: "k2" }],
        authorities: [{ role: "roster-attestor", keyId: "did:key:zReport" }, { role: "truth-reveal-attestor", keyId: "did:key:zReport" }],
      },
    });
    // Only `two` graded a Matrix cell. `one` reviewed and nothing else, so printing it as a grader
    // would overstate the grading set; `two` did both, so it must appear under both roles. The
    // admission authorities are the publisher's own key and are deliberately not listed again.
    expect(legacyBundleSigners(trust, new Set(["urn:jinn:evaluator:two"]))).toEqual([
      { role: "publisher", identity: "did:key:zReport", keyId: "did:key:zReport", custody: "same-operator" },
      { role: "human-reviewer", identity: "urn:jinn:evaluator:one", keyId: "k1", custody: "same-operator" },
      { role: "automated-grader", identity: "urn:jinn:evaluator:two", keyId: "k2", custody: "same-operator" },
      { role: "human-reviewer", identity: "urn:jinn:evaluator:two", keyId: "k2", custody: "same-operator" },
    ]);
  });
});

function emptyMembersCohort() {
  return sealEvidenceCohort({
    protocol: BENCHMARKING_PROTOCOL_V2,
    manifest: { name: "manifest", digest: { sha256: "a".repeat(64) } },
    boundary: {
      sources: [{
        source: {
          recordKind: EXECUTION_BATCH_CAPTURE_RECORD_KIND,
          record: { name: "capture", digest: { sha256: "b".repeat(64) } },
        },
      }],
      resolvedAt: "2026-08-16T10:00:01Z",
    },
    members: [],
    excludedExecutions: [],
    closure: {
      status: "complete-relative-to-sealed-source",
      candidateCount: 0,
      admittedCount: 0,
      excludedCount: 0,
      unavailableCount: 0,
      limitations: [],
    },
  });
}

function dsseRecord(keyId: string): Uint8Array {
  return sealDsseEnvelope({
    payloadBytes: new TextEncoder().encode("{}"),
    signatures: [{ keyid: keyId, signature: new Uint8Array([1]) }],
  });
}

function evidenceRef(family: "result-evaluation" | "execution-evidence", bytes: Uint8Array) {
  const sha256 = documentDigest(bytes).slice(7);
  return {
    family,
    record: { name: `${sha256}.bin`, digest: { sha256 } },
  } as const;
}

function oneMemberCohort(
  execution: EvidenceRecordReference,
  evaluations: { considered: EvidenceRecordReference[]; admitted: EvidenceRecordReference[]; excluded: [] },
) {
  return sealEvidenceCohort({
    protocol: BENCHMARKING_PROTOCOL_V2,
    manifest: { name: "manifest", digest: { sha256: "a".repeat(64) } },
    boundary: {
      sources: [{
        source: {
          recordKind: EXECUTION_BATCH_CAPTURE_RECORD_KIND,
          record: { name: "capture", digest: { sha256: "b".repeat(64) } },
        },
      }],
      resolvedAt: "2026-08-16T10:00:01Z",
    },
    members: [{
      memberKey: "memory/0001/0",
      execution,
      taskDigest: `sha256:${"1".repeat(64)}`,
      resultDigests: [`sha256:${"3".repeat(64)}`],
      groupId: "memory",
      slotId: "0001",
      replicate: 0,
      correlationKey: "harbor/job-1/trial-1",
      evaluations,
      verifications: { considered: [], admitted: [], excluded: [] },
      labelResolutions: { considered: [], admitted: [], excluded: [] },
      assurance: {
        origin: "native-direct",
        timing: "prospective-native-observed",
        closure: "complete-relative-to-sealed-source",
        availability: "public-exact",
        limitations: [],
      },
    }],
    excludedExecutions: [],
    closure: {
      status: "complete-relative-to-sealed-source",
      candidateCount: 1,
      admittedCount: 1,
      excludedCount: 0,
      unavailableCount: 0,
      limitations: [],
    },
  });
}

function claimPackage(input: {
  evidence: EvidenceRecordReference[];
  signers: readonly {
    keyId: string;
    identity: string;
    purpose: "report" | "automated-evaluator" | "human-reviewer" | "label-admission";
  }[];
  admittedCount: number;
}) {
  const digest = { name: "record", digest: { sha256: "b".repeat(64) }, mediaType: "application/octet-stream" };
  return sealEvidenceNativeClaimPackageV3({
    claimSchema: "benchmark-product.claim-package/3",
    profile: "https://spec.jinn.network/profiles/claim-package/3",
    records: {
      benchmark: digest, manifest: digest, cohort: digest, matrix: digest,
      reportPayload: digest, reportEnvelope: digest, evidence: input.evidence, artifacts: [],
    },
    method: { id: "m", version: "1", parameters: {} },
    results: {},
    closure: {
      status: "complete-relative-to-sealed-source",
      candidateCount: input.admittedCount,
      admittedCount: input.admittedCount,
      excludedCount: 0,
      unavailableCount: 0,
      limitations: [],
    },
    trust: {
      signers: input.signers.map((signer) => ({ ...signer, publicKey: digest, algorithm: "ed25519" as const })),
      signatureValidityIsNotAuthorization: true,
    },
    verification: {
      checks: ["manifest", "evidence-closure", "artifact-integrity", "signature-validity", "matrix-rederivation", "report-verification", "claim-consistency"],
      command: "colophon-verify",
    },
    issuedAt: "2026-08-18T11:41:56.880Z",
  });
}

function byEvidenceKey(left: EvidenceRecordReference, right: EvidenceRecordReference): number {
  const a = evidenceReferenceKey(left);
  const b = evidenceReferenceKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

describe("evidence-native bundle signers", () => {
  test("an empty-members cohort discloses only verified report keys", () => {
    const digest = { name: "record", digest: { sha256: "b".repeat(64) }, mediaType: "application/octet-stream" };
    const claim = sealEvidenceNativeClaimPackageV3({
      claimSchema: "benchmark-product.claim-package/3",
      profile: "https://spec.jinn.network/profiles/claim-package/3",
      records: {
        benchmark: digest, manifest: digest, cohort: digest, matrix: digest,
        reportPayload: digest, reportEnvelope: digest, evidence: [], artifacts: [],
      },
      method: { id: "m", version: "1", parameters: {} },
      results: {},
      closure: { status: "complete-relative-to-sealed-source", candidateCount: 0, admittedCount: 0, excludedCount: 0, unavailableCount: 0, limitations: [] },
      trust: {
        signers: [
          { keyId: "k1", identity: "urn:report:1", purpose: "report", publicKey: digest, algorithm: "ed25519" },
          { keyId: "k2", identity: "urn:evaluator:1", purpose: "automated-evaluator", publicKey: digest, algorithm: "ed25519" },
          { keyId: "k3", identity: "urn:evaluator:2", purpose: "human-reviewer", publicKey: digest, algorithm: "ed25519" },
          { keyId: "k4", identity: "urn:admission:1", purpose: "label-admission", publicKey: digest, algorithm: "ed25519" },
        ],
        signatureValidityIsNotAuthorization: true,
      },
      verification: {
        checks: ["manifest", "evidence-closure", "artifact-integrity", "signature-validity", "matrix-rederivation", "report-verification", "claim-consistency"],
        command: "colophon-verify",
      },
      issuedAt: "2026-08-18T11:41:56.880Z",
    });
    const cohort = emptyMembersCohort();
    const records = new Map<string, Uint8Array>();
    // Verified non-report purposes still sit in `verifiedSignerKeyIds` (they signed something the
    // closure accepted). With no cohort-referenced declared evidence they must not reach the reader.
    expect(evidenceNativeBundleSigners(claim.bytes, ["k1", "k2", "k3", "k4"], cohort.bytes, records)).toEqual([
      { role: "publisher", identity: "urn:report:1", keyId: "k1", custody: "undeclared" },
    ]);
    expect(evidenceNativeBundleSigners(claim.bytes, ["k1", "k2"], cohort.bytes, records)).toEqual([
      { role: "publisher", identity: "urn:report:1", keyId: "k1", custody: "undeclared" },
    ]);
    expect(evidenceNativeBundleSigners(claim.bytes, [], cohort.bytes, records)).toEqual([]);
    // Missing `cohort.json` is wired as empty bytes: same reader-facing set, never a throw.
    expect(evidenceNativeBundleSigners(claim.bytes, ["k1", "k2", "k3", "k4"], new Uint8Array(), records)).toEqual([
      { role: "publisher", identity: "urn:report:1", keyId: "k1", custody: "undeclared" },
    ]);
  });

  test("a surplus signed record is verified but not disclosed unless the cohort references it (#3283)", () => {
    const digest = { name: "record", digest: { sha256: "b".repeat(64) }, mediaType: "application/octet-stream" };
    const referencedBytes = dsseRecord("k-ref");
    const surplusBytes = dsseRecord("k-surplus");
    const referenced = evidenceRef("result-evaluation", referencedBytes);
    const surplus = evidenceRef("result-evaluation", surplusBytes);
    const evidence = [referenced, surplus].toSorted(byEvidenceKey);
    const execution = {
      family: "execution-evidence",
      record: { name: "execution.bin", digest: { sha256: "c".repeat(64) } },
    } as const;
    const cohort = sealEvidenceCohort({
      protocol: BENCHMARKING_PROTOCOL_V2,
      manifest: { name: "manifest", digest: { sha256: "a".repeat(64) } },
      boundary: {
        sources: [{
          source: {
            recordKind: EXECUTION_BATCH_CAPTURE_RECORD_KIND,
            record: { name: "capture", digest: { sha256: "b".repeat(64) } },
          },
        }],
        resolvedAt: "2026-08-16T10:00:01Z",
      },
      members: [{
        memberKey: "memory/0001/0",
        execution,
        taskDigest: `sha256:${"1".repeat(64)}`,
        resultDigests: [`sha256:${"3".repeat(64)}`],
        groupId: "memory",
        slotId: "0001",
        replicate: 0,
        correlationKey: "harbor/job-1/trial-1",
        evaluations: { considered: [referenced], admitted: [referenced], excluded: [] },
        verifications: { considered: [], admitted: [], excluded: [] },
        labelResolutions: { considered: [], admitted: [], excluded: [] },
        assurance: {
          origin: "native-direct",
          timing: "prospective-native-observed",
          closure: "complete-relative-to-sealed-source",
          availability: "public-exact",
          limitations: [],
        },
      }],
      excludedExecutions: [],
      closure: {
        status: "complete-relative-to-sealed-source",
        candidateCount: 1,
        admittedCount: 1,
        excludedCount: 0,
        unavailableCount: 0,
        limitations: [],
      },
    });
    const claim = sealEvidenceNativeClaimPackageV3({
      claimSchema: "benchmark-product.claim-package/3",
      profile: "https://spec.jinn.network/profiles/claim-package/3",
      records: {
        benchmark: digest, manifest: digest, cohort: digest, matrix: digest,
        reportPayload: digest, reportEnvelope: digest, evidence, artifacts: [],
      },
      method: { id: "m", version: "1", parameters: {} },
      results: {},
      closure: { status: "complete-relative-to-sealed-source", candidateCount: 1, admittedCount: 1, excludedCount: 0, unavailableCount: 0, limitations: [] },
      trust: {
        signers: [
          { keyId: "k-ref", identity: "urn:evaluator:ref", purpose: "automated-evaluator", publicKey: digest, algorithm: "ed25519" },
          { keyId: "k-report", identity: "urn:report:1", purpose: "report", publicKey: digest, algorithm: "ed25519" },
          { keyId: "k-surplus", identity: "urn:evaluator:surplus", purpose: "human-reviewer", publicKey: digest, algorithm: "ed25519" },
        ],
        signatureValidityIsNotAuthorization: true,
      },
      verification: {
        checks: ["manifest", "evidence-closure", "artifact-integrity", "signature-validity", "matrix-rederivation", "report-verification", "claim-consistency"],
        command: "colophon-verify",
      },
      issuedAt: "2026-08-18T11:41:56.880Z",
    });
    const executionBytes = dsseRecord("k-surplus");
    const records = new Map<string, Uint8Array>([
      [`records/${referenced.record.digest.sha256}.bin`, referencedBytes],
      [`records/${surplus.record.digest.sha256}.bin`, surplusBytes],
      [`records/${execution.record.digest.sha256}.bin`, executionBytes],
    ]);
    const signers = evidenceNativeBundleSigners(
      claim.bytes,
      ["k-ref", "k-report", "k-surplus"],
      cohort.bytes,
      records,
    );
    expect(signers).toEqual([
      { role: "automated-grader", identity: "urn:evaluator:ref", keyId: "k-ref", custody: "undeclared" },
      { role: "publisher", identity: "urn:report:1", keyId: "k-report", custody: "undeclared" },
    ]);
    expect(signers).not.toContainEqual({
      role: "human-reviewer", identity: "urn:evaluator:surplus", keyId: "k-surplus", custody: "undeclared",
    });
  });

  test("an execution-evidence DSSE keyid is verified-but-not-disclosed (#3283)", () => {
    const executionBytes = dsseRecord("k-exec");
    const execution = evidenceRef("execution-evidence", executionBytes);
    const cohort = oneMemberCohort(execution, { considered: [], admitted: [], excluded: [] });
    const claim = claimPackage({
      evidence: [execution],
      admittedCount: 1,
      signers: [
        { keyId: "k-exec", identity: "urn:evaluator:exec", purpose: "automated-evaluator" },
        { keyId: "k-report", identity: "urn:report:1", purpose: "report" },
      ],
    });
    const records = new Map<string, Uint8Array>([
      [`records/${execution.record.digest.sha256}.bin`, executionBytes],
    ]);
    expect(evidenceNativeBundleSigners(
      claim.bytes,
      ["k-exec", "k-report"],
      cohort.bytes,
      records,
    )).toEqual([
      { role: "publisher", identity: "urn:report:1", keyId: "k-report", custody: "undeclared" },
    ]);
  });

  test("a non-DSSE cohort-referenced record does not throw or disclose (#3283)", () => {
    const garbage = new TextEncoder().encode("{not-dsse}");
    const referenced = evidenceRef("result-evaluation", garbage);
    const execution = {
      family: "execution-evidence",
      record: { name: "execution.bin", digest: { sha256: "c".repeat(64) } },
    } as const;
    const cohort = oneMemberCohort(execution, { considered: [referenced], admitted: [referenced], excluded: [] });
    const claim = claimPackage({
      evidence: [referenced],
      admittedCount: 1,
      signers: [
        { keyId: "k-ref", identity: "urn:evaluator:ref", purpose: "automated-evaluator" },
        { keyId: "k-report", identity: "urn:report:1", purpose: "report" },
      ],
    });
    const records = new Map<string, Uint8Array>([
      [`records/${referenced.record.digest.sha256}.bin`, garbage],
    ]);
    expect(() => evidenceNativeBundleSigners(
      claim.bytes,
      ["k-ref", "k-report"],
      cohort.bytes,
      records,
    )).not.toThrow();
    expect(evidenceNativeBundleSigners(
      claim.bytes,
      ["k-ref", "k-report"],
      cohort.bytes,
      records,
    )).toEqual([
      { role: "publisher", identity: "urn:report:1", keyId: "k-report", custody: "undeclared" },
    ]);
  });
});

describe("key fingerprints (issue #2983)", () => {
  // A real did:key, so there is key material to digest. `REPORT`'s `did:key:zReport` above is not
  // one -- which is why every assertion in this file's other tests still expects no fingerprint.
  const REAL_DID_KEY = "did:key:z6MkiTfZS4EM9K1fczmhpcmi1YxDdtURfuPWJrCSofeTwYFX";

  test("a signer whose identifier carries its key gets the digest of that key", () => {
    const trust = BundleTrustSchema.parse({
      format: "benchmark-product-public-trust/2",
      selfRun: { custody: "workspace-minted", evaluatorDistinctness: "agent-distinctness-only", partyIndependence: "not-established" },
      report: { ...REPORT, keyId: REAL_DID_KEY, didKey: REAL_DID_KEY, author: REAL_DID_KEY },
      evaluators: [evaluator("one", "benchmark-product-verdict-0001")],
    });
    const [publisher, grader] = legacyBundleSigners(trust, new Set(["urn:jinn:evaluator:one"]));
    expect(publisher!.keyFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    // A verdict keyId is not a did:key: no key material, so no fingerprint rather than a digest of
    // the identifier string, which would not be a key fingerprint at all.
    expect(grader!.keyFingerprint).toBeUndefined();
  });
});
