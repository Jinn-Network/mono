import { z } from "zod";

import { DigestPinnedDescriptorSchema, NonEmpty, PrefixedSha256 } from "./primitives.js";

/**
 * K inherits the parent floor (E4). The record may ask for more repetitions; it may not ask
 * for fewer, and the schema is where that floor stops being advice.
 */
export const MINIMUM_VERIFICATION_RUNS = 5 as const;

/**
 * What a verifier is contracted to do with this world (§4.3). Results never live here — they
 * append as separately published attestations, so there is no outcome, status, or timestamp
 * member and the object is strict.
 */
export const VerificationContractSchema = z
  .strictObject({
    probeSuite: z.strictObject({
      descriptor: DigestPinnedDescriptorSchema,
      format: z.strictObject({ id: NonEmpty, version: NonEmpty }),
    }),
    observationSchema: DigestPinnedDescriptorSchema,
    /**
     * The digest of the canonical observation a conforming run is expected to reproduce. The
     * observation's own shape is owned by the evaluation family's canonical-observation schema,
     * not by this package; the record commits to the digest of the expected value.
     */
    baselineObservationDigest: PrefixedSha256,
    comparator: z.strictObject({ id: NonEmpty, version: NonEmpty, digest: PrefixedSha256 }),
    closureCheckRequired: z.boolean(),
    resetRequirements: z.strictObject({
      /**
       * Snapshot/revert cycles inside one process are a testing convenience, never repetition:
       * they cannot catch startup, artifact-load, cache, or process-global drift (§5.1 step 8).
       */
      freshInstancePerRun: z.literal(true),
      minimumRuns: z.number().int().min(MINIMUM_VERIFICATION_RUNS).max(Number.MAX_SAFE_INTEGER),
    }),
    /** Per-fixture-module smoke coverage: each module answers probes that exercise it (§5.1 step 6). */
    fixtureProbeCoverage: z.array(
      z.strictObject({
        fixtureId: NonEmpty,
        probeIds: z.array(NonEmpty).min(1, "a declared fixture must name at least one probe"),
      }),
    ),
    policyId: NonEmpty,
  })
  .superRefine((contract, ctx) => {
    const seen = new Set<string>();
    contract.fixtureProbeCoverage.forEach((entry, index) => {
      if (seen.has(entry.fixtureId)) {
        ctx.addIssue({
          code: "custom",
          path: ["fixtureProbeCoverage", index, "fixtureId"],
          message: `duplicate probe-coverage declaration for fixture "${entry.fixtureId}"`,
        });
      }
      seen.add(entry.fixtureId);
    });
  });

export type VerificationContract = z.infer<typeof VerificationContractSchema>;
