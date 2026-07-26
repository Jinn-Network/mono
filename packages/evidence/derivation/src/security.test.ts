// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "vitest";

import { canonicalJsonBytes, sha256Digest } from "./bytes.js";
import {
  createBuiltinDerivationDetectors,
  normalizeDetectorFindings,
} from "./detectors/index.js";
import { createEvidenceDeriver } from "./derive.js";
import {
  baselinePolicyValue,
  syntheticDerivationInput,
  SYNTHETIC_PRIVATE_VALUES,
} from "./fixtures.js";
import { parseDerivationPolicy } from "./policy.js";
import { parseScrubReceipt } from "./receipt.js";
import type {
  DerivationDetector,
  DerivationFinding,
  DerivationOperationOptions,
  DerivationSurface,
  DeriveExecutionEvidenceInput,
} from "./types.js";

const privateConfiguration = {
  schemaVersion: "jinn.private-detector-configuration.v1" as const,
  nonce: SYNTHETIC_PRIVATE_VALUES.nonce,
  knownIdentities: [SYNTHETIC_PRIVATE_VALUES.knownIdentity],
  privateAllowlist: [SYNTHETIC_PRIVATE_VALUES.privateAllowlist],
};

function builtins(): readonly DerivationDetector[] {
  return createBuiltinDerivationDetectors({ privateConfiguration });
}

function deriver() {
  return createEvidenceDeriver({ detectors: builtins() });
}

function rewriteRecord(
  input: DeriveExecutionEvidenceInput,
  mutate: (document: Record<string, unknown>) => void,
): void {
  const document = JSON.parse(
    new TextDecoder().decode(input.sourceRecord.bytes),
  ) as Record<string, unknown>;
  mutate(document);
  (input.sourceRecord as { bytes: Uint8Array }).bytes =
    new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
  (
    input.sourceRecord.reference as {
      digest: `sha256:${string}`;
    }
  ).digest = sha256Digest(input.sourceRecord.bytes);
}

function replaceArtifact(
  input: DeriveExecutionEvidenceInput,
  entityId: string,
  bytes: Uint8Array,
): void {
  const artifact = input.sourceArtifacts.find(
    (candidate) => candidate.entityId === entityId,
  );
  if (!artifact) throw new Error(`missing synthetic artifact ${entityId}`);
  (artifact as { bytes: Uint8Array }).bytes = bytes;
  rewriteRecord(input, (document) => {
    const graph = document["@graph"] as Array<Record<string, unknown>>;
    graph.find((entity) => entity["@id"] === entityId)!.sha256 =
      sha256Digest(bytes).slice("sha256:".length);
  });
}

function textSurface(text: string): DerivationSurface {
  return Object.freeze({
    surfaceId: "security:text",
    sourceEntityId: "security",
    role: "other",
    mediaType: "text/plain",
    codec: "text",
    location: "",
    text,
  });
}

test("public boundaries reject proxies, accessors, unsafe prototypes, and sparse data", async () => {
  let trapCalls = 0;
  const proxiedOptions = new Proxy({ detectors: builtins() }, {
    getPrototypeOf() {
      trapCalls += 1;
      throw new Error("proxy trap must not run");
    },
  });
  expect(() => createEvidenceDeriver(proxiedOptions)).toThrowError(
    expect.objectContaining({ code: "INVALID_DERIVATION_INPUT" }),
  );
  expect(trapCalls).toBe(0);

  const accessorInput = syntheticDerivationInput();
  Object.defineProperty(accessorInput.scrubber, "agentId", {
    enumerable: true,
    get() {
      throw new Error("accessor must not run");
    },
  });
  await expect(deriver().derive(accessorInput)).rejects.toMatchObject({
    code: "INVALID_DERIVATION_INPUT",
  });

  const unsafe = syntheticDerivationInput();
  Object.setPrototypeOf(unsafe.scrubber, { ambient: true });
  await expect(deriver().derive(unsafe)).rejects.toMatchObject({
    code: "INVALID_DERIVATION_INPUT",
  });

  const sparse = syntheticDerivationInput();
  const artifacts = [...sparse.sourceArtifacts];
  delete artifacts[0];
  (
    sparse as unknown as {
      sourceArtifacts: typeof artifacts;
    }
  ).sourceArtifacts = artifacts;
  await expect(deriver().derive(sparse)).rejects.toMatchObject({
    code: "INVALID_DERIVATION_INPUT",
  });

  const nonEnumerable = syntheticDerivationInput();
  Object.defineProperty(nonEnumerable.scrubber, "hidden", {
    value: "private",
    enumerable: false,
  });
  await expect(deriver().derive(nonEnumerable)).rejects.toMatchObject({
    code: "INVALID_DERIVATION_INPUT",
  });
});

