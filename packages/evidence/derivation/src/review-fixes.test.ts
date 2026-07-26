// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import { transformSourceArtifacts } from "./artifact-transform.js";
import { canonicalJsonBytes, sha256Digest } from "./bytes.js";
import {
  createBuiltinDerivationDetectors,
  normalizeDetectorFindings,
} from "./detectors/index.js";
import { createEvidenceDeriver } from "./derive.js";
import { applyDerivationDispositions } from "./disposition.js";
import {
  baselinePolicyValue,
  SYNTHETIC_PRIVATE_VALUES,
  syntheticDerivationInput,
} from "./fixtures.js";
import { parseDerivationPolicy } from "./policy.js";
import { parseScrubberImplementationDescriptor } from "./receipt.js";
import { validateDerivationSource } from "./source.js";
import { extractDerivationSurfaces } from "./surfaces.js";
import type {
  DerivationDetector,
  DerivationFinding,
  DerivationSurface,
} from "./types.js";

const privateConfiguration = {
  schemaVersion: "jinn.private-detector-configuration.v1" as const,
  nonce: SYNTHETIC_PRIVATE_VALUES.nonce,
  knownIdentities: [SYNTHETIC_PRIVATE_VALUES.knownIdentity],
  privateAllowlist: [SYNTHETIC_PRIVATE_VALUES.privateAllowlist],
};

function replacePolicy(
  input: ReturnType<typeof syntheticDerivationInput>,
  mutate: (policy: ReturnType<typeof baselinePolicyValue>) => void,
): void {
  const policy = baselinePolicyValue();
  mutate(policy);
  (input as { policyBytes: Uint8Array }).policyBytes =
    canonicalJsonBytes(policy);
}

function replaceArtifact(
  input: ReturnType<typeof syntheticDerivationInput>,
  entityId: string,
  bytes: Uint8Array,
): void {
  const artifact = input.sourceArtifacts.find(
    (candidate) => candidate.entityId === entityId,
  );
  if (!artifact) throw new Error(`missing fixture artifact ${entityId}`);
  (artifact as { bytes: Uint8Array }).bytes = bytes;
  const document = JSON.parse(new TextDecoder().decode(input.sourceRecord.bytes));
  document["@graph"].find(
    (candidate: Record<string, unknown>) => candidate["@id"] === entityId,
  ).sha256 = sha256Digest(bytes).slice("sha256:".length);
  (input.sourceRecord as { bytes: Uint8Array }).bytes = new TextEncoder().encode(
    `${JSON.stringify(document, null, 2)}\n`,
  );
  (input.sourceRecord.reference as { digest: `sha256:${string}` }).digest =
    sha256Digest(input.sourceRecord.bytes);
}

function surface(text: string): DerivationSurface {
  return Object.freeze({
    surfaceId: "artifact:test:text",
    sourceEntityId: "test",
    role: "other",
    mediaType: "text/plain",
    codec: "text",
    location: "",
    text,
  });
}

test("the deterministic safety floor detects its required semantic classes", async () => {
  const detectors = createBuiltinDerivationDetectors({ privateConfiguration });
  const examples = [
    [
      "abandon ability able about above absent absorb abstract absurd abuse access accident",
      "funds-controlling-secret",
    ],
    ["Wire GB82 WEST 1234 5698 7654 32", "payment-instrument"],
    [`npm_${"aB3".repeat(12)}`, "credential"],
    ["opaque Ab3Def5Gh7Jk9Lm2Np4Qr6St8Uv0Xy1Z", "credential"],
  ] as const;
  for (const [text, findingClass] of examples) {
    const findings = (
      await Promise.all(detectors.map((detector) => detector.detect(surface(text))))
    ).flat();
    expect(findings.map((finding) => finding.class)).toContain(findingClass);
  }
});

test("private allowlist behavior is applied and committed without disclosure", async () => {
  const detectors = createBuiltinDerivationDetectors({ privateConfiguration });
  const serialized = JSON.stringify(
    detectors.map(({ descriptor }) => descriptor),
  );
  expect(serialized).not.toContain(SYNTHETIC_PRIVATE_VALUES.privateAllowlist);
  expect(serialized).not.toContain(SYNTHETIC_PRIVATE_VALUES.nonce);
  const findings = (
    await Promise.all(
      detectors.map((detector) =>
        detector.detect(
          surface(`hostname: ${SYNTHETIC_PRIVATE_VALUES.privateAllowlist}`),
        ),
      ),
    )
  ).flat();
  expect(findings).toEqual([]);
});

