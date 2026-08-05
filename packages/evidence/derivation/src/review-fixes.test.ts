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
import { classifyTechnicalValue } from "./technical-values.js";
import type {
  DerivationDetector,
  DerivationFinding,
  DerivationSurface,
} from "./types.js";
import { PROTECTED_VALUE_CLASSES } from "./types.js";

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
    [
      "opaque Ab3Def5Gh7Jk9Lm2Np4Qr6St8Uv0Xy1Z",
      "high-entropy-secret",
    ],
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
    ({ entityId }) => entityId === "trace/trace.jsonl",
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

test("derivation rejects a detector span that splits an astral character without returning output", async () => {
  const input = syntheticDerivationInput();
  const text = "😀 private value";
  replaceArtifact(input, "task/task.md", new TextEncoder().encode(text));
  const detectors = createBuiltinDerivationDetectors({
    privateConfiguration,
  }).map((detector, index) => ({
    descriptor: detector.descriptor,
    async detect(candidate: DerivationSurface): Promise<DerivationFinding[]> {
      if (index !== 0 || candidate.text !== text) return [];
      return [
        {
          class: "email",
          confidence: "HIGH",
          surfaceId: candidate.surfaceId,
          start: 1,
          end: 2,
          evidence: ["synthetic-astral-span"],
          detector: detector.descriptor,
        },
      ];
    },
  }));
  await expect(
    createEvidenceDeriver({ detectors }).derive(input),
  ).rejects.toMatchObject({ code: "DETECTOR_CONTRACT_VIOLATION" });
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

const PUBLIC_BYTE_SLOTS = [
  {
    name: "source record",
    get(input: ReturnType<typeof syntheticDerivationInput>): Uint8Array {
      return input.sourceRecord.bytes;
    },
    set(
      input: ReturnType<typeof syntheticDerivationInput>,
      bytes: Uint8Array,
    ): void {
      (input.sourceRecord as { bytes: Uint8Array }).bytes = bytes;
    },
  },
  {
    name: "source artifact",
    get(input: ReturnType<typeof syntheticDerivationInput>): Uint8Array {
      return input.sourceArtifacts[0]!.bytes;
    },
    set(
      input: ReturnType<typeof syntheticDerivationInput>,
      bytes: Uint8Array,
    ): void {
      (input.sourceArtifacts[0] as { bytes: Uint8Array }).bytes = bytes;
    },
  },
  {
    name: "policy",
    get(input: ReturnType<typeof syntheticDerivationInput>): Uint8Array {
      return input.policyBytes;
    },
    set(
      input: ReturnType<typeof syntheticDerivationInput>,
      bytes: Uint8Array,
    ): void {
      (input as { policyBytes: Uint8Array }).policyBytes = bytes;
    },
  },
  {
    name: "implementation descriptor",
    get(input: ReturnType<typeof syntheticDerivationInput>): Uint8Array {
      return input.scrubber.implementationDescriptorBytes;
    },
    set(
      input: ReturnType<typeof syntheticDerivationInput>,
      bytes: Uint8Array,
    ): void {
      (
        input.scrubber as {
          implementationDescriptorBytes: Uint8Array;
        }
      ).implementationDescriptorBytes = bytes;
    },
  },
] as const;

test.each(PUBLIC_BYTE_SLOTS)(
  "copies $name bytes without executing an own iterator accessor",
  async ({ get, set }) => {
    const input = syntheticDerivationInput();
    const bytes = get(input);
    let accessorCalls = 0;
    Object.defineProperty(bytes, Symbol.iterator, {
      configurable: true,
      get() {
        accessorCalls += 1;
        throw new Error("caller iterator must not execute");
      },
    });
    set(input, bytes);
    expect(
      await createEvidenceDeriver({
        detectors: createBuiltinDerivationDetectors({ privateConfiguration }),
      }).derive(input),
    ).toMatchObject({ status: "derived" });
    expect(accessorCalls).toBe(0);
  },
);

test.each(PUBLIC_BYTE_SLOTS)(
  "rejects proxied $name bytes as INVALID_DERIVATION_INPUT without traps",
  async ({ get, set }) => {
    const input = syntheticDerivationInput();
    let trapCalls = 0;
    const bytes = new Proxy(get(input), {
      get() {
        trapCalls += 1;
        throw new Error("byte proxy trap must not execute");
      },
      getOwnPropertyDescriptor() {
        trapCalls += 1;
        throw new Error("byte proxy trap must not execute");
      },
      ownKeys() {
        trapCalls += 1;
        throw new Error("byte proxy trap must not execute");
      },
    });
    set(input, bytes);
    await expect(
      createEvidenceDeriver({
        detectors: createBuiltinDerivationDetectors({ privateConfiguration }),
      }).derive(input),
    ).rejects.toMatchObject({ code: "INVALID_DERIVATION_INPUT" });
    expect(trapCalls).toBe(0);
  },
);

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
  for (const mutate of [
    (candidate: typeof descriptor) => {
      candidate.name = "example.internal.test";
    },
    (candidate: typeof descriptor) => {
      candidate.version = "release-sk-live-credential";
    },
    (candidate: typeof descriptor) => {
      candidate.runtime.family = "operator-runtime";
    },
    (candidate: typeof descriptor) => {
      candidate.runtime.version = "private-release-22";
    },
    (candidate: typeof descriptor) => {
      candidate.detectors[0].id = "example.internal.test";
    },
    (candidate: typeof descriptor) => {
      candidate.detectors[0].version = `npm_${"a".repeat(36)}`;
    },
  ]) {
    const candidate = structuredClone(descriptor);
    mutate(candidate);
    expect(() =>
      parseScrubberImplementationDescriptor(canonicalJsonBytes(candidate)),
    ).toThrowError(
      expect.objectContaining({ code: "SCRUBBER_DESCRIPTOR_INVALID" }),
    );
  }
});