test("strict JSON boundaries reject duplicate and prototype-pollution keys", async () => {
  for (const policyBytes of [
    new TextEncoder().encode('{"schemaVersion":"x","schemaVersion":"y"}'),
    new TextEncoder().encode('{"__proto__":{"polluted":true}}'),
    new TextEncoder().encode('{"constructor":{"prototype":{"x":1}}}'),
  ]) {
    expect(() => parseDerivationPolicy(policyBytes)).toThrowError(
      expect.objectContaining({ code: "POLICY_INVALID" }),
    );
  }

  for (const bytes of [
    new TextEncoder().encode('{"value":"one","value":"two"}\n'),
    new TextEncoder().encode('{"prototype":{"polluted":true}}\n'),
    Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]),
  ]) {
    const input = syntheticDerivationInput();
    replaceArtifact(input, "trace/trajectory.jsonl", bytes);
    await expect(deriver().derive(input)).rejects.toMatchObject({
      code: "STRUCTURED_ARTIFACT_INVALID",
    });
  }
});

test("finding normalization rejects hostile offsets, descriptors, and plaintext evidence", () => {
  const surface = textSurface("secret");
  const descriptor = builtins()[0]!.descriptor;
  const base: DerivationFinding = {
    class: "credential",
    confidence: "HIGH",
    surfaceId: surface.surfaceId,
    start: 0,
    end: 6,
    evidence: ["credential-shape"],
    detector: descriptor,
  };
  for (const finding of [
    { ...base, start: -1 },
    { ...base, start: 6, end: 2 },
    { ...base, end: Number.MAX_SAFE_INTEGER },
    { ...base, evidence: ["secret"] },
    {
      ...base,
      detector: {
        ...descriptor,
        implementationDigest: `sha256:${"0".repeat(64)}` as const,
      },
    },
  ]) {
    expect(() =>
      normalizeDetectorFindings(surface, [finding], descriptor),
    ).toThrowError(
      expect.objectContaining({ code: "DETECTOR_CONTRACT_VIOLATION" }),
    );
  }
});

test("overlapping findings resolve deterministically without offset corruption", async () => {
  const [known, patterns] = builtins();
  const input = syntheticDerivationInput();
  const overlapping: DerivationDetector = {
    descriptor: known!.descriptor,
    async detect(surface) {
      const start = surface.text.indexOf("Synthetic private");
      return start < 0
        ? []
        : [
            {
              class: "known-identity",
              confidence: "HIGH",
              surfaceId: surface.surfaceId,
              start,
              end: start + "Synthetic private".length,
              evidence: ["known-identity-exact"],
              detector: known!.descriptor,
            },
            {
              class: "known-identity",
              confidence: "VERY_HIGH",
              surfaceId: surface.surfaceId,
              start,
              end: start + "Synthetic".length,
              evidence: ["known-identity-exact"],
              detector: known!.descriptor,
            },
          ];
    },
  };
  const first = await createEvidenceDeriver({
    detectors: [overlapping, patterns!],
  }).derive(input);
  const second = await createEvidenceDeriver({
    detectors: [overlapping, patterns!],
  }).derive(syntheticDerivationInput());
  expect(second).toEqual(first);
});

test("source collisions with every conventional derivation id fail closed", async () => {
  for (const reserved of [
    "private/ro-crate-metadata.json",
    "provenance/derivation-policy.json",
    "provenance/scrubber-implementation.json",
    "provenance/scrub-receipt.json",
    "#public-derivation",
    "urn:uuid:33333333-3333-4333-8333-333333333333",
  ]) {
    const input = syntheticDerivationInput();
    rewriteRecord(input, (document) => {
      (document["@graph"] as Array<Record<string, unknown>>).push({
        "@id": reserved,
        "@type": "CreativeWork",
        name: "preexisting derivation entity",
      });
    });
    await expect(deriver().derive(input)).rejects.toMatchObject({
      code: expect.stringMatching(/SOURCE_NONCONFORMING|DERIVATIVE_NONCONFORMING/u),
    });
  }
});