test("an unmatched finding class fails closed instead of implicitly retaining", () => {
  const policy = structuredClone(parseDerivationPolicy(
    canonicalJsonBytes(baselinePolicyValue()),
  ).value);
  const exactSurface = surface("private");
  const descriptor = policy.requiredDetectors[0]!;
  const finding: DerivationFinding = {
    class: "unconfigured-private-class",
    confidence: "VERY_LOW",
    surfaceId: exactSurface.surfaceId,
    start: 0,
    end: exactSurface.text.length,
    evidence: ["unconfigured-class"],
    detector: descriptor,
  };
  expect(
    applyDerivationDispositions(exactSurface, [finding], policy),
  ).toEqual({
    status: "withhold-record",
    reasons: [{ code: "finding-disposition-unavailable" }],
  });
  (
    policy as {
      unmatchedFindingDisposition: "review" | "withhold-record";
    }
  ).unmatchedFindingDisposition = "review";
  expect(
    applyDerivationDispositions(exactSurface, [finding], policy),
  ).toEqual({
    status: "review-required",
    findings: [finding],
  });
});

test("an unavailable graph artifact evaluates its exact policy disposition", () => {
  const input = syntheticDerivationInput();
  const traceIndex = input.sourceArtifacts.findIndex(
    ({ entityId }) => entityId === "trace/trajectory.jsonl",
  );
  (input.sourceArtifacts as Array<unknown>).splice(traceIndex, 1);
  replacePolicy(input, (policy) => {
    (policy.artifactRules as Array<(typeof policy.artifactRules)[number]>)[0] = {
      ...policy.artifactRules[0]!,
      unavailable: "withhold-record",
    };
  });
  const source = validateDerivationSource(input);
  const policy = parseDerivationPolicy(input.policyBytes).value;
  expect(
    transformSourceArtifacts(
      source,
      extractDerivationSurfaces(source, policy),
      new Map(),
      policy,
    ),
  ).toEqual({
    status: "withhold-record",
    reasons: [{ code: "unavailable-artifact" }],
  });
});

test("protected execution and historical-role identities are classified before detectors", () => {
  const input = syntheticDerivationInput();
  const source = validateDerivationSource(input);
  const policy = parseDerivationPolicy(input.policyBytes).value;
  const classes = new Set(
    extractDerivationSurfaces(source, policy).protectedLocations.map(
      ({ protectedClass }) => protectedClass,
    ),
  );
  expect(classes).toContain("execution-iri");
  expect(classes).toContain("historical-role-identity");
  for (const protectedClass of [
    "execution-iri",
    "historical-role-identity",
  ] as const) {
    const held = structuredClone(policy);
    (
      held.protectedValueDispositions as Record<
        typeof protectedClass,
        "retain" | "withhold-record"
      >
    )[protectedClass] = "withhold-record";
    expect(extractDerivationSurfaces(source, held).hold).toEqual({
      code: "protected-value-withheld",
      protectedClass,
    });
  }
});

test("detectors and per-call surfaces are immutable snapshots", async () => {
  const input = syntheticDerivationInput();
  const builtins = createBuiltinDerivationDetectors({ privateConfiguration });
  const mutable: DerivationDetector[] = builtins.map((detector) => ({
    descriptor: { ...detector.descriptor },
    detect: detector.detect,
  }));
  const deriver = createEvidenceDeriver({ detectors: mutable });
  mutable[1]!.detect = async () => [];
  const outcome = await deriver.derive(input);
  expect(outcome.status).toBe("derived");

  const mutating: DerivationDetector = {
    descriptor: { ...builtins[0]!.descriptor },
    async detect(candidate) {
      expect(Reflect.set(candidate, "text", "")).toBe(false);
      return [];
    },
  };
  const immutableOutcome = await createEvidenceDeriver({
    detectors: [mutating, builtins[1]!],
  }).derive(syntheticDerivationInput());
  expect(immutableOutcome.status).toBe("derived");
});

test("normalization rejects a finding carrying another detector descriptor", () => {
  const exactSurface = surface("abc");
  const [expected] = createBuiltinDerivationDetectors({ privateConfiguration });
  const finding: DerivationFinding = {
    class: "email",
    confidence: "HIGH",
    surfaceId: exactSurface.surfaceId,
    start: 0,
    end: 3,
    evidence: ["email-shape"],
    detector: {
      ...expected!.descriptor,
      version: "different",
    },
  };
  expect(() =>
    normalizeDetectorFindings(
      exactSurface,
      [finding],
      expected!.descriptor,
    ),
  ).toThrowError(
    expect.objectContaining({ code: "DETECTOR_CONTRACT_VIOLATION" }),
  );
});

