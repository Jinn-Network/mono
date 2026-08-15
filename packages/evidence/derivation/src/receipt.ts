// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  bytesEqual,
  canonicalJsonBytes,
  copyBytes,
  decodeUtf8,
  sha256Digest,
} from "./bytes.js";
import {
  derivationDetectorDescriptorSchema,
  derivationDigestSchema,
  implementationPackageNameSchema,
  publicRuntimeFamilySchema,
  publicVersionSchema,
} from "./descriptor-schema.js";
import { EvidenceDerivationError } from "./errors.js";
import { parseStrictJson } from "./strict-json.js";
import type {
  DerivationBindingImpact,
  DerivationDetectorDescriptor,
  DerivationRecordReference,
  DerivationSha256Digest,
  DispositionCount,
} from "./types.js";
import { compareCodeUnitStrings } from "./order.js";

const implementationSchema = z.strictObject({
  schemaVersion: z.literal("jinn.evidence-derivation-implementation.v1"),
  name: implementationPackageNameSchema,
  version: publicVersionSchema,
  buildDigest: derivationDigestSchema,
  runtime: z.strictObject({
    family: publicRuntimeFamilySchema,
    version: publicVersionSchema,
  }),
  detectors: z.array(derivationDetectorDescriptorSchema),
});

export interface ScrubberImplementationDescriptor {
  readonly schemaVersion: "jinn.evidence-derivation-implementation.v1";
  readonly name: string;
  readonly version: string;
  readonly buildDigest: DerivationSha256Digest;
  readonly runtime: {
    readonly family: string;
    readonly version: string;
  };
  readonly detectors: readonly DerivationDetectorDescriptor[];
}

export interface ParsedScrubberImplementationDescriptor {
  readonly value: ScrubberImplementationDescriptor;
  readonly bytes: Uint8Array;
  readonly digest: DerivationSha256Digest;
}

export function parseScrubberImplementationDescriptor(
  bytes: Uint8Array,
): ParsedScrubberImplementationDescriptor {
  let snapshot: Uint8Array;
  try {
    snapshot = copyBytes(bytes);
  } catch (cause) {
    throw new EvidenceDerivationError(
      "SCRUBBER_DESCRIPTOR_INVALID",
      "Scrubber implementation descriptor bytes could not be snapshotted.",
      { cause },
    );
  }
  let value: unknown;
  try {
    value = parseStrictJson(
      decodeUtf8(snapshot),
      "Scrubber implementation descriptor must be unambiguous valid JSON.",
      "SCRUBBER_DESCRIPTOR_INVALID",
    );
  } catch (cause) {
    throw new EvidenceDerivationError(
      "SCRUBBER_DESCRIPTOR_INVALID",
      "Scrubber implementation descriptor must be valid JSON.",
      { cause },
    );
  }
  const result = implementationSchema.safeParse(value);
  if (!result.success) {
    throw new EvidenceDerivationError(
      "SCRUBBER_DESCRIPTOR_INVALID",
      "Scrubber implementation descriptor schema is invalid.",
      { details: result.error.issues },
    );
  }
  const detectorIds = result.data.detectors.map(({ id }) => id);
  if (new Set(detectorIds).size !== detectorIds.length) {
    throw new EvidenceDerivationError(
      "SCRUBBER_DESCRIPTOR_INVALID",
      "Scrubber implementation detector ids must be unique.",
    );
  }
  const canonical = canonicalJsonBytes(result.data);
  if (!bytesEqual(snapshot, canonical)) {
    throw new EvidenceDerivationError(
      "SCRUBBER_DESCRIPTOR_INVALID",
      "Scrubber implementation descriptor must be canonical JSON.",
    );
  }
  return Object.freeze({
    value: result.data as ScrubberImplementationDescriptor,
    bytes: copyBytes(snapshot),
    digest: sha256Digest(snapshot),
  });
}

export interface ReceiptMapping {
  readonly sourceEntityId: string;
  readonly sourceDigest: DerivationSha256Digest;
  readonly derivedEntityId: string;
  readonly derivedDigest: DerivationSha256Digest;
}

export interface ScrubReceipt {
  readonly schemaVersion: "jinn.evidence-derivation.scrub-receipt.v1";
  readonly sourceRecord: DerivationRecordReference;
  readonly scrubber: {
    readonly agentId: string;
    readonly implementationDigest: DerivationSha256Digest;
  };
  readonly policy: {
    readonly digest: DerivationSha256Digest;
  };
  readonly privateConfigurationDigests: readonly {
    readonly detectorId: string;
    readonly configurationDigest: DerivationSha256Digest;
  }[];
  readonly completedAt: string;
  readonly mappings: readonly ReceiptMapping[];
  readonly artifacts: {
    readonly retained: number;
    readonly derived: number;
    readonly withheld: number;
  };
  readonly dispositions: readonly DispositionCount[];
  readonly reproducibility: "byte-stable" | "content-addressed";
  readonly bindingImpact: DerivationBindingImpact;
}

