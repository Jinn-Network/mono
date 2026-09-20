// SPDX-License-Identifier: Apache-2.0

/**
 * The bundle-visible external-import marker and its claim projection (issue #3417).
 *
 * An imported run's sealed Report used to copy `LOCAL_VENUE_LIMITS` verbatim, including the
 * sentence that pinning is enforced by an admission gate at dispatch time. No venue dispatched
 * those cells. The capability `external-import` is how a `/10` bundle says so: the marker is a
 * mandatory member, the claim carries a section derived from it, and both claim-consistency
 * implementations rebuild an import-aware disclosure from the declared vector rather than from
 * the Run record (which was sealed at lock, before import exists).
 *
 * The marker names the dump's own digest so a reader can bind published records to the file the
 * operator read, and it carries the per-slot reasons that were otherwise workspace-local.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { refuse } from "./errors.js";

export const EXTERNAL_IMPORT_BUNDLE_MEMBER = "external-import.json" as const;

export const EXTERNAL_IMPORT_MARKER_PROTOCOL =
  "https://spec.jinn.network/benchmark-product/external-import-marker/v1" as const;

export const IMPORTED_RUN_PINNING_LIMIT =
  "Run pinning on the harness, model, and loadout axes is unverifiable: this run's results were imported from an external harness dump, so no venue dispatched these cells and no admission gate saw the attempt.";

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u, "must be a lowercase sha256 hex digest");

const SourceSchema = z.object({
  harness: z.string().min(1),
  version: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
}).strict();

const MarkerRowSchema = z.object({
  cellKey: z.string().min(1),
  outcome: z.enum(["graded", "ungradeable", "error", "timeout", "unrun"]),
  reason: z.string().min(1).optional(),
}).strict();

export const ExternalImportMarkerSchema = z.object({
  protocol: z.literal(EXTERNAL_IMPORT_MARKER_PROTOCOL),
  dump: z.object({
    sha256: Sha256HexSchema,
    byteLength: z.number().int().nonnegative(),
  }).strict(),
  declarationSha256: Sha256HexSchema,
  source: SourceSchema,
  rows: z.array(MarkerRowSchema).min(1),
}).strict();

export type ExternalImportMarker = z.infer<typeof ExternalImportMarkerSchema>;

export const ClaimExternalImportSectionSchema = z.object({
  dumpSha256: Sha256HexSchema,
  dumpByteLength: z.number().int().nonnegative(),
  declarationSha256: Sha256HexSchema,
  source: SourceSchema,
  rows: z.array(MarkerRowSchema).min(1),
}).strict();

export type ClaimExternalImportSection = z.infer<typeof ClaimExternalImportSectionSchema>;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The claim section is a projection of the authenticated marker, never a second opinion. */
export function deriveClaimExternalImport(marker: ExternalImportMarker): ClaimExternalImportSection {
  return {
    dumpSha256: marker.dump.sha256,
    dumpByteLength: marker.dump.byteLength,
    declarationSha256: marker.declarationSha256,
    source: { ...marker.source },
    rows: marker.rows.map((row) => ({
      cellKey: row.cellKey,
      outcome: row.outcome,
      ...(row.reason === undefined ? {} : { reason: row.reason }),
    })),
  };
}

export function parseExternalImportMarker(bytes: Uint8Array): ExternalImportMarker {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("record-integrity", EXTERNAL_IMPORT_BUNDLE_MEMBER, `${EXTERNAL_IMPORT_BUNDLE_MEMBER} is not valid UTF-8 JSON`);
  }
  const parsed = ExternalImportMarkerSchema.safeParse(raw);
  if (!parsed.success) {
    refuse(
      "record-integrity",
      EXTERNAL_IMPORT_BUNDLE_MEMBER,
      `${EXTERNAL_IMPORT_BUNDLE_MEMBER} does not satisfy its public bundle schema`,
    );
  }
  if (Buffer.from(canonicalJsonBytes(parsed.data)).equals(Buffer.from(bytes)) !== true) {
    refuse(
      "record-integrity",
      EXTERNAL_IMPORT_BUNDLE_MEMBER,
      `${EXTERNAL_IMPORT_BUNDLE_MEMBER} is not the exact canonical encoding`,
    );
  }
  return parsed.data;
}

/**
 * Authenticates the marker and pairs it with the claim section. Matrix coverage is exact: every
 * sealed slot appears once, and there is no extra row. The dump digest is a hex string the schema
 * already checked; this check does not re-hash a dump the bundle does not carry.
 */
export function assertExternalImport(input: {
  readonly bytes: Uint8Array;
  readonly claim: { readonly externalImport?: ClaimExternalImportSection };
  readonly matrixCellKeys: readonly string[];
}): void {
  const marker = parseExternalImportMarker(input.bytes);
  const expectedKeys = [...input.matrixCellKeys].sort();
  const actualKeys = marker.rows.map((row) => row.cellKey).sort();
  if (new Set(actualKeys).size !== actualKeys.length) {
    refuse(
      "record-integrity",
      EXTERNAL_IMPORT_BUNDLE_MEMBER,
      `${EXTERNAL_IMPORT_BUNDLE_MEMBER} names a cellKey more than once`,
    );
  }
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    refuse(
      "record-integrity",
      EXTERNAL_IMPORT_BUNDLE_MEMBER,
      `${EXTERNAL_IMPORT_BUNDLE_MEMBER} rows are not exactly the sealed Matrix cell keys`,
    );
  }
  const expected = deriveClaimExternalImport(marker);
  if (input.claim.externalImport === undefined) {
    refuse(
      "record-integrity",
      "claim-consistency",
      "a bundle declaring external-import must carry its claim section",
    );
  }
  if (!Buffer.from(canonicalJsonBytes(input.claim.externalImport)).equals(Buffer.from(canonicalJsonBytes(expected)))) {
    refuse(
      "record-integrity",
      "external-import",
      "claim externalImport section is not the exact projection of the authenticated marker",
    );
  }
}

/** Canonical marker bytes a producer seals. The schema parse is the grammar; canonical JSON is
 * the encoding the verifier byte-compares. */
export function buildExternalImportMarker(input: {
  readonly dump: { readonly sha256: string; readonly byteLength: number };
  readonly declarationSha256: string;
  readonly source: { readonly harness: string; readonly version?: string; readonly note?: string };
  readonly rows: readonly {
    readonly cellKey: string;
    readonly outcome: "graded" | "ungradeable" | "error" | "timeout" | "unrun";
    readonly reason?: string;
  }[];
}): ExternalImportMarker {
  return ExternalImportMarkerSchema.parse({
    protocol: EXTERNAL_IMPORT_MARKER_PROTOCOL,
    dump: input.dump,
    declarationSha256: input.declarationSha256,
    source: input.source,
    rows: input.rows.map((row) => ({
      cellKey: row.cellKey,
      outcome: row.outcome,
      ...(row.reason === undefined ? {} : { reason: row.reason }),
    })),
  });
}

export function canonicalExternalImportMarkerBytes(marker: ExternalImportMarker): Uint8Array {
  return canonicalJsonBytes(marker);
}

export function dumpIdentityFromBytes(bytes: Uint8Array): { readonly sha256: string; readonly byteLength: number } {
  return { sha256: sha256Hex(bytes), byteLength: bytes.length };
}
