// SPDX-License-Identifier: Apache-2.0

import type { EnvironmentRecord } from "@jinn-network/environment-record";
import { z } from "zod";
import { ENVIRONMENT_RECORD_SPEC_KEY } from "./identifiers.js";
import { refuse } from "./refusals.js";

const BARE_SHA256 = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * The narrowest possible mirror of the fields admission compares. Structurally a subset of
 * `DETERMINISTIC_PROCESS_SHAPE` in
 * `packages/task-execution/profiles/src/evaluation-spec/family-blocks.ts` — read, never imported
 * (design §3.3: admission consumes environments/record types and digests only). Loose objects:
 * every other field of a real EvaluationSpec passes through untouched.
 */
const InlineImageSchema = z.looseObject({
  uri: z.string().optional(),
  digest: z.record(z.string(), z.string()).optional(),
});

const InlineParserSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  digest: z.string().regex(PREFIXED_SHA256),
});

const InlineTestMaterialSchema = z.looseObject({
  digest: z.record(z.string(), z.string()),
});

const InlineTransitionsSchema = z.looseObject({
  failToPass: z.array(z.string().min(1)),
  passToPass: z.array(z.string().min(1)),
});

/**
 * `testMaterial` and `transitions` are required here — not decoration: they are what the grader
 * scores against, and admission reconciles both with the candidate's declared sets
 * (candidate-spec.ts). A block missing either is not a gradeable deterministic-process block.
 */
const InlineProcessBlockSchema = z.looseObject({
  image: InlineImageSchema,
  platform: z.string().min(1),
  parser: InlineParserSchema,
  testMaterial: z.array(InlineTestMaterialSchema),
  transitions: InlineTransitionsSchema,
});

export type InlineProcessBlock = z.infer<typeof InlineProcessBlockSchema>;

const EvaluationSpecShellSchema = z.looseObject({
  family: z.string(),
  familyBlock: z.unknown(),
});

const SpecEnvironmentReferenceSchema = z.looseObject({
  digest: z.looseObject({ sha256: z.string() }),
});

/** What the receipt records about the check having run (design §7.1). */
export interface InlineMatchReport {
  readonly fields: readonly ["image", "parser", "platform"];
  readonly specKeyPresent: boolean;
}

function sha256FromDigestSet(
  digest: Record<string, string> | undefined,
  label: string,
): string | undefined {
  if (digest === undefined) return undefined;
  const value = digest["sha256"];
  if (value === undefined) return undefined;
  if (!BARE_SHA256.test(value)) {
    refuse(
      "invalid-candidate",
      `${label} DigestSet sha256 must be bare lowercase hex (in-toto DigestSet values are never sha256:-prefixed)`,
    );
  }
  return `sha256:${value}`;
}

function manifestDigestFromDigestSet(digest: Record<string, string> | undefined): string | undefined {
  return sha256FromDigestSet(digest, "inline image");
}

/**
 * Read the block's `{family, familyBlock}` shell and its deterministic-process block. Exported so
 * the environment rule (below) and the candidate-consistency rule (candidate-spec.ts) read one
 * shape, not two.
 */
export function readInlineProcessBlock(evaluationSpec: unknown): InlineProcessBlock {
  const shell = EvaluationSpecShellSchema.safeParse(evaluationSpec);
  if (!shell.success) {
    refuse("invalid-candidate", "the candidate EvaluationSpec is not a { family, familyBlock } document");
  }
  if (shell.data.family !== "deterministic-process") {
    refuse(
      "invalid-candidate",
      `admission grades the deterministic-process family only, not "${shell.data.family}"`,
    );
  }
  const block = InlineProcessBlockSchema.safeParse(shell.data.familyBlock);
  if (!block.success) {
    refuse("invalid-candidate", `the inline deterministic-process block is malformed: ${block.error.message}`);
  }
  return block.data;
}

