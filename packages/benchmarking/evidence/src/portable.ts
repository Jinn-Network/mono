// SPDX-License-Identifier: Apache-2.0

import {
  documentDigest,
  evidenceReferenceKey,
  parseBenchmarkAnalysisManifest,
  parseBenchmarkDefinitionV2,
  parseEvidenceCohort,
  parseEvidenceNativeBundleManifestV5,
  parseEvidenceNativeClaimPackageV3,
  parseHumanLabelResolutionPayload,
  parseMatrixV2,
  sealEvidenceNativeBundleManifestV5,
  serializeCanonicalJson,
  type EvidenceNativeClaimPackageV3,
  type EvidenceRecordReference,
} from "@jinn-network/benchmarking-protocol";
import {
  checkArtifactIntegrity,
  recordDigest,
  validateExecutionEvidence,
  validateExecutionVerification,
  validateResultEvaluation,
  verifyDsseSignatures,
  type DsseSignatureInput,
} from "@jinn-network/evidence-protocol";
import { dssePreAuthEncoding, parseExactDsseEnvelope } from "@jinn-network/trust-core";

import { deriveDefaultEvidenceCell, verifyEvidenceMatrix } from "./matrix.js";
import { verifyEvidenceNativeReport } from "./report.js";

export const EVIDENCE_NATIVE_BUNDLE_V5_CHECKS = [
  "manifest",
  "evidence-closure",
  "artifact-integrity",
  "signature-validity",
  "matrix-rederivation",
  "report-verification",
  "claim-consistency",
] as const;

export interface EvidenceNativeSignatureVerificationInput extends DsseSignatureInput {
  readonly identity: string;
  readonly purpose: EvidenceNativeClaimPackageV3["trust"]["signers"][number]["purpose"];
  readonly publicKeyBytes: Uint8Array;
}

export interface VerifyEvidenceNativePortableBundleInput {
  readonly files: ReadonlyMap<string, Uint8Array>;
  verifySignature(input: EvidenceNativeSignatureVerificationInput): boolean | Promise<boolean>;
}

export interface EvidenceNativePortableBundleVerification {
  readonly format: "benchmark-product-public-bundle/5";
  readonly identity: `sha256:${string}`;
  readonly checks: typeof EVIDENCE_NATIVE_BUNDLE_V5_CHECKS;
  readonly benchmarkDigest: `sha256:${string}`;
  readonly manifestDigest: `sha256:${string}`;
  readonly cohortDigest: `sha256:${string}`;
  readonly matrixDigest: `sha256:${string}`;
  readonly reportDigest: `sha256:${string}`;
  readonly evidenceRecords: number;
  readonly artifacts: number;
  /**
   * The declared signer key ids that actually carried a signature this verification accepted,
   * code-unit sorted. `claim.trust.signers` is a publisher-written declaration and a surplus entry
   * there verifies nothing, so a reader-facing surface must key on this set rather than on the
   * declaration.
   */
  readonly verifiedSignerKeyIds: readonly string[];
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return equalBytes(serializeCanonicalJson(left as never), serializeCanonicalJson(right as never));
}

