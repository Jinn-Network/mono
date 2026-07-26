// SPDX-License-Identifier: Apache-2.0

import {
  checkArtifactIntegrity,
  recordDigest,
  validateExecutionEvidence,
} from "@jinn-network/evidence-protocol";
import { describe, expect, test } from "vitest";

import { canonicalJsonBytes, copyBytes, sha256Digest } from "./bytes.js";
import { normalizeDetectorFindings } from "./detectors/index.js";
import {
  baselinePolicyValue,
  syntheticDerivationInput,
  SYNTHETIC_PRIVATE_VALUES,
} from "./fixtures.js";
import { parseScrubReceipt } from "./receipt.js";
import type {
  DerivationDetector,
  DerivationOperationOptions,
  DerivationSurface,
  DeriveExecutionEvidenceInput,
  EvidenceDeriver,
} from "./types.js";

export type EvidenceDeriverContractFactory = () =>
  | EvidenceDeriver
  | Promise<EvidenceDeriver>;

export type DerivationDetectorContractFactory = () =>
  | DerivationDetector
  | Promise<DerivationDetector>;

export interface DerivationDetectorContractFixture {
  readonly surface: DerivationSurface;
  readonly expectedClasses?: readonly string[];
}

export interface SyntheticPrivateDetectorConfiguration {
  readonly schemaVersion: "jinn.private-detector-configuration.v1";
  readonly nonce: string;
  readonly knownIdentities: readonly string[];
  readonly privateAllowlist: readonly string[];
}

function detectorSurface(
  surfaceId: string,
  text: string,
): DerivationSurface {
  return Object.freeze({
    surfaceId,
    sourceEntityId: "synthetic-contract",
    role: "other",
    mediaType: "text/plain",
    codec: "text",
    location: "",
    text,
  });
}

export function createSyntheticPrivateDetectorConfiguration():
SyntheticPrivateDetectorConfiguration {
  return Object.freeze({
    schemaVersion: "jinn.private-detector-configuration.v1",
    nonce: SYNTHETIC_PRIVATE_VALUES.nonce,
    knownIdentities: Object.freeze([SYNTHETIC_PRIVATE_VALUES.knownIdentity]),
    privateAllowlist: Object.freeze([
      SYNTHETIC_PRIVATE_VALUES.privateAllowlist,
    ]),
  });
}

export function createSyntheticDerivationInput():
DeriveExecutionEvidenceInput {
  return syntheticDerivationInput();
}

export function createSyntheticDerivationDetectorFixtures(): Readonly<{
  knownIdentity: readonly DerivationDetectorContractFixture[];
  deterministicPatterns: readonly DerivationDetectorContractFixture[];
}> {
  return Object.freeze({
    knownIdentity: Object.freeze([
      Object.freeze({
        surface: detectorSurface(
          "contract:known-identity",
          `operator ${SYNTHETIC_PRIVATE_VALUES.knownIdentity}`,
        ),
        expectedClasses: Object.freeze(["known-identity"]),
      }),
      Object.freeze({
        surface: detectorSurface(
          "contract:known-identity-safe",
          "anonymous synthetic operator",
        ),
        expectedClasses: Object.freeze([]),
      }),
    ]),
    deterministicPatterns: Object.freeze([
      Object.freeze({
        surface: detectorSurface(
          "contract:patterns",
          "email ada@example.invalid and card 4111 1111 1111 1111",
        ),
        expectedClasses: Object.freeze(["email", "payment-instrument"]),
      }),
      Object.freeze({
        surface: detectorSurface(
          "contract:technical-values",
          `sha256:${"a".repeat(64)} bafkreibm6jg3ux5qu3hbutfqc3hdoclhwd3bk4ufuyt7xzhsg7cdqs2m7a`,
        ),
        expectedClasses: Object.freeze([]),
      }),
    ]),
  });
}

