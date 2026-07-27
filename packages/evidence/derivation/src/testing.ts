// SPDX-License-Identifier: Apache-2.0

import {
  checkArtifactIntegrity,
  recordDigest,
  validateExecutionEvidence,
} from "@jinn-network/evidence-protocol";
import { describe, expect, test } from "vitest";

import { canonicalJsonBytes, copyBytes, sha256Digest } from "./bytes.js";
import {
  invokeContractDetector,
  snapshotDetectorContractSlot,
} from "./detector-contract-invocation.js";
import { normalizeDetectorFindings } from "./detectors/index.js";
import {
  baselinePolicyValue,
  syntheticDerivationInput,
  SYNTHETIC_PRIVATE_VALUES,
} from "./fixtures.js";
import { parseScrubReceipt } from "./receipt.js";
import { PROTECTED_VALUE_CLASSES } from "./types.js";
import type {
  DerivationDetector,
  DerivationDetectorDescriptor,
  DerivationFinding,
  DerivationOperationOptions,
  DerivationPolicy,
  DerivationSurface,
  DeriveExecutionEvidenceInput,
  EvidenceDeriver,
  ProtectedValueClass,
} from "./types.js";
import { compareCodeUnitStrings } from "./order.js";

export type EvidenceDeriverContractFactory = (
  detectors?: readonly DerivationDetector[],
) => EvidenceDeriver | Promise<EvidenceDeriver>;

export interface DerivationDetectorContractContext {
  readonly detector: DerivationDetector;
  readonly ambientEffectCount: () => number;
  readonly retainedSurfaceCount: () => number;
  readonly cleanup?: () => void | Promise<void>;
}

export type DerivationDetectorContractFactory = () =>
  | DerivationDetectorContractContext
  | Promise<DerivationDetectorContractContext>;

export interface DerivationDetectorContractFixture {
  readonly surface: DerivationSurface;
  readonly expectedClasses?: readonly string[];
}

