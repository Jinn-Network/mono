// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, sha256Digest } from "./bytes.js";
import { createBuiltinDerivationDetectors } from "./detectors/index.js";
import {
  PROTECTED_VALUE_CLASSES,
  type DeriveExecutionEvidenceInput,
  type DerivationPolicy,
} from "./types.js";

export const SYNTHETIC_PRIVATE_VALUES = Object.freeze({
  knownIdentity: "Ada Example",
  nonce: "private-test-nonce-0123456789abcdef",
  privateAllowlist: "operator.internal.example",
});

export function baselinePolicyValue(): DerivationPolicy & {
  requiredDetectors: Array<DerivationPolicy["requiredDetectors"][number]>;
  stubs: Record<string, string>;
} {
  const protectedValueDispositions = Object.fromEntries(
    PROTECTED_VALUE_CLASSES.map((name) => [name, "retain"]),
  ) as DerivationPolicy["protectedValueDispositions"];
  const requiredDetectors = createBuiltinDerivationDetectors({
    privateConfiguration: {
      schemaVersion: "jinn.private-detector-configuration.v1",
      nonce: SYNTHETIC_PRIVATE_VALUES.nonce,
      knownIdentities: [SYNTHETIC_PRIVATE_VALUES.knownIdentity],
      privateAllowlist: [SYNTHETIC_PRIVATE_VALUES.privateAllowlist],
    },
  }).map(({ descriptor }) => ({ ...descriptor }));
  const configurationDigest = requiredDetectors[0]!.configurationDigest!;
  return {
    schemaVersion: "jinn.evidence-derivation-policy.v1",
    name: "synthetic-baseline",
    version: "1.0.0",
    reproducibility: "byte-stable",
    requiredDetectors,
    transformableMetadata: [
      "/@graph/*/name",
      "/@graph/*/description",
      "/@graph/*/error",
      "/@graph/*/value",
    ],
    protectedMetadata: [],
    protectedValueDispositions,
    artifactRules: [
      {
        mediaType: "application/x-ndjson",
        roles: ["native-trace"],
        codec: "jsonl",
        unavailable: "retain-commitment",
      },
      {
        mediaType: "application/json",
        roles: [
          "task",
          "result",
          "runtime-specification",
          "runtime-component",
          "native-trace",
          "input",
          "evidence",
          "other",
        ],
        codec: "json",
        unavailable: "retain-commitment",
      },
      {
        mediaType: "text/*",
        roles: [
          "task",
          "result",
          "runtime-component",
          "input",
          "evidence",
          "other",
        ],
        codec: "text",
        unavailable: "retain-commitment",
      },
    ],
    defaultArtifactDisposition: "withhold-artifact",
    dispositions: [
      ...[
        "email",
        "absolute-path",
        "credential",
        "high-entropy-secret",
        "url-credential",
        "environment-dump",
        "git-identity",
        "known-identity",
        "wallet-address",
        "payment-instrument",
        "ip-address",
        "machine-identity",
      ].map((classification) => ({
        class: classification,
        minimumConfidence: "VERY_LOW" as const,
        disposition: "redact" as const,
      })),
      {
        class: "funds-controlling-secret",
        minimumConfidence: "VERY_LOW",
        disposition: "withhold-record",
      },
    ],
    unmatchedFindingDisposition: "withhold-record",
    stubs: {
      email: "[REDACTED_EMAIL]",
      "absolute-path": "[REDACTED_PATH]",
      credential: "[REDACTED_CREDENTIAL]",
      "high-entropy-secret": "[REDACTED_HIGH_ENTROPY_SECRET]",
      "url-credential": "[REDACTED_URL_CREDENTIAL]",
      "environment-dump": "[REDACTED_ENVIRONMENT]",
      "git-identity": "[REDACTED_GIT_IDENTITY]",
      "known-identity": "[REDACTED_IDENTITY]",
      "wallet-address": "[REDACTED_WALLET]",
      "payment-instrument": "[REDACTED_PAYMENT_INSTRUMENT]",
      "ip-address": "[REDACTED_IP]",
      "machine-identity": "[REDACTED_MACHINE]",
    },
    technicalAllowlist: [],
    privateAllowlistConfigurationDigest: configurationDigest,
    resultTransform: "derive-unassessed",
  };
}

function prettyJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function artifact(
  entityId: string,
  mediaType: string,
  text: string,
): {
  entityId: string;
  bytes: Uint8Array;
  digest: string;
  mediaType: string;
} {
  const bytes = new TextEncoder().encode(text);
  return {
    entityId,
    bytes,
    digest: sha256Digest(bytes).slice("sha256:".length),
    mediaType,
  };
}

export function syntheticDerivationInput(): DeriveExecutionEvidenceInput {
  const task = artifact(
    "task/task.md",
    "text/markdown",
    "Normalize a slug deterministically.\n",
  );
  const input = artifact(
    "inputs/base-tree.txt",
    "text/plain",
    "tree synthetic-base\n",
  );
  const runtime = artifact(
    "runtime/runtime-specification.json",
    "application/json",
    '{"name":"synthetic-runtime","version":"1.0.0"}',
  );
  const runner = artifact(
    "runtime/runner.mjs",
    "text/javascript",
    "export const run = value => value;\n",
  );
  const result = artifact(
    "results/result.patch",
    "text/x-diff",
    "+export const slug = value => value.toLowerCase();\n",
  );
  const trace = artifact(
    "trace/trajectory.jsonl",
    "application/x-ndjson",
    [
      JSON.stringify({
        event: "tool",
        path: "/home/example-user/work",
        credential: "sk-synthetic-not-a-real-secret-1234567890",
        digest: `sha256:${"a".repeat(64)}`,
        transaction: `0x${"b".repeat(64)}`,
        cid: "bafkreibm6jg3ux5qu3hbutfqc3hdoclhwd3bk4ufuyt7xzhsg7cdqs2m7a",
        dsse: {
          payloadType: "application/vnd.in-toto+json",
          payload: "eyJzeW50aGV0aWMiOnRydWV9",
          signatures: [{ keyid: "synthetic", sig: "c2lnbmF0dXJl" }],
        },
        packageVersion: "1.2.3",
        modelId: "example/model-v1",
      }),
      "",
    ].join("\n"),
  );
  const all = [task, input, runtime, runner, result, trace];
  const graph = [
    {
      "@id": "ro-crate-metadata.json",
      "@type": "CreativeWork",
      conformsTo: { "@id": "https://w3id.org/ro/crate/1.3" },
      about: { "@id": "./" },
    },
    {
      "@id": "./",
      "@type": "Dataset",
      name: "Synthetic private execution",
      description: "Complete synthetic private evidence.",
      dateCreated: "2026-07-26T00:00:00Z",
      datePublished: "2026-07-26T00:00:00Z",
      license: { "@id": "https://creativecommons.org/publicdomain/zero/1.0/" },
      conformsTo: {
        "@id": "https://jinn.network/profiles/execution-evidence/1.0",
      },
      creator: {
        "@id": "urn:uuid:44444444-4444-4444-8444-444444444444",
      },
      hasPart: all.map(({ entityId }) => ({ "@id": entityId })),
      mentions: {
        "@id": "urn:uuid:22222222-2222-4222-8222-222222222222",
      },
      "prov:wasGeneratedBy": { "@id": "#capture" },
    },
    {
      "@id": "https://jinn.network/profiles/execution-evidence/1.0",
      "@type": ["CreativeWork", "Profile"],
      name: "Jinn Execution Evidence Profile 1.0",
    },
    {
      "@id": "https://creativecommons.org/publicdomain/zero/1.0/",
      "@type": "CreativeWork",
      name: "CC0 1.0 Universal",
    },
    {
      "@id": task.entityId,
      "@type": ["File", "CreativeWork", "prov:Plan"],
      name: "Synthetic task",
      encodingFormat: task.mediaType,
      sha256: task.digest,
    },
    {
      "@id": input.entityId,
      "@type": "File",
      name: "Synthetic base tree",
      encodingFormat: input.mediaType,
      sha256: input.digest,
    },
    {
      "@id": runtime.entityId,
      "@type": ["File", "SoftwareApplication"],
      name: "Synthetic runtime",
      softwareVersion: "1.0.0",
      encodingFormat: runtime.mediaType,
      sha256: runtime.digest,
      hasPart: [{ "@id": runner.entityId }],
    },
    {
      "@id": runner.entityId,
      "@type": ["File", "SoftwareSourceCode"],
      name: "Synthetic runner",
      encodingFormat: runner.mediaType,
      sha256: runner.digest,
    },
    {
      "@id": "urn:uuid:22222222-2222-4222-8222-222222222222",
      "@type": ["CreateAction", "prov:Activity"],
      name: "Synthetic execution",
      instrument: { "@id": runtime.entityId },
      object: [{ "@id": task.entityId }, { "@id": input.entityId }],
      result: { "@id": result.entityId },
      startTime: "2026-07-26T00:00:00Z",
      endTime: "2026-07-26T00:00:01Z",
      actionStatus: { "@id": "https://schema.org/CompletedActionStatus" },
      agent: {
        "@id": "urn:uuid:33333333-3333-4333-8333-333333333333",
      },
      resourceUsage: [{ "@id": "#duration-ms" }],
      subjectOf: { "@id": trace.entityId },
    },
    {
      "@id": "urn:uuid:33333333-3333-4333-8333-333333333333",
      "@type": ["SoftwareApplication", "prov:Agent"],
      name: "Synthetic executor",
    },
    {
      "@id": result.entityId,
      "@type": "File",
      name: "Synthetic result",
      encodingFormat: result.mediaType,
      sha256: result.digest,
      "prov:wasGeneratedBy": {
        "@id": "urn:uuid:22222222-2222-4222-8222-222222222222",
      },
    },
    {
      "@id": trace.entityId,
      "@type": "File",
      name: "Synthetic native trace",
      encodingFormat: trace.mediaType,
      sha256: trace.digest,
      conformsTo: {
        "@id": "https://jinn.network/formats/fixture-trajectory/1.0",
      },
      about: {
        "@id": "urn:uuid:22222222-2222-4222-8222-222222222222",
      },
    },
    {
      "@id": "https://jinn.network/formats/fixture-trajectory/1.0",
      "@type": ["CreativeWork", "Profile"],
      name: "Synthetic fixture trajectory 1.0",
    },
    {
      "@id": "#duration-ms",
      "@type": "PropertyValue",
      name: "durationMs",
      propertyID: "https://jinn.network/terms/durationMs",
      value: 1000,
      unitCode: "ms",
    },
    {
      "@id": "urn:uuid:44444444-4444-4444-8444-444444444444",
      "@type": ["SoftwareApplication", "prov:Agent"],
      name: "Synthetic capture producer",
      softwareVersion: "1.0.0",
    },
    {
      "@id": "#capture",
      "@type": "prov:Activity",
      name: "Direct capture",
      endTime: "2026-07-26T00:00:01Z",
      agent: {
        "@id": "urn:uuid:44444444-4444-4444-8444-444444444444",
      },
    },
  ];
  const sourceBytes = prettyJsonBytes({
    "@context": [
      "https://w3id.org/ro/crate/1.3/context",
      "https://w3id.org/ro/terms/workflow-run/context",
      {
        prov: "http://www.w3.org/ns/prov#",
        jinn: "https://jinn.network/terms/",
      },
    ],
    "@graph": graph,
  });
  const implementationDescriptorBytes = canonicalJsonBytes({
    schemaVersion: "jinn.evidence-derivation-implementation.v1",
    name: "@jinn-network/evidence-derivation",
    version: "0.1.0",
    buildDigest: `sha256:${"c".repeat(64)}`,
    runtime: { family: "node", version: "22" },
    detectors: baselinePolicyValue().requiredDetectors,
  });
  return {
    sourceRecord: {
      reference: {
        family: "execution-evidence",
        digest: sha256Digest(sourceBytes),
      },
      bytes: sourceBytes,
    },
    sourceArtifacts: all.map(({ entityId, bytes }) => ({ entityId, bytes })),
    policyBytes: canonicalJsonBytes(baselinePolicyValue()),
    scrubber: {
      agentId: "urn:uuid:55555555-5555-4555-8555-555555555555",
      implementationDescriptorBytes,
    },
    completedAt: "2026-07-26T01:00:00Z",
  };
}