test("implementation descriptors accept safe independent package and runtime identities", () => {
  const input = syntheticDerivationInput();
  const descriptor = JSON.parse(
    new TextDecoder().decode(input.scrubber.implementationDescriptorBytes),
  );
  descriptor.name = "independent-deriver";
  descriptor.version = "release-1";
  descriptor.runtime = {
    family: "independent-runtime",
    version: "release-22",
  };
  expect(
    parseScrubberImplementationDescriptor(canonicalJsonBytes(descriptor)).value,
  ).toMatchObject({
    name: "independent-deriver",
    version: "release-1",
    runtime: {
      family: "independent-runtime",
      version: "release-22",
    },
  });
});

test("declared JSON and JSONL reject duplicate keys and invalid UTF-8", () => {
  for (const bytes of [
    new TextEncoder().encode('{"value":"first","value":"second"}\n'),
    Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
  ]) {
    const input = syntheticDerivationInput();
    replaceArtifact(input, "trace/trace.jsonl", bytes);
    const source = validateDerivationSource(input);
    const policy = parseDerivationPolicy(input.policyBytes).value;
    expect(() => extractDerivationSurfaces(source, policy)).toThrowError(
      expect.objectContaining({ code: "STRUCTURED_ARTIFACT_INVALID" }),
    );
  }
});

test.each([
  ["JSON", "runtime/runtime-specification.json", '{"value":1e400}\n'],
  ["JSONL", "trace/trace.jsonl", '{"value":1e400}\n'],
] as const)(
  "declared %s rejects non-finite parsed numbers before detector effects",
  async (_format, entityId, text) => {
    const input = syntheticDerivationInput();
    replaceArtifact(input, entityId, new TextEncoder().encode(text));
    let detectorEffects = 0;
    const detectors = createBuiltinDerivationDetectors({
      privateConfiguration,
    }).map((detector): DerivationDetector => ({
      descriptor: detector.descriptor,
      async detect(surface, options) {
        detectorEffects += 1;
        return detector.detect(surface, options);
      },
    }));

    await expect(
      createEvidenceDeriver({ detectors }).derive(input),
    ).rejects.toMatchObject({ code: "STRUCTURED_ARTIFACT_INVALID" });
    expect(detectorEffects).toBe(0);
  },
);

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