const receiptSchema = z.strictObject({
  schemaVersion: z.literal("jinn.evidence-derivation.scrub-receipt.v1"),
  sourceRecord: z.strictObject({
    family: z.literal("execution-evidence"),
    digest: derivationDigestSchema,
  }),
  scrubber: z.strictObject({
    agentId: z.url(),
    implementationDigest: derivationDigestSchema,
  }),
  policy: z.strictObject({ digest: derivationDigestSchema }),
  privateConfigurationDigests: z.array(
    z.strictObject({
      detectorId: z.string().min(1),
      configurationDigest: derivationDigestSchema,
    }),
  ),
  completedAt: z.iso.datetime({ offset: true }),
  mappings: z.array(
    z.strictObject({
      sourceEntityId: z.string().min(1),
      sourceDigest: derivationDigestSchema,
      derivedEntityId: z.string().min(1),
      derivedDigest: derivationDigestSchema,
    }),
  ),
  artifacts: z.strictObject({
    retained: z.number().int().nonnegative(),
    derived: z.number().int().nonnegative(),
    withheld: z.number().int().nonnegative(),
  }),
  dispositions: z.array(
    z.strictObject({
      class: z.string().min(1),
      disposition: z.enum([
        "redact",
        "withhold-artifact",
        "withhold-record",
        "review",
      ]),
      count: z.number().int().nonnegative(),
    }),
  ),
  reproducibility: z.enum(["byte-stable", "content-addressed"]),
  bindingImpact: z.strictObject({
    executionVerification: z.enum([
      "existing-verification-applicable",
      "not-transferred-to-derived-record",
    ]),
    resultEvaluation: z.enum([
      "preserved-for-exact-subjects",
      "not-transferable-to-derived-subject",
    ]),
    taskDerived: z.boolean(),
    resultDerived: z.boolean(),
  }),
});

export interface PreparedScrubReceipt {
  readonly value: ScrubReceipt;
  readonly bytes: Uint8Array;
  readonly digest: DerivationSha256Digest;
}

export interface BuildScrubReceiptInput {
  readonly sourceRecord: DerivationRecordReference;
  readonly scrubberAgentId: string;
  readonly implementationDigest: DerivationSha256Digest;
  readonly policyDigest: DerivationSha256Digest;
  readonly detectorDescriptors: readonly DerivationDetectorDescriptor[];
  readonly completedAt: string;
  readonly mappings: readonly ReceiptMapping[];
  readonly artifactCounts: {
    readonly retained: number;
    readonly derived: number;
    readonly withheld: number;
  };
  readonly dispositions: readonly DispositionCount[];
  readonly reproducibility: "byte-stable" | "content-addressed";
  readonly bindingImpact: DerivationBindingImpact;
}

function sortedCounts(
  values: readonly DispositionCount[],
): readonly DispositionCount[] {
  const grouped = new Map<string, DispositionCount>();
  for (const value of values) {
    const key = `${value.class}\u0000${value.disposition}`;
    grouped.set(key, {
      ...value,
      count: (grouped.get(key)?.count ?? 0) + value.count,
    });
  }
  return [...grouped.values()].sort(
    (left, right) =>
      compareCodeUnitStrings(left.class, right.class) ||
      compareCodeUnitStrings(left.disposition, right.disposition),
  );
}

export function buildScrubReceipt(
  input: BuildScrubReceiptInput,
): PreparedScrubReceipt {
  const value: ScrubReceipt = {
    schemaVersion: "jinn.evidence-derivation.scrub-receipt.v1",
    sourceRecord: input.sourceRecord,
    scrubber: {
      agentId: input.scrubberAgentId,
      implementationDigest: input.implementationDigest,
    },
    policy: { digest: input.policyDigest },
    privateConfigurationDigests: input.detectorDescriptors
      .flatMap((descriptorValue) =>
        descriptorValue.configurationDigest
          ? [
              {
                detectorId: descriptorValue.id,
                configurationDigest: descriptorValue.configurationDigest,
              },
            ]
          : [],
      )
      .sort((left, right) => compareCodeUnitStrings(left.detectorId, right.detectorId)),
    completedAt: input.completedAt,
    mappings: [...input.mappings].sort(
      (left, right) =>
        compareCodeUnitStrings(left.sourceEntityId, right.sourceEntityId) ||
        compareCodeUnitStrings(left.derivedEntityId, right.derivedEntityId),
    ),
    artifacts: { ...input.artifactCounts },
    dispositions: sortedCounts(input.dispositions),
    reproducibility: input.reproducibility,
    bindingImpact: { ...input.bindingImpact },
  };
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Scrub receipt input is invalid.",
      { details: parsed.error.issues },
    );
  }
  const bytes = canonicalJsonBytes(value);
  return Object.freeze({ value, bytes, digest: sha256Digest(bytes) });
}

export function parseScrubReceipt(bytes: Uint8Array): PreparedScrubReceipt {
  let snapshot: Uint8Array;
  try {
    snapshot = copyBytes(bytes);
  } catch (cause) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Scrub receipt bytes could not be snapshotted.",
      { cause },
    );
  }
  let value: unknown;
  try {
    value = parseStrictJson(
      decodeUtf8(snapshot),
      "Scrub receipt must be unambiguous valid JSON.",
      "INVALID_DERIVATION_INPUT",
    );
  } catch (cause) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Scrub receipt must be valid JSON.",
      { cause },
    );
  }
  const result = receiptSchema.safeParse(value);
  if (
    !result.success ||
    !bytesEqual(snapshot, canonicalJsonBytes(result.data))
  ) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Scrub receipt must have the v1 shape and canonical bytes.",
      { details: result.success ? undefined : result.error.issues },
    );
  }
  return Object.freeze({
    value: result.data as ScrubReceipt,
    bytes: copyBytes(snapshot),
    digest: sha256Digest(snapshot),
  });
}
