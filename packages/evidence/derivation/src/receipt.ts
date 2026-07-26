import { z } from "zod";

import {
  bytesEqual,
  canonicalJsonBytes,
  copyBytes,
  decodeUtf8,
  sha256Digest,
} from "./bytes.js";
import { EvidenceDerivationError } from "./errors.js";
import type {
  DerivationBindingImpact,
  DerivationDetectorDescriptor,
  DerivationRecordReference,
  DerivationSha256Digest,
  DispositionCount,
} from "./types.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const detector = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  implementationDigest: digest,
  reproducibility: z.enum(["byte-stable", "best-effort"]),
  configurationDigest: digest.optional(),
});
const implementationSchema = z.strictObject({
  schemaVersion: z.literal("jinn.evidence-derivation-implementation.v1"),
  name: z.string().min(1),
  version: z.string().min(1),
  buildDigest: digest,
  runtime: z.strictObject({
    family: z.string().min(1),
    version: z.string().min(1),
  }),
  detectors: z.array(detector),
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
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes));
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
  const canonical = canonicalJsonBytes(result.data);
  if (!bytesEqual(bytes, canonical)) {
    throw new EvidenceDerivationError(
      "SCRUBBER_DESCRIPTOR_INVALID",
      "Scrubber implementation descriptor must be canonical JSON.",
    );
  }
  return Object.freeze({
    value: result.data as ScrubberImplementationDescriptor,
    bytes: copyBytes(bytes),
    digest: sha256Digest(bytes),
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
    digest,
  }),
  scrubber: z.strictObject({
    agentId: z.url(),
    implementationDigest: digest,
  }),
  policy: z.strictObject({ digest }),
  privateConfigurationDigests: z.array(
    z.strictObject({
      detectorId: z.string().min(1),
      configurationDigest: digest,
    }),
  ),
  completedAt: z.iso.datetime({ offset: true }),
  mappings: z.array(
    z.strictObject({
      sourceEntityId: z.string().min(1),
      sourceDigest: digest,
      derivedEntityId: z.string().min(1),
      derivedDigest: digest,
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
      left.class.localeCompare(right.class) ||
      left.disposition.localeCompare(right.disposition),
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
      .sort((left, right) => left.detectorId.localeCompare(right.detectorId)),
    completedAt: input.completedAt,
    mappings: [...input.mappings].sort(
      (left, right) =>
        left.sourceEntityId.localeCompare(right.sourceEntityId) ||
        left.derivedEntityId.localeCompare(right.derivedEntityId),
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
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes));
  } catch (cause) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Scrub receipt must be valid JSON.",
      { cause },
    );
  }
  const result = receiptSchema.safeParse(value);
  if (!result.success || !bytesEqual(bytes, canonicalJsonBytes(result.data))) {
    throw new EvidenceDerivationError(
      "INVALID_DERIVATION_INPUT",
      "Scrub receipt must have the v1 shape and canonical bytes.",
      { details: result.success ? undefined : result.error.issues },
    );
  }
  return Object.freeze({
    value: result.data as ScrubReceipt,
    bytes: copyBytes(bytes),
    digest: sha256Digest(bytes),
  });
}
