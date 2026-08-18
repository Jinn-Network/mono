import { createHash } from "node:crypto";
import type { BenchmarkAccountingDispatch, DigestBearingResourceDescriptor, TypedRecordReference } from "@jinn-network/benchmarking-records";
import type { RuntimeEvidenceContributor } from "@jinn-network/benchmarking-publication";
import { describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import {
  NATIVE_RUNTIME_ADAPTER_ID,
  INSPECT_EVAL_LOG_ARTIFACT_ROLE,
  INSPECT_RUNTIME_EVIDENCE_PROFILE,
  INSPECT_RUNTIME_PROVENANCE_ROLE,
  INSPECT_SELECTION_CORRELATION_ROLE,
  NATIVE_RUNTIME_EVIDENCE_PROFILE,
  createRuntimeEvidenceAdapter,
  listRuntimeAdapters,
  runtimeNativeArtifactPublicationPolicy,
  runtimeSubmissionBaseline,
} from "./adapter.js";
import type { EvaluationRuntimeAdapter } from "./adapter.js";

type Sha256Digest = Parameters<RuntimeEvidenceContributor["registration"]>[0]["runDigest"];
type PublicationArtifact = Awaited<ReturnType<RuntimeEvidenceContributor["registration"]>>[number];

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function descriptor(name: string, bytes: Uint8Array): DigestBearingResourceDescriptor {
  return { name, mediaType: "application/octet-stream", digest: { sha256: sha256(bytes) } };
}
function submission(): TypedRecordReference {
  return { kind: "https://spec.jinn.network/records/submission/v1", record: descriptor("submission.json", encoder.encode("submission")) };
}
function dispatch(input: {
  readonly correlations?: BenchmarkAccountingDispatch["correlations"];
  readonly nativeArtifacts?: BenchmarkAccountingDispatch["nativeArtifacts"];
}): BenchmarkAccountingDispatch {
  return { index: 1, submission: submission(), evidence: [], evaluations: [], correlations: input.correlations ?? [], nativeArtifacts: input.nativeArtifacts ?? [] };
}
function artifact(id: string, role: string, bytes: Uint8Array): PublicationArtifact {
  const digest = `sha256:${sha256(bytes)}` as Sha256Digest;
  return { id, role, digest, bytes, mediaType: "application/octet-stream", actions: ["store"] };
}

describe("runtime adapter registry", () => {
  test("the absent binding preserves the existing native submission baseline", () => {
    expect(runtimeSubmissionBaseline()).toEqual({ isolationPolicy: "unrestricted" });
  });

  test("lists the native adapter as the compatibility runtime", () => {
    expect(listRuntimeAdapters()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: NATIVE_RUNTIME_ADAPTER_ID, available: true }),
      expect.objectContaining({ id: "inspect", available: true, selectionRequired: true }),
      expect.objectContaining({ id: "inspect-binary-judge", available: true, selectionRequired: true }),
      expect.objectContaining({ id: "harbor", available: true, selectionRequired: true }),
      expect.objectContaining({ id: "pier", available: true, selectionRequired: true }),
    ]));
  });

  test("keeps runtime-native publication consent behind the adapter boundary", () => {
    expect(runtimeNativeArtifactPublicationPolicy()).toBe("not-applicable");
    expect(runtimeNativeArtifactPublicationPolicy({
      adapterId: "inspect",
      selectionManifestSha256: "a".repeat(64),
    })).toBe("explicit-consent");
    expect(runtimeNativeArtifactPublicationPolicy({
      adapterId: "inspect-binary-judge",
      selectionManifestSha256: "a".repeat(64),
    })).toBe("explicit-consent");
  });

  test("keeps OCI isolation as a runtime-neutral sealed submission fact", () => {
    expect(runtimeSubmissionBaseline({
      adapterId: "inspect-binary-judge",
      selectionManifestSha256: "a".repeat(64),
      isolationPolicy: "oci-container",
    })).toEqual({ isolationPolicy: "oci-container" });
  });

  test("an unregistered adapter refuses explicitly rather than falling back to native", () => {
    expect(() => runtimeSubmissionBaseline({
      adapterId: "unknown-runtime",
      selectionManifestSha256: "a".repeat(64),
    })).toThrow(BenchmarkProductError);
  });

  test("retains the legacy EvaluationRuntimeAdapter object-literal contract", () => {
    const legacy: EvaluationRuntimeAdapter = {
      summary: { id: "legacy", label: "Legacy", available: true, selectionRequired: false },
      nativeArtifactPublication: "not-applicable",
      submissionBaseline: () => ({ isolationPolicy: "unrestricted" }),
    };
    expect(legacy.submissionBaseline(undefined)).toEqual({ isolationPolicy: "unrestricted" });
  });

  test("the native contributor never fabricates a native artifact and reports each supplied disclosure honestly", async () => {
    const adapter = createRuntimeEvidenceAdapter();
    expect(adapter.profile).toBe(NATIVE_RUNTIME_EVIDENCE_PROFILE);
    expect(await adapter.registration({ runDigest: `sha256:${"a".repeat(64)}` as Sha256Digest })).toEqual([]);
    expect(await adapter.dispatch({ submission: submission() })).toEqual({ correlations: [], nativeArtifacts: [] });
    expect(await adapter.verify({ dispatch: dispatch({}) })).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "native-runtime-profile", status: "pass" }),
    ]));

    const bytes = encoder.encode("native exact artifact");
    const disclosures: BenchmarkAccountingDispatch["nativeArtifacts"] = [
      { role: "https://runtime.jinn.network/artifacts/native/public/v1", availability: "public", artifact: descriptor("native.bin", bytes) },
      { role: "https://runtime.jinn.network/artifacts/native/digest/v1", availability: "digest-only", artifact: descriptor("native-private.bin", bytes), reason: "publication consent was not granted" },
      { role: "https://runtime.jinn.network/artifacts/native/source/v1", availability: "source-absent", reason: "the launcher did not produce this object" },
      { role: "https://runtime.jinn.network/artifacts/native/collection/v1", availability: "collection-failed", reason: "artifact collector was unavailable" },
    ];
    expect(await adapter.dispatch({ submission: submission(), nativeArtifacts: disclosures })).toEqual({ correlations: [], nativeArtifacts: disclosures });
  });

  test("the Inspect contributor retains exact registration/native bytes and correlation descriptors", async () => {
    const manifestBytes = encoder.encode("sealed inspect selection manifest");
    const evalLogBytes = encoder.encode("exact EvalLog bytes");
    const manifest = artifact("inspect-selection", INSPECT_SELECTION_CORRELATION_ROLE, manifestBytes);
    const selection = descriptor("selection.json", manifestBytes);
    const nativeLog = descriptor("eval-log.eval", evalLogBytes);
    const provenance = descriptor("inspect-runtime.json", encoder.encode("exact OCI provenance"));
    const adapter = createRuntimeEvidenceAdapter({ adapterId: "inspect", selectionManifestSha256: selection.digest.sha256 }, { registrationArtifacts: [manifest] });

    expect(adapter.profile).toBe(INSPECT_RUNTIME_EVIDENCE_PROFILE);
    const registered = await adapter.registration({ runDigest: `sha256:${"b".repeat(64)}` as Sha256Digest });
    expect(registered[0]).toBe(manifest);
    const contributed = await adapter.dispatch({
      submission: submission(),
      correlations: [
        { role: INSPECT_SELECTION_CORRELATION_ROLE, artifact: selection },
        { role: INSPECT_RUNTIME_PROVENANCE_ROLE, artifact: provenance },
      ],
      nativeArtifacts: [{ role: INSPECT_EVAL_LOG_ARTIFACT_ROLE, availability: "public", artifact: nativeLog }],
    });
    expect(contributed.nativeArtifacts[0]!.artifact).toBe(nativeLog);
    expect(contributed.correlations[1]!.artifact).toBe(provenance);

    const references = new Map<string, Uint8Array>([
      [`sha256:${nativeLog.digest.sha256}`, evalLogBytes],
      [`sha256:${provenance.digest.sha256}`, encoder.encode("exact OCI provenance")],
      [`sha256:${selection.digest.sha256}`, manifestBytes],
    ]);
    const verified = await adapter.verify({ dispatch: dispatch(contributed), references: { async getExact({ digest }) { return references.get(digest); } } });
    expect(verified).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "inspect-runtime-profile", status: "pass" }),
      expect.objectContaining({ name: "inspect-exact-native-evidence", status: "pass" }),
    ]));

    (adapter as { profile: string }).profile = NATIVE_RUNTIME_EVIDENCE_PROFILE;
    const wrongProfile = await adapter.verify({ dispatch: dispatch(contributed), references: { async getExact({ digest }) { return references.get(digest); } } });
    expect(wrongProfile).toEqual(expect.arrayContaining([expect.objectContaining({ name: "inspect-runtime-profile", status: "fail" })]));
  });

  test("the Inspect verifier rejects empty or selection-mismatched evidence and reports unavailable exact bytes as indeterminate", async () => {
    const expectedSelection = descriptor("selection.json", encoder.encode("expected selection"));
    const adapter = createRuntimeEvidenceAdapter({ adapterId: "inspect", selectionManifestSha256: expectedSelection.digest.sha256 });
    const empty = await adapter.verify({ dispatch: dispatch({}) });
    expect(empty).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "inspect-selection-manifest-binding", status: "fail" }),
      expect.objectContaining({ name: "inspect-eval-log-disclosure", status: "fail" }),
    ]));

    const otherSelection = descriptor("selection.json", encoder.encode("different selection"));
    const mismatched = await adapter.verify({ dispatch: dispatch({
      correlations: [{ role: INSPECT_SELECTION_CORRELATION_ROLE, artifact: otherSelection }],
      nativeArtifacts: [{ role: INSPECT_EVAL_LOG_ARTIFACT_ROLE, availability: "source-absent", reason: "not produced" }],
    }) });
    expect(mismatched).toEqual(expect.arrayContaining([expect.objectContaining({ name: "inspect-selection-manifest-binding", status: "fail" })]));

    const unavailable = await adapter.verify({ dispatch: dispatch({
      correlations: [{ role: INSPECT_SELECTION_CORRELATION_ROLE, artifact: expectedSelection }],
      nativeArtifacts: [{ role: INSPECT_EVAL_LOG_ARTIFACT_ROLE, availability: "collection-failed", reason: "collector timed out" }],
    }) });
    expect(unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ name: "inspect-exact-native-evidence", status: "indeterminate" })]));
  });

  test("the Inspect verifier detects tampering and rejects duplicate roles without recomputing an outcome", async () => {
    const selection = descriptor("selection.json", encoder.encode("selected Inspect evaluation"));
    const adapter = createRuntimeEvidenceAdapter({ adapterId: "inspect", selectionManifestSha256: selection.digest.sha256 });
    const expected = encoder.encode("expected EvalLog");
    const nativeLog = descriptor("eval-log.eval", expected);
    const tampered = await adapter.verify({
      dispatch: dispatch({
        correlations: [{ role: INSPECT_SELECTION_CORRELATION_ROLE, artifact: selection }],
        nativeArtifacts: [{ role: INSPECT_EVAL_LOG_ARTIFACT_ROLE, availability: "public", artifact: nativeLog }],
      }),
      references: { async getExact() { return encoder.encode("tampered EvalLog"); } },
    });
    expect(tampered).toEqual(expect.arrayContaining([expect.objectContaining({ name: "inspect-exact-native-evidence", status: "fail" })]));

    const duplicated = await adapter.verify({ dispatch: dispatch({ nativeArtifacts: [
      { role: INSPECT_EVAL_LOG_ARTIFACT_ROLE, availability: "source-absent", reason: "not produced" },
      { role: INSPECT_EVAL_LOG_ARTIFACT_ROLE, availability: "collection-failed", reason: "not collected" },
    ], correlations: [{ role: INSPECT_SELECTION_CORRELATION_ROLE, artifact: selection }] }) });
    expect(duplicated).toEqual(expect.arrayContaining([expect.objectContaining({ name: "runtime-evidence-unique-roles", status: "fail" })]));
  });
});