test("derived metadata is recursively key-sorted, pretty, and lists only physical hasPart bytes", async () => {
  const outcome = await createEvidenceDeriver({
    detectors: createBuiltinDerivationDetectors({ privateConfiguration }),
  }).derive(syntheticDerivationInput());
  expect(outcome.status).toBe("derived");
  if (outcome.status !== "derived") return;
  const serialized = new TextDecoder().decode(outcome.record.bytes);
  const document = JSON.parse(serialized);
  expect(serialized.startsWith('{\n  "@context":')).toBe(true);
  expect(serialized.endsWith("\n")).toBe(true);
  expect(serialized.endsWith("\n\n")).toBe(false);
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

test("policy selectors cannot override the fixed protected classifier", () => {
  const input = syntheticDerivationInput();
  replacePolicy(input, (policy) => {
    (
      policy as unknown as {
        transformableMetadata: string[];
      }
    ).transformableMetadata.push("/@graph/*/@id", "/@graph/*/sha256");
  });
  const extraction = extractDerivationSurfaces(
    validateDerivationSource(input),
    parseDerivationPolicy(input.policyBytes).value,
  );
  expect(
    extraction.surfaces.some(
      ({ location }) =>
        location.endsWith("/@id") || location.endsWith("/sha256"),
    ),
  ).toBe(false);
  expect(
    extraction.protectedLocations.some(
      ({ protectedClass }) => protectedClass === "digest-reference",
    ),
  ).toBe(true);
});

test("finding arrays and objects are closed inert snapshots", () => {
  const exactSurface = surface("secret");
  const [detector] = createBuiltinDerivationDetectors({
    privateConfiguration,
  });
  let getterCalls = 0;
  const behavioral: DerivationFinding[] = [];
  Object.defineProperty(behavioral, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("getter must not run");
    },
  });
  behavioral.length = 1;
  expect(() =>
    normalizeDetectorFindings(exactSurface, behavioral, detector!.descriptor),
  ).toThrowError(
    expect.objectContaining({ code: "DETECTOR_CONTRACT_VIOLATION" }),
  );
  expect(getterCalls).toBe(0);

  const base = {
    class: "credential",
    confidence: "HIGH",
    surfaceId: exactSurface.surfaceId,
    start: 0,
    end: exactSurface.text.length,
    evidence: ["credential-shape"],
    detector: detector!.descriptor,
  };
  for (const invalid of [
    { ...base, confidence: "NOT_A_BAND" },
    { ...base, snippet: "secret" },
  ]) {
    expect(() =>
      normalizeDetectorFindings(
        exactSurface,
        [invalid as unknown as DerivationFinding],
        detector!.descriptor,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "DETECTOR_CONTRACT_VIOLATION" }),
    );
  }
});

test("technical exemptions require complete structural validity", () => {
  expect(
    classifyTechnicalValue("bthisisnotavalidcidbutislongenough", {}),
  ).toBeNull();
  expect(
    classifyTechnicalValue("-----BEGIN PUBLIC KEY-----", {}),
  ).toBeNull();
  expect(
    classifyTechnicalValue("not-base64-secret", { field: "payload" }),
  ).toBeNull();
  expect(
    classifyTechnicalValue(
      "bafkreibm6jg3ux5qu3hbutfqc3hdoclhwd3bk4ufuyt7xzhsg7cdqs2m7a",
      {},
    ),
  ).toBe("cid");
});

test.each(["payload", "sig", "signature"])(
  "arbitrary %s leaves outside a complete DSSE envelope remain scan surfaces",
  (field) => {
    const input = syntheticDerivationInput();
    replaceArtifact(
      input,
      "trace/trace.jsonl",
      new TextEncoder().encode(
        `${JSON.stringify({ event: "tool", [field]: "c2VjcmV0" })}\n`,
      ),
    );
    const extraction = extractDerivationSurfaces(
      validateDerivationSource(input),
      parseDerivationPolicy(input.policyBytes).value,
    );
    expect(
      extraction.surfaces.some(
        ({ location, text }) =>
          location === `/0/${field}` && text === "c2VjcmV0",
      ),
    ).toBe(true);
    expect(
      extraction.protectedLocations.some(
        ({ location }) => location === `/0/${field}`,
      ),
    ).toBe(false);
  },
);

test("url-safe unpadded DSSE material participates in protected dispositions", () => {
  const input = syntheticDerivationInput();
  replaceArtifact(
    input,
    "trace/trace.jsonl",
    new TextEncoder().encode(
      `${JSON.stringify({
        event: "tool",
        envelope: {
          payloadType: "application/vnd.in-toto+json",
          payload: "eyJzeW50aGV0aWMiOnRydWV9",
          signatures: [{ keyid: "synthetic", sig: "__8" }],
        },
      })}\n`,
    ),
  );
  replacePolicy(input, (policy) => {
    (
      policy.protectedValueDispositions as Record<
        "signed-material",
        "retain" | "withhold-record"
      >
    )["signed-material"] = "withhold-record";
  });
  const extraction = extractDerivationSurfaces(
    validateDerivationSource(input),
    parseDerivationPolicy(input.policyBytes).value,
  );
  expect(extraction.hold).toEqual({
    code: "protected-value-withheld",
    protectedClass: "signed-material",
  });
});