async function withDetectorContractContext<T>(
  factory: DerivationDetectorContractFactory,
  exercise: (
    context: DerivationDetectorContractContext,
  ) => T | Promise<T>,
): Promise<T> {
  const providedContext = await factory();
  const context: DerivationDetectorContractContext = {
    detector: snapshotDetectorContractSlot(providedContext),
    ambientEffectCount: providedContext.ambientEffectCount,
    retainedSurfaceCount: providedContext.retainedSurfaceCount,
    ...(providedContext.cleanup
      ? { cleanup: providedContext.cleanup }
      : {}),
  };
  try {
    return await exercise(context);
  } finally {
    await context.cleanup?.();
  }
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
          `private marker amber; operator ${SYNTHETIC_PRIVATE_VALUES.knownIdentity}`,
        ),
        expectedClasses: Object.freeze(["known-identity"]),
      }),
      Object.freeze({
        surface: detectorSurface(
          "contract:known-identity-safe",
          "private marker cobalt; anonymous synthetic operator",
        ),
        expectedClasses: Object.freeze([]),
      }),
    ]),
    deterministicPatterns: Object.freeze([
      Object.freeze({
        surface: detectorSurface(
          "contract:patterns",
          "private marker saffron; email ada@example.invalid and card 4111 1111 1111 1111",
        ),
        expectedClasses: Object.freeze(["email", "payment-instrument"]),
      }),
      Object.freeze({
        surface: detectorSurface(
          "contract:technical-values",
          `private marker violet; sha256:${"a".repeat(64)} bafkreibm6jg3ux5qu3hbutfqc3hdoclhwd3bk4ufuyt7xzhsg7cdqs2m7a`,
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

function rewriteSyntheticRecord(
  input: DeriveExecutionEvidenceInput,
  mutate: (document: Record<string, unknown>) => void,
): void {
  const document = decodeDocument(input.sourceRecord.bytes);
  mutate(document);
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(document, null, 2)}\n`,
  );
  (input.sourceRecord as { bytes: Uint8Array }).bytes = bytes;
  (
    input.sourceRecord.reference as {
      digest: `sha256:${string}`;
    }
  ).digest = recordDigest(bytes);
}

function replaceSyntheticArtifact(
  input: DeriveExecutionEvidenceInput,
  entityId: string,
  bytes: Uint8Array,
): void {
  const artifact = input.sourceArtifacts.find(
    (candidate) => candidate.entityId === entityId,
  );
  if (!artifact) throw new Error(`missing synthetic artifact ${entityId}`);
  (artifact as { bytes: Uint8Array }).bytes = copyBytes(bytes);
  rewriteSyntheticRecord(input, (document) => {
    const graph = document["@graph"] as Array<Record<string, unknown>>;
    const entity = graph.find((candidate) => candidate["@id"] === entityId);
    if (!entity) throw new Error(`missing synthetic entity ${entityId}`);
    entity.sha256 = sha256Digest(bytes).slice("sha256:".length);
  });
}

function addSyntheticArtifact(
  input: DeriveExecutionEvidenceInput,
  entityId: string,
  mediaType: string,
  bytes: Uint8Array,
): void {
  (
    input.sourceArtifacts as Array<{
      entityId: string;
      bytes: Uint8Array;
    }>
  ).push({ entityId, bytes: copyBytes(bytes) });
  rewriteSyntheticRecord(input, (document) => {
    const graph = document["@graph"] as Array<Record<string, unknown>>;
    const root = graph.find((entity) => entity["@id"] === "./");
    if (!root) throw new Error("synthetic root is missing");
    (root.hasPart as Array<{ "@id": string }>).push({ "@id": entityId });
    graph.push({
      "@id": entityId,
      "@type": ["File", "CreativeWork"],
      name: "Synthetic signed envelope",
      encodingFormat: mediaType,
      sha256: sha256Digest(bytes).slice("sha256:".length),
      about: { "@id": "urn:uuid:22222222-2222-4222-8222-222222222222" },
    });
  });
}

function policyFor(input: DeriveExecutionEvidenceInput): DerivationPolicy & {
  artifactRules: Array<DerivationPolicy["artifactRules"][number]>;
  transformableMetadata: string[];
} {
  return JSON.parse(
    new TextDecoder().decode(input.policyBytes),
  ) as DerivationPolicy & {
    artifactRules: Array<DerivationPolicy["artifactRules"][number]>;
    transformableMetadata: string[];
  };
}

function installPolicy(
  input: DeriveExecutionEvidenceInput,
  policy: DerivationPolicy,
): void {
  (input as { policyBytes: Uint8Array }).policyBytes =
    canonicalJsonBytes(policy);
}

function tripwireDetectors(
  onDetect: () => void,
): readonly DerivationDetector[] {
  return Object.freeze(
    baselinePolicyValue().requiredDetectors.map((descriptor) =>
      Object.freeze({
        descriptor: Object.freeze({ ...descriptor }),
        async detect() {
          onDetect();
          throw new Error("protected values must bypass detectors");
        },
      }),
    ),
  );
}

function signedArtifactInput(retain: boolean): {
  readonly input: DeriveExecutionEvidenceInput;
  readonly entityId: string;
  readonly bytes: Uint8Array;
} {
  const input = syntheticDerivationInput();
  const entityId = "claims/synthetic-envelope.dsse.json";
  const bytes = canonicalJsonBytes({
    payloadType: "application/vnd.in-toto+json",
    payload: "eyJjb250cmFjdCI6InNpZ25lZCJ9",
    signatures: [{ keyid: "contract-key", sig: "c2lnbmVkLWNvbnRyYWN0" }],
  });
  const mediaType = "application/vnd.dsse.envelope.v1+json";
  addSyntheticArtifact(input, entityId, mediaType, bytes);
  if (retain) {
    const policy = policyFor(input);
    policy.artifactRules.unshift({
      mediaType,
      roles: ["evidence"],
      codec: "signed",
      unavailable: "retain-commitment",
    });
    installPolicy(input, policy);
  }
  return { input, entityId, bytes };
}

function sensitiveMetadataInput(
  mixed: boolean,
): {
  readonly input: DeriveExecutionEvidenceInput;
  readonly sensitiveValues: readonly string[];
} {
  const input = syntheticDerivationInput();
  const sensitiveValues = [
    SYNTHETIC_PRIVATE_VALUES.knownIdentity,
    "contract-owner@example.invalid",
    "/home/contract-owner/failure.log",
    `npm_${"aB3".repeat(12)}`,
    "hostname: contract-private-machine",
  ] as const;
  rewriteSyntheticRecord(input, (document) => {
    const graph = document["@graph"] as Array<Record<string, unknown>>;
    const task = graph.find((entity) => entity["@id"] === "task/task.md")!;
    task.name = sensitiveValues[0];
    task.description = sensitiveValues[1];
    task.publicNote = sensitiveValues[4];
    const execution = findPrimaryExecution(document);
    execution.error = sensitiveValues[2];
    const propertyValue = graph.find(
      (entity) => entity["@id"] === "#duration-ms",
    );
    if (!propertyValue) throw new Error("synthetic PropertyValue is missing");
    graph.push({
      "@id": "#contract-sensitive-property",
      "@type": "PropertyValue",
      name: "Contract-sensitive property",
      propertyID: "https://example.invalid/contract-sensitive-property",
      value: sensitiveValues[3],
    });
  });
  const policy = policyFor(input);
  policy.transformableMetadata.push("/@graph/*/publicNote");
  installPolicy(input, policy);
  if (!mixed) {
    replaceSyntheticArtifact(
      input,
      "trace/trajectory.jsonl",
      new TextEncoder().encode(
        `${JSON.stringify({
          event: "tool",
          digest: `sha256:${"a".repeat(64)}`,
          cid: "bafkreibm6jg3ux5qu3hbutfqc3hdoclhwd3bk4ufuyt7xzhsg7cdqs2m7a",
        })}\n`,
      ),
    );
  }
  return { input, sensitiveValues };
}

function protectedClassInput(
  protectedClass: ProtectedValueClass,
): DeriveExecutionEvidenceInput {
  const input = syntheticDerivationInput();
  const policy = policyFor(input);
  if (protectedClass === "derivation-commitment") {
    const bytes = canonicalJsonBytes({ synthetic: "commitment" });
    addSyntheticArtifact(
      input,
      "provenance/derivation-policy.json",
      "application/json",
      bytes,
    );
  }
  if (protectedClass === "policy-protected-property") {
    policy.transformableMetadata = policy.transformableMetadata.filter(
      (selector) => selector !== "/@graph/*/name",
    );
    (
      policy as unknown as {
        protectedMetadata: string[];
      }
    ).protectedMetadata = ["/@graph/*/name"];
  }
  (
    policy.protectedValueDispositions as Record<
      ProtectedValueClass,
      "retain" | "withhold-record"
    >
  )[protectedClass] = "withhold-record";
  installPolicy(input, policy);
  return input;
}

function bestEffortFixture(): {
  readonly input: DeriveExecutionEvidenceInput;
  readonly detectors: readonly DerivationDetector[];
} {
  const input = syntheticDerivationInput();
  const required = baselinePolicyValue().requiredDetectors;
  const descriptors = required.map((descriptor, index) =>
    Object.freeze({
      ...descriptor,
      implementationDigest:
        `sha256:${String(index + 7).repeat(64).slice(0, 64)}` as const,
      reproducibility:
        index === 0 ? "byte-stable" as const : "best-effort" as const,
    }),
  );
  const detectors = descriptors.map((descriptor, index) =>
    Object.freeze({
      descriptor,
      async detect(surface: DerivationSurface) {
        if (index !== 1) {
          return Object.freeze([] as DerivationFinding[]);
        }
        const start = surface.text.indexOf("Synthetic");
        if (start < 0) {
          return Object.freeze([] as DerivationFinding[]);
        }
        return Object.freeze([
          Object.freeze({
            class: "known-identity",
            confidence: "HIGH",
            surfaceId: surface.surfaceId,
            start,
            end: start + "Synthetic".length,
            evidence: Object.freeze(["contract-best-effort"]),
            detector: descriptor,
          }),
        ]);
      },
    }),
  );
  const policy = policyFor(input);
  (
    policy as {
      reproducibility: "byte-stable" | "content-addressed";
    }
  ).reproducibility = "content-addressed";
  (
    policy as unknown as {
      requiredDetectors: DerivationDetectorDescriptor[];
    }
  ).requiredDetectors = descriptors;
  installPolicy(input, policy);
  const implementation = JSON.parse(
    new TextDecoder().decode(input.scrubber.implementationDescriptorBytes),
  ) as Record<string, unknown>;
  implementation.detectors = descriptors;
  (
    input.scrubber as {
      implementationDescriptorBytes: Uint8Array;
    }
  ).implementationDescriptorBytes = canonicalJsonBytes(implementation);
  return { input, detectors };
}

export function describeDerivationDetectorContract(
  factory: DerivationDetectorContractFactory,
  fixtures: readonly DerivationDetectorContractFixture[],
): void {
  describe("DerivationDetector contract", () => {
    test("exposes one safe immutable closed descriptor", async () => {
      await withDetectorContractContext(factory, async (context) => {
        const { detector } = context;
        const descriptor = detector.descriptor;
        const snapshot = structuredClone(descriptor);
        expect(Object.isFrozen(descriptor)).toBe(true);
        expect(Object.keys(descriptor).sort()).toEqual(
          [
            "configurationDigest",
            "id",
            "implementationDigest",
            "reproducibility",
            "version",
          ].filter((key) =>
            key !== "configurationDigest"
              ? true
              : descriptor.configurationDigest !== undefined,
          ).sort(),
        );
        for (const property of Object.values(
          Object.getOwnPropertyDescriptors(descriptor),
        )) {
          expect("value" in property).toBe(true);
          expect(property.configurable).toBe(false);
          expect(property.writable).toBe(false);
        }
        expect(descriptor.implementationDigest).toMatch(
          /^sha256:[a-f0-9]{64}$/u,
        );
        if (descriptor.configurationDigest !== undefined) {
          expect(descriptor.configurationDigest).toMatch(
            /^sha256:[a-f0-9]{64}$/u,
          );
        }
        await invokeContractDetector(context, fixtures[0]!.surface);
        expect(detector.descriptor).toBe(descriptor);
        expect(detector.descriptor).toEqual(snapshot);
      });
    });

    test.each(fixtures)(
      "emits valid stable findings for $surface.surfaceId",
      async ({ surface, expectedClasses = [] }) => {
        await withDetectorContractContext(factory, async (context) => {
          const { detector } = context;
          const descriptor = detector.descriptor;
          const before = structuredClone(surface);
          const rawFirst = await invokeContractDetector(context, surface);
          const first = normalizeDetectorFindings(
            surface,
            rawFirst,
            descriptor,
          );
          expect(surface).toEqual(before);
          expect(detector.descriptor).toBe(descriptor);
          expect(first.map((finding) => finding.class)).toEqual(
            expect.arrayContaining([...expectedClasses]),
          );
          for (const finding of first) {
            const plaintext = surface.text.slice(finding.start, finding.end);
            expect(finding.evidence.join("\n")).not.toContain(plaintext);
            expect(finding.detector).toEqual(descriptor);
          }
          const rawSecond = await invokeContractDetector(context, surface);
          const second = normalizeDetectorFindings(
            surface,
            rawSecond,
            descriptor,
          );
          expect(detector.descriptor).toBe(descriptor);
          if (descriptor.reproducibility === "byte-stable") {
            expect(rawSecond).toEqual(rawFirst);
            expect(second).toEqual(first);
          } else {
            for (const finding of second) {
              expect(finding.detector.reproducibility).toBe("best-effort");
            }
          }
        });
      },
    );

    test("honors an already-aborted operation", async () => {
      await withDetectorContractContext(factory, async (context) => {
        const controller = new AbortController();
        controller.abort();
        const operation: DerivationOperationOptions = {
          signal: controller.signal,
        };
        await expect(
          invokeContractDetector(context, fixtures[0]!.surface, operation),
        ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
      });
    });

    test("honors cancellation while detection is in flight", async () => {
      await withDetectorContractContext(factory, async (context) => {
        const controller = new AbortController();
        const pending = invokeContractDetector(
          context,
          fixtures[0]!.surface,
          { signal: controller.signal },
        );
        controller.abort();
        await expect(pending).rejects.toMatchObject({
          code: "OPERATION_ABORTED",
        });
      });
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
      expect(
        outcome.artifacts.map(({ entityId, digest, bytes, kind }) => ({
          entityId,
          digest,
          bytes,
          kind,
        })),
      ).toEqual(
        [...input.sourceArtifacts]
          .sort((left, right) => compareCodeUnitStrings(left.entityId, right.entityId))
          .map(({ entityId, bytes }) => ({
            entityId,
            digest: sha256Digest(bytes),
            bytes,
            kind: "retained",
          })),
      );
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
      for (const entityId of [
        "task/task.md",
        "results/result.patch",
        "runtime/runtime-specification.json",
        "trace/trajectory.jsonl",
        "inputs/base-tree.txt",
      ]) {
        expect(
          graph.find((entity) => entity["@id"] === entityId)?.sha256,
        ).toBe(
          sourceGraph.find((entity) => entity["@id"] === entityId)?.sha256,
        );
      }
      const traceMapping = receipt.mappings.find(
        (mapping) => mapping.sourceEntityId === "trace/trajectory.jsonl",
      );
      expect(traceMapping).toBeDefined();
      const publicTrace = outcome.artifacts.find(
        (artifact) => artifact.entityId === traceMapping?.derivedEntityId,
      );
      expect(publicTrace).toBeDefined();
      const publicTraceText = new TextDecoder().decode(publicTrace?.bytes);
      for (const technicalValue of [
        `sha256:${"a".repeat(64)}`,
        `0x${"b".repeat(64)}`,
        "bafkreibm6jg3ux5qu3hbutfqc3hdoclhwd3bk4ufuyt7xzhsg7cdqs2m7a",
        "eyJzeW50aGV0aWMiOnRydWV9",
        "c2lnbmF0dXJl",
        "1.2.3",
        "example/model-v1",
      ]) {
        expect(publicTraceText).toContain(technicalValue);
      }
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

    test("retains signed artifacts byte-for-byte or withholds them", async () => {
      const retainedFixture = signedArtifactInput(true);
      const retained = await (await factory()).derive(retainedFixture.input);
      expect(["derived", "publishable-unchanged"]).toContain(retained.status);
      if (
        retained.status !== "derived" &&
        retained.status !== "publishable-unchanged"
      ) {
        return;
      }
      const retainedArtifact = retained.artifacts.find(
        ({ entityId }) => entityId === retainedFixture.entityId,
      );
      expect(retainedArtifact?.bytes).toEqual(retainedFixture.bytes);
      expect(retainedArtifact?.digest).toBe(
        sha256Digest(retainedFixture.bytes),
      );
      expect(retainedArtifact?.kind).toBe("retained");

      const withheldFixture = signedArtifactInput(false);
      const withheld = await (await factory()).derive(withheldFixture.input);
      expect(withheld.status).toBe("derived");
      if (withheld.status !== "derived") return;
      expect(
        withheld.artifacts.some(
          ({ entityId }) => entityId === withheldFixture.entityId,
        ),
      ).toBe(false);
      const document = decodeDocument(withheld.record.bytes);
      const root = (document["@graph"] as Array<Record<string, unknown>>).find(
        (entity) => entity["@id"] === "./",
      )!;
      expect(JSON.stringify(root.hasPart)).not.toContain(
        withheldFixture.entityId,
      );
      expect(
        [
          withheld.record.bytes,
          ...withheld.artifacts.map(({ bytes }) => bytes),
        ].some((bytes) =>
          new TextDecoder().decode(bytes).includes(
            new TextDecoder().decode(withheldFixture.bytes),
          ),
        ),
      ).toBe(false);
    });

    test("rejects malformed declared structured artifacts", async () => {
      const input = syntheticDerivationInput();
      replaceSyntheticArtifact(
        input,
        "trace/trajectory.jsonl",
        new TextEncoder().encode('{"event":"unterminated"\n'),
      );
      await expect((await factory()).derive(input)).rejects.toMatchObject({
        code: "STRUCTURED_ARTIFACT_INVALID",
      });
    });

    test.each(PROTECTED_VALUE_CLASSES)(
      "withholds protected class %s before detector invocation",
      async (protectedClass) => {
        let calls = 0;
        const outcome = await (
          await factory(tripwireDetectors(() => {
            calls += 1;
          }))
        ).derive(protectedClassInput(protectedClass));
        expect(outcome).toEqual({
          status: "withheld",
          reasons: [
            {
              code: "protected-value-withheld",
              protectedClass,
            },
          ],
        });
        expect(calls).toBe(0);
      },
    );

    test.each([
      ["graph", { "@graph": [{ value: "contract-private-graph" }] }],
      [
        "list and graph",
        {
          "@list": [
            { "@graph": [{ value: "contract-private-list-graph" }] },
          ],
        },
      ],
      [
        "set and graph",
        {
          "@set": [
            { "@graph": [{ value: "contract-private-set-graph" }] },
          ],
        },
      ],
    ] as const)(
      "withholds nested unknown extension %s without leaking it",
      async (_name, extension) => {
        const input = syntheticDerivationInput();
        rewriteSyntheticRecord(input, (document) => {
          const root = (
            document["@graph"] as Array<Record<string, unknown>>
          ).find((entity) => entity["@id"] === "./")!;
          root["x-private-contract-extension"] = extension;
        });
        const outcome = await (await factory()).derive(input);
        expect(outcome.status).toBe("withheld");
        expect(JSON.stringify(outcome)).not.toContain("contract-private");
        expect(JSON.stringify(outcome)).not.toContain(
          "x-private-contract-extension",
        );
        expect("record" in outcome).toBe(false);
      },
    );

    test.each([
      ["metadata-only", false],
      ["mixed metadata and artifact", true],
    ] as const)(
      "applies exact %s pointer transformations",
      async (_name, mixed) => {
        const fixture = sensitiveMetadataInput(mixed);
        const outcome = await (await factory()).derive(fixture.input);
        expect(outcome.status).toBe("derived");
        if (outcome.status !== "derived") return;
        const document = decodeDocument(outcome.record.bytes);
        const graph = document["@graph"] as Array<Record<string, unknown>>;
        const task = graph.find(
          (entity) => entity["@id"] === "task/task.md",
        )!;
        const execution = findPrimaryExecution(document);
        const propertyValue = graph.find(
          (entity) => entity["@id"] === "#contract-sensitive-property",
        )!;
        expect(task.name).toBe("[REDACTED_IDENTITY]");
        expect(task.description).toBe("[REDACTED_EMAIL]");
        expect(task.publicNote).toBe("[REDACTED_MACHINE]");
        expect(execution.error).toBe("[REDACTED_PATH]/failure.log");
        expect(propertyValue.value).toBe("[REDACTED_CREDENTIAL]");
        for (const sensitive of fixture.sensitiveValues) {
          expect(new TextDecoder().decode(outcome.record.bytes)).not.toContain(
            sensitive,
          );
        }
        const derivedSourceIds = new Set(
          parseScrubReceipt(outcome.receipt.bytes).value.mappings.map(
            ({ sourceEntityId }) => sourceEntityId,
          ),
        );
        expect(derivedSourceIds.has("trace/trajectory.jsonl")).toBe(mixed);
      },
    );

    test("grades best-effort detector participation as content-addressed", async () => {
      const fixture = bestEffortFixture();
      const outcome = await (
        await factory(fixture.detectors)
      ).derive(fixture.input);
      expect(outcome.status).toBe("derived");
      if (outcome.status !== "derived") return;
      expect(
        parseScrubReceipt(outcome.receipt.bytes).value.reproducibility,
      ).toBe("content-addressed");
    });

    test("withholds content-free when an injected required detector rejects", async () => {
      const privateRejection = "contract-private-required-detector-rejection";
      const detectors = baselinePolicyValue().requiredDetectors.map(
        (descriptor, index) =>
          Object.freeze({
            descriptor: Object.freeze({ ...descriptor }),
            async detect() {
              if (index === 0) throw new Error(privateRejection);
              return Object.freeze([] as DerivationFinding[]);
            },
          }),
      );
      const outcome = await (
        await factory(detectors)
      ).derive(syntheticDerivationInput());
      expect(outcome).toEqual({
        status: "withheld",
        reasons: [{ code: "required-detector-failed" }],
      });
      expect("record" in outcome).toBe(false);
      expect("artifacts" in outcome).toBe(false);
      expect("receipt" in outcome).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain(privateRejection);
    });

    test.each([
      ["task/task.md", true, false],
      ["results/result.patch", false, true],
    ] as const)(
      "reports broken Result Evaluation transfer when %s is derived",
      async (entityId, taskDerived, resultDerived) => {
        const input = syntheticDerivationInput();
        replaceSyntheticArtifact(
          input,
          entityId,
          new TextEncoder().encode(
            `contact subject-owner@example.invalid in ${entityId}\n`,
          ),
        );
        const outcome = await (await factory()).derive(input);
        expect(outcome.status).toBe("derived");
        if (outcome.status !== "derived") return;
        expect(outcome.bindingImpact).toEqual({
          executionVerification: "not-transferred-to-derived-record",
          resultEvaluation: "not-transferable-to-derived-subject",
          taskDerived,
          resultDerived,
        });
        expect(
          parseScrubReceipt(outcome.receipt.bytes).value.bindingImpact,
        ).toEqual(outcome.bindingImpact);
      },
    );

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

    test("honors cancellation after every detector await boundary", async () => {
      let totalCalls = 0;
      const descriptors = baselinePolicyValue().requiredDetectors;
      const counting = descriptors.map((descriptor) =>
        Object.freeze({
          descriptor: Object.freeze({ ...descriptor }),
          async detect() {
            totalCalls += 1;
            return Object.freeze([] as DerivationFinding[]);
          },
        }),
      );
      await (await factory(counting)).derive(syntheticDerivationInput());
      expect(totalCalls).toBeGreaterThan(0);

      for (let abortAt = 1; abortAt <= totalCalls; abortAt += 1) {
        const controller = new AbortController();
        let calls = 0;
        const aborting = descriptors.map((descriptor) =>
          Object.freeze({
            descriptor: Object.freeze({ ...descriptor }),
            async detect() {
              calls += 1;
              if (calls === abortAt) controller.abort();
              return Object.freeze([] as DerivationFinding[]);
            },
          }),
        );
        await expect(
          (await factory(aborting)).derive(syntheticDerivationInput(), {
            signal: controller.signal,
          }),
        ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
      }
    });
  });
}

export function copySyntheticBytes(bytes: Uint8Array): Uint8Array {
  return copyBytes(bytes);
}
