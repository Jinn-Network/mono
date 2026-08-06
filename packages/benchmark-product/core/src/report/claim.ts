/**
 * The claim package (BP-13 deliverable 2, spec §8.2): a pure builder + a zod schema + a writer
 * for the standalone, portable document a skeptic reads to check a benchmark result without
 * re-running anything.
 *
 * `buildClaimPackage` is PURE — no filesystem, no digest recomputation, no re-derivation of the
 * sealed Report's own judgment. Every headline number, disclosure, limitation, and attrition
 * figure is EXTRACTED verbatim from the records the caller already sealed and verified elsewhere
 * (`../operations/report.ts`), never recomputed here — a claim package that silently disagreed
 * with its own cited report would be worse than one that failed to build. Nothing is dropped:
 * `conflicted`, `completeness`, and `attrition` are always present, even when they carry
 * unwelcome numbers (a conflicted cell, an incomplete run) — spec §8.2's whole point is that the
 * claim package cannot be more flattering than the sealed records it cites.
 */

import { z } from "zod";
import type { MatrixRecord, ReportRecord, RunRecord } from "@jinn-network/benchmarking-records";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { claimPackageArtifactPath } from "../workspace/layout.js";
import type { VenueHonesty } from "../operations/run-results.js";

/** The published CLI bin name (`package.json`'s `bin` field) — not `PRODUCT_BRANDING` (which
 * carries display name/tagline/attribution copy, not the invocation name a terminal runs). */
const CLI_BIN_NAME = "benchmark-product";

export const CLAIM_PACKAGE_SCHEMA_ID = "benchmark-product.claim-package/1";

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase sha256 hex digest");

const WilsonIntervalSchema = z.object({ low: z.string(), high: z.string() });
const HeadlineArmSchema = z.object({
  n: z.number().int().nonnegative(),
  passRate: z.string(),
  wilsonInterval: WilsonIntervalSchema,
});

const ConflictedSchema = z.object({
  count: z.number().int().nonnegative(),
  cellKeys: z.array(z.string()),
});

const IntegrityTierCountsSchema = z.object({
  "re-derivable": z.number().int().nonnegative(),
  "attested-only": z.number().int().nonnegative(),
});

const PinningUnverifiableCountsSchema = z.object({
  harness: z.number().int().nonnegative(),
  model: z.number().int().nonnegative(),
  loadout: z.number().int().nonnegative(),
  isolation: z.number().int().nonnegative(),
});

/** The report's own disclosures block, carried whole, plus the two convenience summaries this
 * module adds (never a substitute for reading `perSubject` itself). */
const DisclosuresSchema = z.object({
  perSubject: z.array(z.unknown()),
  integrityTierCounts: IntegrityTierCountsSchema,
  pinningUnverifiableCounts: PinningUnverifiableCountsSchema,
});

export const ClaimPackageSchema = z.object({
  claimSchema: z.literal(CLAIM_PACKAGE_SCHEMA_ID),
  scope: z.object({
    draftId: z.string().min(1),
    benchmarkSha256: Sha256HexSchema,
    taskCount: z.number().int().nonnegative(),
    arms: z.array(z.object({ armId: z.string().min(1), pinning: z.record(z.string(), z.unknown()) })),
    replicates: z.number().int().positive(),
    venue: z.literal("self-run"),
  }),
  records: z.object({
    benchmarkSha256: Sha256HexSchema,
    runSha256: Sha256HexSchema,
    matrixSha256: Sha256HexSchema,
    reportSha256: Sha256HexSchema,
    reportEnvelopeSha256: Sha256HexSchema,
  }),
  method: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()),
    preregistered: z.boolean(),
  }),
  results: z.unknown(),
  headline: z.record(z.string(), HeadlineArmSchema),
  completeness: z.unknown(),
  attrition: z.unknown(),
  conflicted: ConflictedSchema,
  disclosures: DisclosuresSchema,
  limitations: z.array(z.string()),
  venueHonesty: z.unknown(),
  verification: z.object({
    command: z.string().min(1),
    checks: z.array(z.string().min(1)).min(1),
    trustRoot: z.string().min(1),
  }),
});

export type ClaimPackage = z.infer<typeof ClaimPackageSchema>;

export interface BuildClaimPackageInput {
  readonly draftId: string;
  readonly benchmarkSha256: string;
  readonly runRecord: RunRecord;
  readonly runSha256: string;
  readonly matrixRecord: MatrixRecord;
  readonly matrixSha256: string;
  readonly reportRecord: ReportRecord;
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
  readonly venueHonesty: VenueHonesty;
  /** The CLI verb this package's `verification.command` names, e.g. `"verify"`. */
  readonly verificationCommandVerb: string;
}

interface WilsonSubjectResults {
  readonly arms: Record<string, unknown>;
  readonly conflicted: { readonly count: number; readonly cellKeys: readonly string[] };
}

/** M1's only wired method (`../run/compile.ts` hardcodes `wilson@1`) — this narrow, local shape
 * check is deliberately not a general Method-results parser; a mismatch here means the sealed
 * Report was not produced by wilson@1, which this product never does today. */