test("Protocol-valid extended DSSE envelopes remain wholly signed material", () => {
  const input = syntheticDerivationInput();
  replaceArtifact(
    input,
    "trace/trace.jsonl",
    new TextEncoder().encode(
      `${JSON.stringify({
        event: "tool",
        envelope: {
          payloadType: "application/vnd.in-toto+json",
          payload: "e30",
          envelopeExtension: {
            publicNote: "must-not-become-a-surface",
          },
          signatures: [
            {
              keyid: "",
              sig: "__8",
              signatureExtension: "must-also-stay-signed",
            },
            {
              sig: "c2k=",
            },
          ],
        },
      })}\n`,
    ),
  );
  const source = validateDerivationSource(input);
  const policy = parseDerivationPolicy(input.policyBytes).value;
  const extraction = extractDerivationSurfaces(source, policy);
  expect(
    extraction.surfaces.some(({ location }) =>
      location.startsWith("/0/envelope"),
    ),
  ).toBe(false);
  const protectedEnvelopeLocations = extraction.protectedLocations.filter(
    ({ location }) => location.startsWith("/0/envelope"),
  );
  expect(protectedEnvelopeLocations).toEqual(
    expect.arrayContaining([
      {
        location: "/0/envelope",
        protectedClass: "signed-material",
      },
      {
        location: "/0/envelope/envelopeExtension/publicNote",
        protectedClass: "signed-material",
      },
      {
        location: "/0/envelope/signatures/0/signatureExtension",
        protectedClass: "signed-material",
      },
    ]),
  );
  expect(
    protectedEnvelopeLocations.every(
      ({ protectedClass }) => protectedClass === "signed-material",
    ),
  ).toBe(true);
  const heldPolicy = structuredClone(policy);
  (
    heldPolicy.protectedValueDispositions as Record<
      "signed-material",
      "retain" | "withhold-record"
    >
  )["signed-material"] = "withhold-record";
  expect(extractDerivationSurfaces(source, heldPolicy).hold).toEqual({
    code: "protected-value-withheld",
    protectedClass: "signed-material",
  });
});

test.each([
  { payload: "", sig: "c2k=" },
  { payload: "e30", sig: "" },
] as const)(
  "canonical zero-byte DSSE fields remain signed material: %j",
  ({ payload, sig }) => {
    const input = syntheticDerivationInput();
    replaceArtifact(
      input,
      "trace/trace.jsonl",
      new TextEncoder().encode(
        `${JSON.stringify({
          event: "tool",
          envelope: {
            payloadType: "application/vnd.in-toto+json",
            payload,
            signatures: [{ sig }],
          },
        })}\n`,
      ),
    );
    const extraction = extractDerivationSurfaces(
      validateDerivationSource(input),
      parseDerivationPolicy(input.policyBytes).value,
    );
    expect(
      extraction.surfaces.some(({ location }) =>
        location.startsWith("/0/envelope"),
      ),
    ).toBe(false);
    expect(extraction.protectedLocations).toEqual(
      expect.arrayContaining([
        {
          location: "/0/envelope/payload",
          protectedClass: "signed-material",
        },
        {
          location: "/0/envelope/signatures/0/sig",
          protectedClass: "signed-material",
        },
      ]),
    );
  },
);

test("malformed RSA SPKI remains a scan surface", () => {
  const malformed = [
    "-----BEGIN PUBLIC KEY-----",
    "MD4wDQYJKoZIhvcNAQEBBQADLQAwKgQobnBtX2FhYWFhYWFhYWFhYWFhYWFhYWFh",
    "YWFhYWFhYWFhYWFhYWFhYQ==",
    "-----END PUBLIC KEY-----",
    "",
  ].join("\n");
  const input = syntheticDerivationInput();
  replaceArtifact(
    input,
    "trace/trace.jsonl",
    new TextEncoder().encode(
      `${JSON.stringify({ event: "tool", publicKey: malformed })}\n`,
    ),
  );
  const extraction = extractDerivationSurfaces(
    validateDerivationSource(input),
    parseDerivationPolicy(input.policyBytes).value,
  );
  expect(
    extraction.surfaces.some(({ text }) => text === malformed),
  ).toBe(true);
  expect(
    extraction.protectedLocations.some(
      ({ protectedClass }) => protectedClass === "signed-material",
    ),
  ).toBe(false);
});