test("two transformed artifacts cannot create one ambiguous derived entity", async () => {
  const input = syntheticDerivationInput();
  const bytes = new TextEncoder().encode(
    "contact duplicated@example.invalid\n",
  );
  const digest = sha256Digest(bytes).slice("sha256:".length);
  rewriteRecord(input, (document) => {
    const graph = document["@graph"] as Array<Record<string, unknown>>;
    const root = graph.find((entity) => entity["@id"] === "./")!;
    const hasPart = root.hasPart as Array<Record<string, string>>;
    for (const entityId of ["evidence/duplicate-a.txt", "evidence/duplicate-b.txt"]) {
      graph.push({
        "@id": entityId,
        "@type": ["File", "CreativeWork"],
        name: "Duplicate sensitive artifact",
        encodingFormat: "text/plain",
        sha256: digest,
        about: { "@id": "#capture" },
      });
      hasPart.push({ "@id": entityId });
      (
        input.sourceArtifacts as Array<{
          entityId: string;
          bytes: Uint8Array;
        }>
      ).push({ entityId, bytes: Uint8Array.from(bytes) });
    }
  });
  await expect(deriver().derive(input)).rejects.toMatchObject({
    code: "DERIVATIVE_NONCONFORMING",
  });
});

test("signed material bypasses detectors and remains exact or is withheld", async () => {
  const seen: string[] = [];
  const wrapped = builtins().map((detector) => ({
    descriptor: detector.descriptor,
    async detect(surface: DerivationSurface) {
      seen.push(surface.text);
      return detector.detect(surface);
    },
  }));
  const input = syntheticDerivationInput();
  const outcome = await createEvidenceDeriver({ detectors: wrapped }).derive(
    input,
  );
  expect(["derived", "publishable-unchanged"]).toContain(outcome.status);
  expect(seen.join("\n")).not.toContain("eyJzeW50aGV0aWMiOnRydWV9");
  expect(seen.join("\n")).not.toContain("c2lnbmF0dXJl");
});

test("technical values survive next to a credential while the credential is found", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const cid = "bafkreibm6jg3ux5qu3hbutfqc3hdoclhwd3bk4ufuyt7xzhsg7cdqs2m7a";
  const credential = `npm_${"aB3".repeat(12)}`;
  const surface = textSurface(`${digest} ${credential} ${cid}`);
  const findings = (
    await Promise.all(
      builtins().map((detector) => detector.detect(surface)),
    )
  ).flat();
  expect(findings.map((finding) => finding.class)).toContain("credential");
  const spans = findings.map((finding) =>
    surface.text.slice(finding.start, finding.end),
  );
  expect(spans).not.toContain(digest);
  expect(spans).not.toContain(cid);
});

test("best-effort participation is explicitly permitted and honestly graded", async () => {
  const input = syntheticDerivationInput();
  const [known, patterns] = builtins();
  const bestEffortDescriptor = Object.freeze({
    ...patterns!.descriptor,
    implementationDigest: `sha256:${"d".repeat(64)}` as const,
    reproducibility: "best-effort" as const,
  });
  const bestEffort: DerivationDetector = Object.freeze({
    descriptor: bestEffortDescriptor,
    async detect(
      surface: DerivationSurface,
      options?: DerivationOperationOptions,
    ) {
      return (await patterns!.detect(surface, options)).map((finding) => ({
        ...finding,
        detector: bestEffortDescriptor,
      }));
    },
  });
  const policy = baselinePolicyValue();
  (
    policy as {
      reproducibility: "byte-stable" | "content-addressed";
    }
  ).reproducibility = "content-addressed";
  (
    policy as {
      requiredDetectors: Array<
        (typeof policy.requiredDetectors)[number]
      >;
    }
  ).requiredDetectors = policy.requiredDetectors.map((descriptor) =>
    descriptor.id === patterns!.descriptor.id
      ? bestEffortDescriptor
      : descriptor,
  );
  (input as { policyBytes: Uint8Array }).policyBytes =
    canonicalJsonBytes(policy);
  const implementation = JSON.parse(
    new TextDecoder().decode(input.scrubber.implementationDescriptorBytes),
  );
  implementation.detectors = policy.requiredDetectors;
  (
    input.scrubber as {
      implementationDescriptorBytes: Uint8Array;
    }
  ).implementationDescriptorBytes = canonicalJsonBytes(implementation);

  const outcome = await createEvidenceDeriver({
    detectors: [known!, bestEffort],
  }).derive(input);
  expect(outcome.status).toBe("derived");
  if (outcome.status !== "derived") return;
  const receipt = parseScrubReceipt(outcome.receipt.bytes);
  expect(receipt.value.reproducibility).toBe("content-addressed");
});