function safePath(path: string): void {
  if (
    path === "" || path === "." || path === "bundle.json" || path.startsWith("/") ||
    path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new TypeError(`unsafe or reserved bundle path: ${path}`);
}

function read(files: ReadonlyMap<string, Uint8Array>, path: string): Uint8Array {
  const bytes = files.get(path);
  if (bytes === undefined) throw new TypeError(`portable bundle is missing ${path}`);
  return bytes;
}

function assertDescriptor(bytes: Uint8Array, descriptor: { readonly digest: { readonly sha256: string } }, path: string): void {
  const actual = documentDigest(bytes).slice(7);
  if (actual !== descriptor.digest.sha256) throw new TypeError(`${path} digest does not match its exact descriptor`);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function buildEvidenceNativeBundleManifestV5(
  files: ReadonlyMap<string, Uint8Array>,
) {
  if (files.has("bundle.json")) throw new TypeError("bundle.json is produced by the manifest builder");
  const entries = [...files].map(([path, bytes]) => {
    safePath(path);
    return { path, sha256: recordDigest(bytes).slice(7), bytes: bytes.byteLength };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return sealEvidenceNativeBundleManifestV5({
    format: "benchmark-product-public-bundle/5",
    profile: "https://spec.jinn.network/profiles/benchmark-product-public-bundle/5",
    files: entries,
  });
}

export async function verifyEvidenceNativePortableBundle(
  input: VerifyEvidenceNativePortableBundleInput,
): Promise<EvidenceNativePortableBundleVerification> {
  const manifestBytes = read(input.files, "bundle.json");
  const bundle = parseEvidenceNativeBundleManifestV5(manifestBytes);
  const expectedPaths = new Set(["bundle.json", ...bundle.files.map(({ path }) => path)]);
  if (expectedPaths.size !== input.files.size || [...input.files.keys()].some((path) => !expectedPaths.has(path))) {
    throw new TypeError("portable bundle file closure differs from bundle.json");
  }
  for (const entry of bundle.files) {
    safePath(entry.path);
    const bytes = read(input.files, entry.path);
    if (bytes.byteLength !== entry.bytes || recordDigest(bytes).slice(7) !== entry.sha256) {
      throw new TypeError(`${entry.path} failed manifest integrity`);
    }
  }

  const benchmarkBytes = read(input.files, "benchmark.json");
  const analysisManifestBytes = read(input.files, "analysis-manifest.json");
  const cohortBytes = read(input.files, "cohort.json");
  const matrixBytes = read(input.files, "matrix.json");
  const reportBytes = read(input.files, "report.json");
  const reportEnvelopeBytes = read(input.files, "report-envelope.json");
  const claimBytes = read(input.files, "claim-package.json");
  parseBenchmarkDefinitionV2(benchmarkBytes);
  const analysisManifest = parseBenchmarkAnalysisManifest(analysisManifestBytes);
  const cohort = parseEvidenceCohort(cohortBytes);
  const matrix = parseMatrixV2(matrixBytes);
  const claim = parseEvidenceNativeClaimPackageV3(claimBytes);
  for (const [path, bytes, descriptor] of [
    ["benchmark.json", benchmarkBytes, claim.records.benchmark],
    ["analysis-manifest.json", analysisManifestBytes, claim.records.manifest],
    ["cohort.json", cohortBytes, claim.records.cohort],
    ["matrix.json", matrixBytes, claim.records.matrix],
    ["report.json", reportBytes, claim.records.reportPayload],
    ["report-envelope.json", reportEnvelopeBytes, claim.records.reportEnvelope],
  ] as const) assertDescriptor(bytes, descriptor, path);
  if (analysisManifest.benchmark.digest.sha256 !== claim.records.benchmark.digest.sha256) {
    throw new TypeError("analysis manifest does not bind the claimed Benchmark v2");
  }

  const recordBytes = new Map<string, Uint8Array>();
  const publicArtifacts = new Map<string, Uint8Array>();
  for (const artifact of claim.records.artifacts) {
    const bytes = read(input.files, `artifacts/${artifact.digest.sha256}.bin`);
    assertDescriptor(bytes, artifact, `artifacts/${artifact.digest.sha256}.bin`);
    publicArtifacts.set(artifact.digest.sha256, bytes);
  }
  const declaredRecordPaths = new Set<string>();
  for (const reference of claim.records.evidence) {
    const path = `records/${reference.record.digest.sha256}.bin`;
    const bytes = read(input.files, path);
    assertDescriptor(bytes, reference.record, path);
    recordBytes.set(evidenceReferenceKey(reference), bytes);
    declaredRecordPaths.add(path);
  }
  const actualRecordPaths = [...input.files.keys()].filter((path) => /^records\/[0-9a-f]{64}\.bin$/u.test(path));
  if (actualRecordPaths.some((path) => !declaredRecordPaths.has(path)) || actualRecordPaths.length !== declaredRecordPaths.size) {
    throw new TypeError("claim-package/3 evidence closure differs from records/");
  }
  const resolver = {
    resolve(reference: EvidenceRecordReference) {
      const bytes = recordBytes.get(evidenceReferenceKey(reference));
      if (bytes === undefined) throw new TypeError(`unavailable record ${evidenceReferenceKey(reference)}`);
      return bytes;
    },
  };

  const signers = new Map(claim.trust.signers.map((signer) => [signer.keyId, {
    signer,
    publicKeyBytes: read(input.files, `artifacts/${signer.publicKey.digest.sha256}.bin`),
  }]));
  const verifiedSignerKeyIds = new Set<string>();
  const verifySignature = async (signature: DsseSignatureInput, identity: string, allowed: readonly string[]) => {
    if (signature.keyid === undefined) return false;
    const trust = signers.get(signature.keyid);
    if (trust === undefined || trust.signer.identity !== identity || !allowed.includes(trust.signer.purpose)) return false;
    const verified = await input.verifySignature({ ...signature, identity, purpose: trust.signer.purpose, publicKeyBytes: trust.publicKeyBytes });
    if (verified) verifiedSignerKeyIds.add(signature.keyid);
    return verified;
  };
  const referencedArtifacts = new Set<string>();
  for (const reference of claim.records.evidence) {
    const bytes = resolver.resolve(reference);
    if (reference.family === "execution-evidence") {
      const validated = validateExecutionEvidence(bytes);
      if (!validated.conforms || validated.value === undefined) throw new TypeError("nonconforming Execution Evidence in claim closure");
      const available = new Map<string, Uint8Array>();
      for (const entity of validated.value["@graph"]) {
        if (typeof entity.sha256 !== "string") continue;
        referencedArtifacts.add(entity.sha256);
        const artifact = publicArtifacts.get(entity.sha256);
        if (artifact !== undefined) available.set(entity["@id"], artifact);
      }
      const integrity = checkArtifactIntegrity(validated.value, available);
      if (integrity.mismatched !== 0 || integrity.unavailable !== 0) {
        throw new TypeError("Execution Evidence artifact closure is not fully portable");
      }
    } else if (reference.family === "result-evaluation") {
      const validated = validateResultEvaluation(bytes);
      if (!validated.conforms || validated.value === undefined) throw new TypeError("nonconforming Result Evaluation in claim closure");
      const identity = validated.value.statement.predicate.evaluator.id;
      const human = validated.value.statement.predicate.measurements?.some(({ name }) => name === "humanLabel") ?? false;
      const signatures = await verifyDsseSignatures(validated.value, (signature) =>
        verifySignature(signature, identity, [human ? "human-reviewer" : "automated-evaluator"]));
      if (!signatures.verified) throw new TypeError("Result Evaluation signature is invalid or unbound");
    } else if (reference.family === "execution-verification") {
      const validated = validateExecutionVerification(bytes);
      if (!validated.conforms || validated.value === undefined) throw new TypeError("nonconforming Execution Verification in claim closure");
      const signatures = await verifyDsseSignatures(validated.value, (signature) =>
        verifySignature(signature, validated.value!.statement.predicate.verifier.id, ["automated-evaluator"]));
      if (!signatures.verified) throw new TypeError("Execution Verification signature is invalid or unbound");
    } else {
      const envelope = parseExactDsseEnvelope(bytes);
      const resolution = parseHumanLabelResolutionPayload(envelope.payloadBytes);
      const signatures = await Promise.all(envelope.signatures.map((signature, signatureIndex) => verifySignature({
        payloadType: envelope.payloadType,
        payloadBytes: envelope.payloadBytes,
        preAuthEncoding: dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes),
        signature: decodeBase64(signature.sig),
        ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
        signatureIndex,
      }, resolution.issuer, ["label-admission"])));
      if (!signatures.some(Boolean)) throw new TypeError("HumanLabelResolution signature is invalid or unbound");
    }
  }

  const matrixVerification = verifyEvidenceMatrix({
    matrixBytes,
    cohortBytes,
    manifestBytes: analysisManifestBytes,
    records: resolver,
    implementation: matrix.assembly.implementation,
    deriveCell: deriveDefaultEvidenceCell,
  });
  if (!matrixVerification.conforms) throw new TypeError("Matrix v2 failed deterministic assembly-3.0 replay");
  const reportVerification = verifyEvidenceNativeReport({ envelopeBytes: reportEnvelopeBytes, matrixBytes });
  if (!equalBytes(reportBytes, reportVerification.payloadBytes)) throw new TypeError("report.json differs from the signed Report v3 payload");
  const reportEnvelope = parseExactDsseEnvelope(reportEnvelopeBytes);
  const reportSignatures = await Promise.all(reportEnvelope.signatures.map((signature, signatureIndex) => verifySignature({
    payloadType: reportEnvelope.payloadType,
    payloadBytes: reportEnvelope.payloadBytes,
    preAuthEncoding: dssePreAuthEncoding(reportEnvelope.payloadType, reportEnvelope.payloadBytes),
    signature: decodeBase64(signature.sig),
    ...(signature.keyid === undefined ? {} : { keyid: signature.keyid }),
    signatureIndex,
  }, reportVerification.report.author, ["report"])));
  if (!reportSignatures.some(Boolean)) throw new TypeError("Report v3 signature is invalid or unbound");
  if (
    reportEnvelope.payloadType !== "application/vnd.jinn.benchmarking.report.v2+json" ||
    !sameJson(claim.method, {
      id: reportVerification.report.method.id,
      version: reportVerification.report.method.version,
      parameters: reportVerification.report.method.parameters,
    }) ||
    !sameJson(claim.results, reportVerification.report.results) ||
    !sameJson(claim.closure, cohort.closure) ||
    cohort.manifest.digest.sha256 !== claim.records.manifest.digest.sha256 ||
    matrix.cohort.digest.sha256 !== claim.records.cohort.digest.sha256 ||
    matrix.manifest.digest.sha256 !== claim.records.manifest.digest.sha256
  ) throw new TypeError("claim-package/3 is inconsistent with the exact evidence-native chain");
  for (const digest of referencedArtifacts) {
    if (!publicArtifacts.has(digest)) throw new TypeError(`claim artifact closure omits sha256:${digest}`);
  }
  return {
    format: "benchmark-product-public-bundle/5",
    identity: documentDigest(manifestBytes),
    checks: EVIDENCE_NATIVE_BUNDLE_V5_CHECKS,
    benchmarkDigest: documentDigest(benchmarkBytes),
    manifestDigest: documentDigest(analysisManifestBytes),
    cohortDigest: documentDigest(cohortBytes),
    matrixDigest: documentDigest(matrixBytes),
    reportDigest: documentDigest(reportEnvelopeBytes),
    evidenceRecords: claim.records.evidence.length,
    artifacts: claim.records.artifacts.length,
    verifiedSignerKeyIds: [...verifiedSignerKeyIds].sort(),
  };
}