test.each([
  `owner/npm_${"a".repeat(36)}`,
  `owner/AIza${"a".repeat(35)}`,
  `owner/github_pat_${"a".repeat(82)}`,
  `owner/rk_live_${"a".repeat(24)}`,
  `owner/0x${"a".repeat(64)}`,
])(
  "JSONL modelId credentials are derived and never leak through publishable bytes: %s",
  async (credential) => {
    const input = syntheticDerivationInput();
    replaceArtifact(
      input,
      "trace/trace.jsonl",
      new TextEncoder().encode(
        `${JSON.stringify({ event: "tool", modelId: credential })}\n`,
      ),
    );
    const outcome = await createEvidenceDeriver({
      detectors: createBuiltinDerivationDetectors({ privateConfiguration }),
    }).derive(input);
    expect(outcome.status).not.toBe("publishable-unchanged");
    expect(JSON.stringify(outcome)).not.toContain(credential);
    if (outcome.status !== "derived") return;
    expect(
      outcome.artifacts.some(({ bytes }) =>
        new TextDecoder().decode(bytes).includes("[REDACTED_CREDENTIAL]"),
      ),
    ).toBe(true);
  },
);

test("an exact nested extension leaf selector admits only that leaf", () => {
  const input = syntheticDerivationInput();
  const document = JSON.parse(new TextDecoder().decode(input.sourceRecord.bytes));
  document["@graph"][1].customExtension = {
    nested: "nested-private-value",
  };
  (input.sourceRecord as { bytes: Uint8Array }).bytes = new TextEncoder().encode(
    `${JSON.stringify(document, null, 2)}\n`,
  );
  (input.sourceRecord.reference as { digest: `sha256:${string}` }).digest =
    sha256Digest(input.sourceRecord.bytes);
  replacePolicy(input, (policy) => {
    (
      policy as unknown as {
        transformableMetadata: string[];
      }
    ).transformableMetadata.push(
      "/@graph/*/customExtension/nested",
    );
  });
  const extraction = extractDerivationSurfaces(
    validateDerivationSource(input),
    parseDerivationPolicy(input.policyBytes).value,
  );
  expect(extraction.hold).toBeUndefined();
  expect(
    extraction.surfaces.find(
      ({ location }) =>
        location === "/@graph/1/customExtension/nested",
    )?.text,
  ).toBe("nested-private-value");
});

test.each(["0", "*"])(
  "an array wildcard never admits object-property segment %s",
  (objectKey) => {
    const input = syntheticDerivationInput();
    const document = JSON.parse(
      new TextDecoder().decode(input.sourceRecord.bytes),
    );
    document["@graph"][1].customExtension = {
      [objectKey]: {
        nested: "object-key-private-value",
      },
    };
    (input.sourceRecord as { bytes: Uint8Array }).bytes =
      new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
    (input.sourceRecord.reference as { digest: `sha256:${string}` }).digest =
      sha256Digest(input.sourceRecord.bytes);
    replacePolicy(input, (policy) => {
      (
        policy as unknown as {
          transformableMetadata: string[];
        }
      ).transformableMetadata.push(
        "/@graph/*/customExtension/*/nested",
      );
    });
    const extraction = extractDerivationSurfaces(
      validateDerivationSource(input),
      parseDerivationPolicy(input.policyBytes).value,
    );
    expect(extraction.hold).toEqual({ code: "unclassified-metadata" });
    expect(
      extraction.surfaces.some(
        ({ text }) => text === "object-key-private-value",
      ),
    ).toBe(false);
  },
);

test("an array wildcard admits the corresponding actual array element", () => {
  const input = syntheticDerivationInput();
  const document = JSON.parse(new TextDecoder().decode(input.sourceRecord.bytes));
  document["@graph"][1].customExtension = ["array-element-private-value"];
  (input.sourceRecord as { bytes: Uint8Array }).bytes = new TextEncoder().encode(
    `${JSON.stringify(document, null, 2)}\n`,
  );
  (input.sourceRecord.reference as { digest: `sha256:${string}` }).digest =
    sha256Digest(input.sourceRecord.bytes);
  replacePolicy(input, (policy) => {
    (
      policy as unknown as {
        transformableMetadata: string[];
      }
    ).transformableMetadata.push(
      "/@graph/*/customExtension/*",
    );
  });
  const extraction = extractDerivationSurfaces(
    validateDerivationSource(input),
    parseDerivationPolicy(input.policyBytes).value,
  );
  expect(extraction.hold).toBeUndefined();
  expect(
    extraction.surfaces.find(
      ({ location }) =>
        location === "/@graph/1/customExtension/0",
    )?.text,
  ).toBe("array-element-private-value");
});

