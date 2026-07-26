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
} from "./descriptor-schema.js";
import { EvidenceDerivationError } from "./errors.js";
import { parseStrictJson } from "./strict-json.js";
import {
  PROTECTED_VALUE_CLASSES,
  type DerivationPolicy,
  type ParsedDerivationPolicy,
} from "./types.js";

const selector = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith("/") &&
      value
        .slice(1)
        .split("/")
        .every((segment) => segment !== "" && segment !== "**"),
    "invalid metadata selector",
  );
const protectedDispositions = z.strictObject(
  Object.fromEntries(
    PROTECTED_VALUE_CLASSES.map((name) => [
      name,
      z.enum(["retain", "withhold-record"]),
    ]),
  ) as Record<
    (typeof PROTECTED_VALUE_CLASSES)[number],
    z.ZodEnum<{ retain: "retain"; "withhold-record": "withhold-record" }>
  >,
);

const policySchema = z.strictObject({
  schemaVersion: z.literal("jinn.evidence-derivation-policy.v1"),
  name: z.string().min(1),
  version: z.string().min(1),
  reproducibility: z.enum(["byte-stable", "content-addressed"]),
  requiredDetectors: z.array(derivationDetectorDescriptorSchema),
  transformableMetadata: z.array(selector),
  protectedMetadata: z.array(selector),
  protectedValueDispositions: protectedDispositions,
  artifactRules: z.array(
    z.strictObject({
      mediaType: z.string().min(1),
      roles: z.array(
        z.enum([
          "task",
          "result",
          "runtime-specification",
          "runtime-component",
          "native-trace",
          "input",
          "evidence",
          "other",
        ]),
      ),
      codec: z.enum(["text", "json", "jsonl", "signed", "binary"]),
      unavailable: z.enum(["retain-commitment", "withhold-record"]),
    }),
  ),
  defaultArtifactDisposition: z.enum(["withhold-artifact", "withhold-record"]),
  dispositions: z.array(
    z.strictObject({
      class: z.string().min(1),
      minimumConfidence: z.enum([
        "VERY_LOW",
        "LOW",
        "MEDIUM",
        "HIGH",
        "VERY_HIGH",
      ]),
      disposition: z.enum([
        "retain",
        "redact",
        "withhold-artifact",
        "withhold-record",
        "review",
      ]),
    }),
  ),
  unmatchedFindingDisposition: z.enum(["review", "withhold-record"]),
  stubs: z.record(z.string(), z.string()),
  technicalAllowlist: z.array(z.string()),
  privateAllowlistConfigurationDigest: derivationDigestSchema.optional(),
  resultTransform: z.enum(["derive-unassessed", "withhold-record"]),
});

function invalid(message: string, cause?: unknown): never {
  throw new EvidenceDerivationError("POLICY_INVALID", message, { cause });
}

export function parseDerivationPolicy(
  bytes: Uint8Array,
): ParsedDerivationPolicy {
  let snapshot: Uint8Array;
  try {
    snapshot = copyBytes(bytes);
  } catch (cause) {
    invalid("Policy bytes could not be snapshotted.", cause);
  }
  let json: unknown;
  try {
    json = parseStrictJson(
      decodeUtf8(snapshot),
      "Policy must be unambiguous valid UTF-8 JSON.",
      "POLICY_INVALID",
    );
  } catch (cause) {
    invalid("Policy must be valid UTF-8 JSON.", cause);
  }
  const result = policySchema.safeParse(json);
  if (!result.success) {
    invalid("Policy schema is invalid.", result.error.issues);
  }
  const value = result.data as DerivationPolicy;
  const ids = value.requiredDetectors.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    invalid("detector ids must be unique");
  }
  if (
    value.privateAllowlistConfigurationDigest !== undefined &&
    !value.requiredDetectors.some(
      ({ configurationDigest }) =>
        configurationDigest === value.privateAllowlistConfigurationDigest,
    )
  ) {
    invalid(
      "private allowlist configuration digest must match a required detector commitment",
    );
  }
  const dispositionKeys = value.dispositions.map(
    ({ class: classification, minimumConfidence }) =>
      `${classification}\u0000${minimumConfidence}`,
  );
  if (new Set(dispositionKeys).size !== dispositionKeys.length) {
    invalid("disposition class/confidence rows must be unique");
  }
  const dispositionClasses = new Set(
    value.dispositions.map(({ class: classification }) => classification),
  );
  for (const classification of dispositionClasses) {
    if (
      !value.dispositions.some(
        (row) =>
          row.class === classification &&
          row.minimumConfidence === "VERY_LOW",
      )
    ) {
      invalid(`disposition class ${classification} requires a VERY_LOW floor`);
    }
  }
  for (const row of value.dispositions) {
    if (row.disposition === "redact" && value.stubs[row.class] === undefined) {
      invalid(`redact class ${row.class} requires a stub`);
    }
  }
  const canonical = canonicalJsonBytes(value);
  if (!bytesEqual(snapshot, canonical)) {
    invalid("Policy bytes must be RFC 8785 canonical JSON.");
  }
  return Object.freeze({
    value: deepFreeze(value),
    bytes: copyBytes(snapshot),
    digest: sha256Digest(snapshot),
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