test("public descriptors, receipts, and final bytes leak no private fixture value", async () => {
  const input = syntheticDerivationInput();
  const leaks = [
    SYNTHETIC_PRIVATE_VALUES.knownIdentity,
    SYNTHETIC_PRIVATE_VALUES.privateAllowlist,
    SYNTHETIC_PRIVATE_VALUES.nonce,
    "/home/example-user/work",
    "operator-box",
    "DEVICE-8F3A",
    "AWS_SECRET_ACCESS_KEY",
    "sk-synthetic-not-a-real-secret-1234567890",
  ];
  const descriptorText = JSON.stringify(builtins().map(({ descriptor }) => descriptor));
  for (const leak of leaks) expect(descriptorText).not.toContain(leak);

  const outcome = await deriver().derive(input);
  expect(outcome.status).toBe("derived");
  if (outcome.status !== "derived") return;
  const publicText = [
    outcome.record.bytes,
    ...outcome.artifacts.map(({ bytes }) => bytes),
    outcome.receipt.bytes,
  ].map((bytes) => new TextDecoder().decode(bytes)).join("\n");
  for (const leak of leaks) expect(publicText).not.toContain(leak);
  const receipt = parseScrubReceipt(outcome.receipt.bytes);
  expect(receipt.value.privateConfigurationDigests).not.toEqual([]);
});

test("all admitted sensitive metadata literal categories are absent from final bytes", async () => {
  const input = syntheticDerivationInput();
  const sensitive = {
    name: SYNTHETIC_PRIVATE_VALUES.knownIdentity,
    description: "private-owner@example.invalid",
    error: "/home/private-owner/failure.log",
    propertyValue: `npm_${"aB3".repeat(12)}`,
    extension: "hostname: private-owner-device",
  };
  rewriteRecord(input, (document) => {
    const graph = document["@graph"] as Array<Record<string, unknown>>;
    const root = graph.find((entity) => entity["@id"] === "./")!;
    root.name = sensitive.name;
    root.description = sensitive.description;
    root.publicNote = sensitive.extension;
    const execution = graph.find((entity) => {
      const type = Array.isArray(entity["@type"])
        ? entity["@type"]
        : [entity["@type"]];
      return type.includes("CreateAction");
    })!;
    execution.error = sensitive.error;
    graph.push({
      "@id": "#sensitive-property-value",
      "@type": "PropertyValue",
      name: "Sensitive public note",
      propertyID: "https://example.invalid/sensitive-note",
      value: sensitive.propertyValue,
    });
  });
  const policy = baselinePolicyValue();
  (
    policy as unknown as {
      transformableMetadata: string[];
    }
  ).transformableMetadata.push("/@graph/*/publicNote");
  (input as { policyBytes: Uint8Array }).policyBytes =
    canonicalJsonBytes(policy);

  const outcome = await deriver().derive(input);
  expect(outcome.status).toBe("derived");
  if (outcome.status !== "derived") return;
  const publicText = new TextDecoder().decode(outcome.record.bytes);
  for (const value of Object.values(sensitive)) {
    expect(publicText).not.toContain(value);
  }
});

test("nested unknown extension literals withhold without leaking value or location", async () => {
  const input = syntheticDerivationInput();
  const privateLiteral = "nested-private-extension-value";
  rewriteRecord(input, (document) => {
    const root = (document["@graph"] as Array<Record<string, unknown>>).find(
      (entity) => entity["@id"] === "./",
    )!;
    root["x-private-extension"] = {
      nested: [{ value: privateLiteral }],
    };
  });
  const outcome = await deriver().derive(input);
  expect(outcome.status).toBe("withheld");
  expect(JSON.stringify(outcome)).not.toContain(privateLiteral);
  expect(JSON.stringify(outcome)).not.toContain("x-private-extension");
  expect("record" in outcome).toBe(false);
});