function wilsonSubjectResults(reportRecord: ReportRecord): WilsonSubjectResults {
  const results = reportRecord.results as { readonly perSubject?: readonly { readonly results?: unknown }[] } | undefined;
  const perSubject = results?.perSubject;
  if (!Array.isArray(perSubject) || perSubject.length !== 1) {
    throw new Error("claim package: expected exactly one Report subject (wilson@1's single-Matrix results shape)");
  }
  const subjectResults = perSubject[0]?.results as
    | { readonly arms?: unknown; readonly conflicted?: { readonly count?: unknown; readonly cellKeys?: unknown } }
    | undefined;
  if (
    typeof subjectResults?.arms !== "object" || subjectResults.arms === null
    || typeof subjectResults.conflicted?.count !== "number"
    || !Array.isArray(subjectResults.conflicted.cellKeys)
  ) {
    throw new Error("claim package: Report results do not carry wilson@1's arms/conflicted shape");
  }
  return {
    arms: subjectResults.arms as Record<string, unknown>,
    conflicted: {
      count: subjectResults.conflicted.count,
      cellKeys: subjectResults.conflicted.cellKeys as readonly string[],
    },
  };
}

interface DisclosurePerSubjectShape {
  readonly integrityTiers: { readonly "re-derivable": number; readonly "attested-only": number };
  readonly pinning: Record<"harness" | "model" | "loadout" | "isolation", { readonly unverifiable: number }>;
}

function summedIntegrityTierCounts(perSubject: readonly DisclosurePerSubjectShape[]) {
  const counts = { "re-derivable": 0, "attested-only": 0 };
  for (const subject of perSubject) {
    counts["re-derivable"] += subject.integrityTiers["re-derivable"];
    counts["attested-only"] += subject.integrityTiers["attested-only"];
  }
  return counts;
}

const PINNING_AXES = ["harness", "model", "loadout", "isolation"] as const;

function summedPinningUnverifiableCounts(perSubject: readonly DisclosurePerSubjectShape[]) {
  const counts = { harness: 0, model: 0, loadout: 0, isolation: 0 };
  for (const subject of perSubject) {
    for (const axis of PINNING_AXES) counts[axis] += subject.pinning[axis].unverifiable;
  }
  return counts;
}

const VERIFICATION_CHECKS: readonly string[] = [
  "sealed-store digest re-verification on read (every referenced record's exact bytes are re-hashed against their own digest)",
  "matrix re-derivation (verifyMatrix byte-compare against the exact recomputed Matrix)",
  "report DSSE signature, method recompute, preregistration, and disclosures (verifyReport)",
  "claim-package digest and content consistency against the records it cites",
];

/** Builds the claim package document (spec §8.2) from explicit, already-sealed record data. Pure
 * — no filesystem access, no recomputation of anything the cited records already settled. */
export function buildClaimPackage(input: BuildClaimPackageInput): ClaimPackage {
  const { reportRecord } = input;
  const wilsonResults = wilsonSubjectResults(reportRecord);
  const disclosuresPerSubject = (reportRecord.disclosures?.perSubject ?? []) as readonly DisclosurePerSubjectShape[];
  const taskCount = new Set(input.matrixRecord.cells.map((cell) => cell.taskDigest)).size;

  return {
    claimSchema: CLAIM_PACKAGE_SCHEMA_ID,
    scope: {
      draftId: input.draftId,
      benchmarkSha256: input.benchmarkSha256,
      taskCount,
      arms: input.runRecord.arms.map((arm) => ({ armId: arm.armId, pinning: arm.pinning as Record<string, unknown> })),
      replicates: input.runRecord.replicates,
      venue: "self-run",
    },
    records: {
      benchmarkSha256: input.benchmarkSha256,
      runSha256: input.runSha256,
      matrixSha256: input.matrixSha256,
      reportSha256: input.reportSha256,
      reportEnvelopeSha256: input.reportEnvelopeSha256,
    },
    method: {
      id: reportRecord.method.id,
      version: reportRecord.method.version,
      parameters: reportRecord.method.parameters,
      preregistered: reportRecord.preregistered ?? false,
    },
    results: reportRecord.results,
    headline: wilsonResults.arms as ClaimPackage["headline"],
    completeness: input.matrixRecord.completeness,
    attrition: input.matrixRecord.attrition,
    conflicted: { count: wilsonResults.conflicted.count, cellKeys: [...wilsonResults.conflicted.cellKeys] },
    disclosures: {
      perSubject: (reportRecord.disclosures?.perSubject ?? []) as unknown[],
      integrityTierCounts: summedIntegrityTierCounts(disclosuresPerSubject),
      pinningUnverifiableCounts: summedPinningUnverifiableCounts(disclosuresPerSubject),
    },
    limitations: [...(reportRecord.limitations ?? [])],
    venueHonesty: input.venueHonesty,
    verification: {
      command: `${CLI_BIN_NAME} ${input.verificationCommandVerb} --workspace <dir> --draft ${input.draftId} [--json]`,
      checks: [...VERIFICATION_CHECKS],
      trustRoot: "Signatures verify against this workspace's own report key; there is no third-party trust anchor on the self-run venue.",
    },
  };
}

/** Validates and atomically writes the claim package to `claimPackageArtifactPath`. */
export function writeClaimPackage(workspaceDir: string, draftId: string, claim: ClaimPackage): void {
  const validated = ClaimPackageSchema.parse(claim);
  atomicWriteFileSync(claimPackageArtifactPath(workspaceDir, draftId), JSON.stringify(validated, null, 2));
}