/** The sha256 digests of the material the sealed spec grades against, in `sha256:` spelling. */
export function testMaterialDigestsOf(block: InlineProcessBlock): string[] {
  return block.testMaterial.map((material, index) => {
    const digest = sha256FromDigestSet(material.digest, `inline test material ${index}`);
    if (digest === undefined) {
      refuse("invalid-candidate", `inline test material ${index} carries no sha256 digest`);
    }
    return digest;
  });
}

function manifestDigestFromReference(uri: string | undefined): string | undefined {
  if (uri === undefined) return undefined;
  const marker = uri.lastIndexOf("@");
  if (marker < 0) return undefined;
  const candidate = uri.slice(marker + 1);
  if (!PREFIXED_SHA256.test(candidate)) {
    refuse("invalid-candidate", `inline image reference "${uri}" does not end with @sha256:<64 hex>`);
  }
  return candidate;
}

/**
 * Normative rule 1 (design §7.1). The candidate's inline `image` (manifest digest via its
 * reference), `platform`, and `parser` MUST equal the referenced record's. A pair that grades
 * against one image while citing another record's digest is refused here, before it can earn a
 * receipt and inherit evidence it was never entitled to.
 *
 * The record's advisory `parser.uri` is deliberately not compared: the inline parser identity is
 * strict `{id, version, digest}`, and the digest is the authority.
 */
export function checkInlineEnvironmentMatch(
  record: EnvironmentRecord,
  evaluationSpec: unknown,
  expectedRecordDigest: string,
): InlineMatchReport {
  const block = readInlineProcessBlock(evaluationSpec);

  const fromDigestSet = manifestDigestFromDigestSet(block.image.digest);
  const fromReference = manifestDigestFromReference(block.image.uri);
  if (fromDigestSet === undefined && fromReference === undefined) {
    refuse("invalid-candidate", "the inline image carries no manifest digest (needs a DigestSet or an @sha256: reference)");
  }
  if (fromDigestSet !== undefined && fromReference !== undefined && fromDigestSet !== fromReference) {
    refuse("invalid-candidate", "the inline image reference and DigestSet disagree on the manifest digest");
  }
  const inlineManifest = fromDigestSet ?? (fromReference as string);
  if (inlineManifest !== record.image.manifestDigest) {
    refuse(
      "env-record-mismatch",
      `inline image manifest digest ${inlineManifest} is not the record's ${record.image.manifestDigest}`,
    );
  }
  if (block.platform !== record.image.platform) {
    refuse(
      "env-record-mismatch",
      `inline platform ${block.platform} is not the record's ${record.image.platform}`,
    );
  }
  if (
    block.parser.id !== record.parser.id
    || block.parser.version !== record.parser.version
    || block.parser.digest !== record.parser.digest
  ) {
    refuse(
      "env-record-mismatch",
      `inline parser ${block.parser.id}@${block.parser.version} (${block.parser.digest}) is not the record's `
        + `${record.parser.id}@${record.parser.version} (${record.parser.digest})`,
    );
  }

  const specKey = (block as Record<string, unknown>)[ENVIRONMENT_RECORD_SPEC_KEY];
  let specKeyPresent = false;
  if (specKey !== undefined) {
    const reference = SpecEnvironmentReferenceSchema.safeParse(specKey);
    if (!reference.success) {
      refuse("invalid-candidate", `${ENVIRONMENT_RECORD_SPEC_KEY} must be { digest: { sha256 } }`);
    }
    const hex = reference.data.digest.sha256;
    if (!BARE_SHA256.test(hex)) {
      refuse("invalid-candidate", `${ENVIRONMENT_RECORD_SPEC_KEY} sha256 must be bare lowercase hex`);
    }
    if (`sha256:${hex}` !== expectedRecordDigest) {
      refuse(
        "env-record-mismatch",
        `${ENVIRONMENT_RECORD_SPEC_KEY} names sha256:${hex}, not the record admission was given (${expectedRecordDigest})`,
      );
    }
    specKeyPresent = true;
  }

  return { fields: ["image", "parser", "platform"], specKeyPresent };
}