function retainPolicyInput(): DeriveExecutionEvidenceInput {
  const input = syntheticDerivationInput();
  const policy = baselinePolicyValue();
  (
    policy as {
      dispositions: typeof policy.dispositions;
    }
  ).dispositions = policy.dispositions.map((row) => ({
    ...row,
    disposition: "retain",
  }));
  (input as { policyBytes: Uint8Array }).policyBytes =
    canonicalJsonBytes(policy);
  return input;
}

function reviewPolicyInput(): DeriveExecutionEvidenceInput {
  const input = syntheticDerivationInput();
  const policy = baselinePolicyValue();
  (
    policy as {
      dispositions: typeof policy.dispositions;
    }
  ).dispositions = policy.dispositions.map((row) =>
    row.class === "credential"
      ? { ...row, disposition: "review" as const }
      : row,
  );
  (input as { policyBytes: Uint8Array }).policyBytes =
    canonicalJsonBytes(policy);
  return input;
}

function findPrimaryExecution(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const graph = document["@graph"] as Array<Record<string, unknown>>;
  const execution = graph.find((entity) => {
    const type = Array.isArray(entity["@type"])
      ? entity["@type"]
      : [entity["@type"]];
    return type.includes("CreateAction") && type.includes("prov:Activity");
  });
  if (!execution) throw new Error("synthetic execution is missing");
  return execution;
}