test("entropy and Git trailer carriers use their exact semantic classes", async () => {
  const detectors = createBuiltinDerivationDetectors({
    privateConfiguration,
  });
  const findings = (
    await Promise.all(
      detectors.map((detector) =>
        detector.detect(
          surface(
            `opaque Ab3Def5Gh7Jk9Lm2Np4Qr6St8Uv0Xy1Z\nSigned-off-by: Ada Example <ada@example.invalid>`,
          ),
        ),
      ),
    )
  ).flat();
  expect(findings.map(({ class: findingClass }) => findingClass)).toContain(
    "high-entropy-secret",
  );
  expect(findings.map(({ class: findingClass }) => findingClass)).toContain(
    "git-identity",
  );
});

test("the protected classifier exhaustively represents and enforces every closed class", async () => {
  const baseline = syntheticDerivationInput();
  const baselineSource = validateDerivationSource(baseline);
  const baselinePolicy = parseDerivationPolicy(baseline.policyBytes).value;

  const custom = syntheticDerivationInput();
  const customDocument = JSON.parse(
    new TextDecoder().decode(custom.sourceRecord.bytes),
  );
  customDocument["@graph"][1].customApproved = "approved-private-property";
  (custom.sourceRecord as { bytes: Uint8Array }).bytes =
    new TextEncoder().encode(`${JSON.stringify(customDocument, null, 2)}\n`);
  (custom.sourceRecord.reference as { digest: `sha256:${string}` }).digest =
    sha256Digest(custom.sourceRecord.bytes);
  replacePolicy(custom, (policy) => {
    (
      policy as unknown as {
        protectedMetadata: string[];
      }
    ).protectedMetadata.push("/@graph/*/customApproved");
  });
  const customSource = validateDerivationSource(custom);
  const customPolicy = parseDerivationPolicy(custom.policyBytes).value;

  const outcome = await createEvidenceDeriver({
    detectors: createBuiltinDerivationDetectors({ privateConfiguration }),
  }).derive(syntheticDerivationInput());
  expect(outcome.status).toBe("derived");
  if (outcome.status !== "derived") return;
  const derivedInput = syntheticDerivationInput();
  (derivedInput as { sourceRecord: typeof derivedInput.sourceRecord })
    .sourceRecord = outcome.record;
  (
    derivedInput as {
      sourceArtifacts: typeof derivedInput.sourceArtifacts;
    }
  ).sourceArtifacts = outcome.artifacts;
  const derivedSource = validateDerivationSource(derivedInput);
  const derivedPolicy = parseDerivationPolicy(
    derivedInput.policyBytes,
  ).value;

  const candidates = [
    { source: baselineSource, policy: baselinePolicy },
    { source: customSource, policy: customPolicy },
    { source: derivedSource, policy: derivedPolicy },
  ];
  const represented = new Set(
    candidates.flatMap(({ source, policy }) =>
      extractDerivationSurfaces(source, policy).protectedLocations.map(
        ({ protectedClass }) => protectedClass,
      ),
    ),
  );
  expect([...represented].sort()).toEqual(
    [...PROTECTED_VALUE_CLASSES].sort(),
  );

  for (const protectedClass of PROTECTED_VALUE_CLASSES) {
    const candidate = candidates.find(({ source, policy }) =>
      extractDerivationSurfaces(source, policy).protectedLocations.some(
        (location) => location.protectedClass === protectedClass,
      ),
    );
    expect(candidate).toBeDefined();
    if (!candidate) continue;
    const policy = structuredClone(candidate.policy);
    (
      policy.protectedValueDispositions as Record<
        typeof protectedClass,
        "retain" | "withhold-record"
      >
    )[protectedClass] = "withhold-record";
    expect(extractDerivationSurfaces(candidate.source, policy).hold).toEqual({
      code: "protected-value-withheld",
      protectedClass,
    });
  }
});