test.each([
  ["nested graph", { "@graph": [{ value: "private-graph-value" }] }],
  [
    "list containing a nested graph",
    {
      "@list": [
        { "@graph": [{ value: "private-list-graph-value" }] },
      ],
    },
  ],
  [
    "set containing a nested graph",
    {
      "@set": [
        { "@graph": [{ value: "private-set-graph-value" }] },
      ],
    },
  ],
] as const)(
  "unknown extension %s preserves fail-closed context through JSON-LD containers",
  async (_name, extension) => {
    const input = syntheticDerivationInput();
    rewriteRecord(input, (document) => {
      const root = (document["@graph"] as Array<Record<string, unknown>>).find(
        (entity) => entity["@id"] === "./",
      )!;
      root["x-private-extension"] = extension;
    });
    const outcome = await deriver().derive(input);
    expect(outcome.status).toBe("withheld");
    expect(JSON.stringify(outcome)).not.toContain("private-");
    expect(JSON.stringify(outcome)).not.toContain("x-private-extension");
    expect("record" in outcome).toBe(false);
  },
);

test.each([
  [
    "@id",
    { "@id": "urn:private:extension-identifier" },
    "urn:private:extension-identifier",
  ],
  [
    "@type",
    { "@type": "PrivateExtensionType" },
    "PrivateExtensionType",
  ],
  [
    "sha256",
    { sha256: "private-extension-digest-literal" },
    "private-extension-digest-literal",
  ],
  [
    "relationship reference",
    { hasPart: { "@id": "urn:private:extension-part" } },
    "urn:private:extension-part",
  ],
  [
    "relationship reference array",
    { mentions: [{ "@id": "urn:private:extension-mention" }] },
    "urn:private:extension-mention",
  ],
  [
    "media type",
    { encodingFormat: "private/extension-format" },
    "private/extension-format",
  ],
  [
    "version",
    { softwareVersion: "private-extension-version" },
    "private-extension-version",
  ],
] as const)(
  "protected-looking %s nested under an unknown extension requires an exact selector",
  async (_name, extension, privateLiteral) => {
    const input = syntheticDerivationInput();
    rewriteRecord(input, (document) => {
      const root = (document["@graph"] as Array<Record<string, unknown>>).find(
        (entity) => entity["@id"] === "./",
      )!;
      root["x-private-extension"] = extension;
    });

    let detectorCalls = 0;
    const detectors = builtins().map((detector) => ({
      descriptor: detector.descriptor,
      async detect(
        surface: DerivationSurface,
        options?: DerivationOperationOptions,
      ) {
        detectorCalls += 1;
        return detector.detect(surface, options);
      },
    }));
    const outcome = await createEvidenceDeriver({ detectors }).derive(input);
    expect(outcome.status).toBe("withheld");
    expect(outcome).toEqual({
      status: "withheld",
      reasons: [{ code: "unclassified-metadata" }],
    });
    expect(JSON.stringify(outcome)).not.toContain(privateLiteral);
    expect(JSON.stringify(outcome)).not.toContain("x-private-extension");
    expect("record" in outcome).toBe(false);
    expect(detectorCalls).toBe(0);
  },
);

test("mutating returned bytes never mutates a repeated derivation", async () => {
  const service = deriver();
  const first = await service.derive(syntheticDerivationInput());
  const baseline = await service.derive(syntheticDerivationInput());
  expect(first.status).toBe("derived");
  expect(baseline.status).toBe("derived");
  if (first.status !== "derived" || baseline.status !== "derived") return;
  first.record.bytes.fill(0xff);
  first.receipt.bytes.fill(0xff);
  for (const artifact of first.artifacts) artifact.bytes.fill(0xff);
  expect(await service.derive(syntheticDerivationInput())).toEqual(baseline);
});

test("cancellation after every detector await returns no output", async () => {
  let totalCalls = 0;
  const counting = builtins().map((detector) => ({
    descriptor: detector.descriptor,
    async detect(surface: DerivationSurface) {
      totalCalls += 1;
      return detector.detect(surface);
    },
  }));
  await createEvidenceDeriver({ detectors: counting }).derive(
    syntheticDerivationInput(),
  );
  expect(totalCalls).toBeGreaterThan(0);

  for (let abortAt = 1; abortAt <= totalCalls; abortAt += 1) {
    const controller = new AbortController();
    let calls = 0;
    const aborting = builtins().map((detector) => ({
      descriptor: detector.descriptor,
      async detect(surface: DerivationSurface) {
        const findings = await detector.detect(surface);
        calls += 1;
        if (calls === abortAt) controller.abort();
        return findings;
      },
    }));
    await expect(
      createEvidenceDeriver({ detectors: aborting }).derive(
        syntheticDerivationInput(),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
  }
});