function decodeDocument(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function physicalArtifacts(
  artifacts: readonly {
    readonly entityId: string;
    readonly bytes: Uint8Array;
  }[],
): ReadonlyMap<string, Uint8Array> {
  return new Map(
    artifacts.map(({ entityId, bytes }) => [entityId, bytes] as const),
  );
}

export function describeDerivationDetectorContract(
  factory: DerivationDetectorContractFactory,
  fixtures: readonly DerivationDetectorContractFixture[],
): void {
  describe("DerivationDetector contract", () => {
    test("exposes one safe immutable closed descriptor", async () => {
      const detector = await factory();
      expect(Object.isFrozen(detector.descriptor)).toBe(true);
      expect(Object.keys(detector.descriptor).sort()).toEqual(
        [
          "configurationDigest",
          "id",
          "implementationDigest",
          "reproducibility",
          "version",
        ].filter((key) =>
          key !== "configurationDigest"
            ? true
            : detector.descriptor.configurationDigest !== undefined,
        ).sort(),
      );
      expect(detector.descriptor.implementationDigest).toMatch(
        /^sha256:[a-f0-9]{64}$/u,
      );
      if (detector.descriptor.configurationDigest !== undefined) {
        expect(detector.descriptor.configurationDigest).toMatch(
          /^sha256:[a-f0-9]{64}$/u,
        );
      }
    });

    test.each(fixtures)(
      "emits valid stable findings for $surface.surfaceId",
      async ({ surface, expectedClasses = [] }) => {
        const detector = await factory();
        const before = structuredClone(surface);
        const first = normalizeDetectorFindings(
          surface,
          await detector.detect(surface),
          detector.descriptor,
        );
        expect(surface).toEqual(before);
        expect(first.map((finding) => finding.class)).toEqual(
          expect.arrayContaining([...expectedClasses]),
        );
        for (const finding of first) {
          const plaintext = surface.text.slice(finding.start, finding.end);
          expect(finding.evidence.join("\n")).not.toContain(plaintext);
        }
        const second = normalizeDetectorFindings(
          surface,
          await detector.detect(surface),
          detector.descriptor,
        );
        if (detector.descriptor.reproducibility === "byte-stable") {
          expect(second).toEqual(first);
        } else {
          for (const finding of second) {
            expect(finding.detector.reproducibility).toBe("best-effort");
          }
        }
      },
    );

    test("honors an already-aborted operation", async () => {
      const detector = await factory();
      const controller = new AbortController();
      controller.abort();
      const operation: DerivationOperationOptions = {
        signal: controller.signal,
      };
      await expect(
        detector.detect(fixtures[0]!.surface, operation),
      ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    });
  });
}

export function describeEvidenceDeriverContract(
  factory: EvidenceDeriverContractFactory,
): void {
  describe("EvidenceDeriver contract", () => {
    test("verifies source, artifact, and protocol integrity", async () => {
      const deriver = await factory();
      const badRecord = syntheticDerivationInput();
      badRecord.sourceRecord.bytes[0] ^= 1;
      await expect(deriver.derive(badRecord)).rejects.toMatchObject({
        code: "SOURCE_DIGEST_MISMATCH",
      });

      const badArtifact = syntheticDerivationInput();
      badArtifact.sourceArtifacts[0]!.bytes[0] ^= 1;
      await expect(deriver.derive(badArtifact)).rejects.toMatchObject({
        code: "ARTIFACT_DIGEST_MISMATCH",
      });

      const nonconforming = syntheticDerivationInput();
      (nonconforming.sourceRecord as { bytes: Uint8Array }).bytes =
        new TextEncoder().encode("{}");
      (
        nonconforming.sourceRecord.reference as {
          digest: `sha256:${string}`;
        }
      ).digest = recordDigest(nonconforming.sourceRecord.bytes);
      await expect(deriver.derive(nonconforming)).rejects.toMatchObject({
        code: "SOURCE_NONCONFORMING",
      });
    });

    test("returns exact unchanged bytes and exact claim applicability", async () => {
      const deriver = await factory();
      const input = retainPolicyInput();
      const inputBefore = structuredClone(input);
      const outcome = await deriver.derive(input);
      expect(input).toEqual(inputBefore);
      expect(outcome.status).toBe("publishable-unchanged");
      if (outcome.status !== "publishable-unchanged") return;
      expect(outcome.record.bytes).toEqual(input.sourceRecord.bytes);
      expect(outcome.record.reference).toEqual(input.sourceRecord.reference);
      expect(outcome.bindingImpact).toEqual({
        executionVerification: "existing-verification-applicable",
        resultEvaluation: "preserved-for-exact-subjects",
        taskDerived: false,
        resultDerived: false,
      });
    });

    test("builds a conforming derivative without rewriting historical roles", async () => {
      const deriver = await factory();
      const input = syntheticDerivationInput();
      const sourceDocument = decodeDocument(input.sourceRecord.bytes);
      const outcome = await deriver.derive(input);
      expect(outcome.status).toBe("derived");
      if (outcome.status !== "derived") return;
      const report = validateExecutionEvidence(outcome.record.bytes);
      expect(report.conforms).toBe(true);
      expect(
        checkArtifactIntegrity(
          report.value!,
          physicalArtifacts(outcome.artifacts),
        ).mismatched,
      ).toBe(0);
      expect(outcome.record.reference.digest).not.toBe(
        input.sourceRecord.reference.digest,
      );

      const publicDocument = decodeDocument(outcome.record.bytes);
      const sourceExecution = findPrimaryExecution(sourceDocument);
      const publicExecution = findPrimaryExecution(publicDocument);
      expect(publicExecution["@id"]).toBe(sourceExecution["@id"]);
      for (const role of ["object", "result", "instrument", "subjectOf"]) {
        expect(publicExecution[role]).toEqual(sourceExecution[role]);
        expect(JSON.stringify(publicExecution[role])).not.toContain(
          "derived/",
        );
      }
      const graph = publicDocument["@graph"] as Array<Record<string, unknown>>;
      const ids = new Set(graph.map((entity) => entity["@id"]));
      const sourceGraph = sourceDocument["@graph"] as Array<
        Record<string, unknown>
      >;
      for (const sourceEntity of sourceGraph) {
        if (typeof sourceEntity.sha256 !== "string") continue;
        expect(
          graph.find(
            (candidate) => candidate["@id"] === sourceEntity["@id"],
          )?.sha256,
        ).toBe(sourceEntity.sha256);
      }
      for (const required of [
        "./",
        "private/ro-crate-metadata.json",
        "provenance/derivation-policy.json",
        "provenance/scrubber-implementation.json",
        "provenance/scrub-receipt.json",
        "#public-derivation",
        "urn:uuid:33333333-3333-4333-8333-333333333333",
      ]) {
        expect(ids).toContain(required);
      }
      const root = graph.find((entity) => entity["@id"] === "./")!;
      expect(JSON.stringify(root.hasPart)).not.toContain(
        "private/ro-crate-metadata.json",
      );
      expect(outcome.bindingImpact.executionVerification).toBe(
        "not-transferred-to-derived-record",
      );
      const receipt = parseScrubReceipt(outcome.receipt.bytes).value;
      expect(receipt.sourceRecord).toEqual(input.sourceRecord.reference);
      expect(receipt.artifacts.retained + receipt.artifacts.derived +
        receipt.artifacts.withheld).toBeGreaterThan(0);
      expect(receipt.mappings.length).toBe(
        outcome.artifacts.filter(({ kind }) => kind === "derived").length,
      );
    });

    test("publishes commitments but no synthetic private values", async () => {
      const outcome = await (await factory()).derive(
        syntheticDerivationInput(),
      );
      expect(outcome.status).toBe("derived");
      if (outcome.status !== "derived") return;
      const publicBytes = [
        outcome.record.bytes,
        ...outcome.artifacts.map(({ bytes }) => bytes),
      ];
      const serialized = publicBytes
        .map((bytes) => new TextDecoder().decode(bytes))
        .join("\n");
      for (const privateValue of [
        SYNTHETIC_PRIVATE_VALUES.knownIdentity,
        SYNTHETIC_PRIVATE_VALUES.privateAllowlist,
        SYNTHETIC_PRIVATE_VALUES.nonce,
        "/home/example-user/work",
        "operator-box",
        "DEVICE-8F3A",
        "AWS_SECRET_ACCESS_KEY",
        "sk-synthetic-not-a-real-secret-1234567890",
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
      const receipt = parseScrubReceipt(outcome.receipt.bytes);
      expect(receipt.value.privateConfigurationDigests.length).toBeGreaterThan(
        0,
      );
      expect(serialized).not.toContain(outcome.record.reference.digest);
    });

    test("returns review and withholding without publishable bytes", async () => {
      const deriver = await factory();
      const review = await deriver.derive(reviewPolicyInput());
      expect(review.status).toBe("review-required");
      expect("record" in review).toBe(false);
      expect("artifacts" in review).toBe(false);

      const withheldInput = syntheticDerivationInput();
      const policy = baselinePolicyValue();
      (
        policy.protectedValueDispositions as Record<
          string,
          "retain" | "withhold-record"
        >
      )["agent-iri"] = "withhold-record";
      (withheldInput as { policyBytes: Uint8Array }).policyBytes =
        canonicalJsonBytes(policy);
      const withheld = await deriver.derive(withheldInput);
      expect(withheld).toEqual({
        status: "withheld",
        reasons: [
          {
            code: "protected-value-withheld",
            protectedClass: "agent-iri",
          },
        ],
      });
      expect("record" in withheld).toBe(false);
      expect("artifacts" in withheld).toBe(false);
    });

    test("is byte-stable, returns defensive copies, and honors cancellation", async () => {
      const deriver = await factory();
      const first = await deriver.derive(syntheticDerivationInput());
      const second = await deriver.derive(syntheticDerivationInput());
      expect(second).toEqual(first);
      expect(first.status).toBe("derived");
      if (first.status === "derived") {
        first.record.bytes.fill(0);
        first.artifacts[0]!.bytes.fill(0);
        first.receipt.bytes.fill(0);
        const repeated = await deriver.derive(syntheticDerivationInput());
        expect(repeated.status).toBe("derived");
        if (repeated.status === "derived") {
          expect(repeated.record.reference.digest).toBe(
            second.status === "derived"
              ? second.record.reference.digest
              : "impossible",
          );
          expect(sha256Digest(repeated.record.bytes)).toBe(
            repeated.record.reference.digest,
          );
        }
      }

      const controller = new AbortController();
      controller.abort();
      await expect(
        deriver.derive(syntheticDerivationInput(), {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    });
  });
}

export function copySyntheticBytes(bytes: Uint8Array): Uint8Array {
  return copyBytes(bytes);
}