test("behavioral and proxy inputs fail before their traps or accessors execute", async () => {
  let trapCalls = 0;
  const proxied = new Proxy(syntheticDerivationInput(), {
    ownKeys() {
      trapCalls += 1;
      throw new Error("trap must not run");
    },
  });
  await expect(
    createEvidenceDeriver({
      detectors: createBuiltinDerivationDetectors({ privateConfiguration }),
    }).derive(proxied),
  ).rejects.toMatchObject({ code: "INVALID_DERIVATION_INPUT" });
  expect(trapCalls).toBe(0);

  const input = syntheticDerivationInput();
  Object.defineProperty(input, "completedAt", {
    enumerable: true,
    get() {
      throw new Error("getter must not run");
    },
  });
  await expect(
    createEvidenceDeriver({
      detectors: createBuiltinDerivationDetectors({ privateConfiguration }),
    }).derive(input),
  ).rejects.toMatchObject({ code: "INVALID_DERIVATION_INPUT" });
});

test("implementation descriptors reject ambient and operator-specific material", () => {
  const input = syntheticDerivationInput();
  const descriptor = JSON.parse(
    new TextDecoder().decode(input.scrubber.implementationDescriptorBytes),
  );
  for (const leak of [
    "/home/private-user/.config",
    "operator.internal.example",
    "DEVICE-8F3A",
    "AWS_SECRET_ACCESS_KEY",
    SYNTHETIC_PRIVATE_VALUES.nonce,
  ]) {
    const candidate = structuredClone(descriptor);
    candidate.name = leak;
    expect(() =>
      parseScrubberImplementationDescriptor(canonicalJsonBytes(candidate)),
    ).toThrowError(
      expect.objectContaining({ code: "SCRUBBER_DESCRIPTOR_INVALID" }),
    );
  }
});

test("declared JSON and JSONL reject duplicate keys and invalid UTF-8", () => {
  for (const bytes of [
    new TextEncoder().encode('{"value":"first","value":"second"}\n'),
    Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
  ]) {
    const input = syntheticDerivationInput();
    replaceArtifact(input, "trace/trajectory.jsonl", bytes);
    const source = validateDerivationSource(input);
    const policy = parseDerivationPolicy(input.policyBytes).value;
    expect(() => extractDerivationSurfaces(source, policy)).toThrowError(
      expect.objectContaining({ code: "STRUCTURED_ARTIFACT_INVALID" }),
    );
  }
});

test("cancellation is checked immediately after every awaited detector call", async () => {
  const controller = new AbortController();
  const detectors = createBuiltinDerivationDetectors({ privateConfiguration });
  const aborting: DerivationDetector = {
    descriptor: { ...detectors[0]!.descriptor },
    async detect() {
      await Promise.resolve();
      controller.abort();
      return [];
    },
  };
  await expect(
    createEvidenceDeriver({
      detectors: [aborting, detectors[1]!],
    }).derive(syntheticDerivationInput(), { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
});

test("derived metadata is recursively canonical and lists only physical hasPart bytes", async () => {
  const outcome = await createEvidenceDeriver({
    detectors: createBuiltinDerivationDetectors({ privateConfiguration }),
  }).derive(syntheticDerivationInput());
  expect(outcome.status).toBe("derived");
  if (outcome.status !== "derived") return;
  const document = JSON.parse(new TextDecoder().decode(outcome.record.bytes));
  expect(outcome.record.bytes).toEqual(canonicalJsonBytes(document));
  const root = document["@graph"].find(
    (candidate: Record<string, unknown>) => candidate["@id"] === "./",
  );
  const hasPart = root.hasPart.map(
    (candidate: Record<string, unknown>) => candidate["@id"],
  );
  expect(hasPart).not.toContain("private/ro-crate-metadata.json");
  const physical = new Set(outcome.artifacts.map(({ entityId }) => entityId));
  expect(hasPart.every((entityId: string) => physical.has(entityId))).toBe(true);
  const receipt = JSON.parse(new TextDecoder().decode(outcome.receipt.bytes));
  expect(
    receipt.dispositions.some(
      (entry: { disposition: string; count: number }) =>
        entry.disposition === "redact" && entry.count === 0,
    ),
  ).toBe(false);
});
