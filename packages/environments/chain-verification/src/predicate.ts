// SPDX-License-Identifier: Apache-2.0

import { isCalendarStrictRfc3339 } from "@jinn-network/trust-core";
import { z } from "zod";

import { PrefixedSha256Schema, ResourceDescriptorSchema } from "./digests.js";
import { invalidInput } from "./errors.js";
import {
  CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI,
  MINIMUM_RUN_COUNT,
} from "./identifiers.js";
import {
  CHAIN_VERIFICATION_FAILURE_REASONS,
  CHAIN_VERIFICATION_OUTCOMES,
  CHAIN_VERIFICATION_STAGES,
  isRunBearingOutcome,
  outcomeForFailureReason,
  stageForFailureReason,
} from "./outcomes.js";

const QuantitySchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u, "must be a decimal quantity");
const AddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/u, "must be a lowercase 0x address");
const Word32Schema = z.string().regex(/^0x[0-9a-f]{64}$/u, "must be a lowercase 0x 32-byte word");

const Rfc3339UtcSchema = z
  .string()
  .refine(isCalendarStrictRfc3339, "must be a calendar-strict RFC 3339 timestamp")
  .refine((value) => value.endsWith("Z"), "must be expressed in UTC with a trailing Z");

/** When the runs happened. Inside the signed payload on purpose: a re-announced old
 * attestation cannot present itself as fresh (design §5.3). */
export const VerificationWindowSchema = z
  .strictObject({ startedAt: Rfc3339UtcSchema, endedAt: Rfc3339UtcSchema })
  .refine((window) => window.startedAt <= window.endedAt, {
    message: "window.endedAt must not precede window.startedAt",
    path: ["endedAt"],
  });
export type VerificationWindow = z.infer<typeof VerificationWindowSchema>;

/** Host-declared: a library cannot truthfully digest its own build (design §5.3). */
export const VerifierIdentitySchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  digest: PrefixedSha256Schema,
});
export type VerifierIdentity = z.infer<typeof VerifierIdentitySchema>;

export const CLOSURE_CLASSES = ["closed-state", "archive-dependent"] as const;
export const FIDELITY_CLASSES = ["local", "anchored-subset", "full-state"] as const;

/**
 * Design §4.2 E5, made a field rather than a footnote. `declared` means the proofs bind the
 * committed subset to the root the record states, and the correspondence between that root
 * and any public chain's history is a declaration this attestation does not close.
 */
export const ANCHOR_AUTHENTICITY = ["declared", "header-proven"] as const;

export const SourceAnchorObservationSchema = z.strictObject({
  caip2: z.string().regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/u, "must be a CAIP-2 chain id"),
  chainId: z.number().int().nonnegative(),
  blockNumber: QuantitySchema,
  blockHash: Word32Schema,
  stateRoot: Word32Schema,
  timestamp: QuantitySchema,
  finalityPolicy: z.string().min(1),
  authenticity: z.enum(ANCHOR_AUTHENTICITY),
});

export const RuntimeIdentityObservationSchema = z.strictObject({
  family: z.string().min(1),
  version: z.string().min(1),
  imageManifestDigest: PrefixedSha256Schema,
  platform: z.string().min(1),
  binaryDigest: PrefixedSha256Schema,
  reportedVersion: z.string().min(1),
  evmConfigurationDigest: PrefixedSha256Schema,
  chainId: z.number().int().nonnegative(),
});

export const CapabilityEnvelopeObservationSchema = z.strictObject({
  rpcAllowlist: z.strictObject({
    read: z.array(z.string().min(1)),
    stateChanging: z.array(z.string().min(1)),
  }),
  signerRoles: z.array(z.string().min(1)),
  permittedChainId: z.number().int().nonnegative(),
  maxima: z.record(z.string().min(1), z.string().min(1)),
  egressPolicyId: z.string().min(1),
});

/** E13's computation, reported as counts plus the visibility flag §4.2 requires. */
export const CoverageObservationSchema = z.strictObject({
  proofCovered: z.number().int().nonnegative(),
  fixtureDeclared: z.number().int().nonnegative(),
  uncovered: z.number().int().nonnegative(),
  mutatesSourceProtocolState: z.boolean(),
});

export const EnvironmentObservationSchema = z.strictObject({
  closureClass: z.enum(CLOSURE_CLASSES),
  fidelityClass: z.enum(FIDELITY_CLASSES),
  anchor: SourceAnchorObservationSchema.optional(),
  runtime: RuntimeIdentityObservationSchema,
  /** A state commitment (`0x` + 64 hex), explicitly distinct from `sourceAnchor.stateRoot`
   * and never a `sha256:` content digest -- CE1's record spells it the same way. */
  postFixtureCommitment: Word32Schema,
  /** The controls the instance applied, not the ones the record wished for. */
  controls: z.record(z.string().min(1), z.string()),
  envelope: CapabilityEnvelopeObservationSchema,
  coverage: CoverageObservationSchema.optional(),
});
export type EnvironmentObservation = z.infer<typeof EnvironmentObservationSchema>;

export const RunObservationSchema = z.strictObject({
  /** Design §5.1 step 8: each run is a newly launched process. Distinct ids are how a reader
   * checks that rule instead of trusting it. */
  instanceId: z.string().min(1),
  observationDigest: PrefixedSha256Schema,
  wallSeconds: z.number().nonnegative().finite(),
});
export type RunObservation = z.infer<typeof RunObservationSchema>;

export const RunsBlockSchema = z
  .strictObject({
    count: z.number().int().min(MINIMUM_RUN_COUNT),
    observationDigest: PrefixedSha256Schema,
    perRun: z.array(RunObservationSchema).min(MINIMUM_RUN_COUNT),
    allObservationsEqual: z.boolean(),
    freshInstances: z.boolean(),
  })
  .refine((runs) => runs.count === runs.perRun.length, {
    message: "runs.count must equal runs.perRun.length",
    path: ["count"],
  })
  .refine(
    (runs) => runs.allObservationsEqual
      === runs.perRun.every((run) => run.observationDigest === runs.observationDigest),
    {
      message: "runs.allObservationsEqual must equal the observed per-run equality",
      path: ["allObservationsEqual"],
    },
  )
  .refine(
    (runs) => !runs.freshInstances
      || new Set(runs.perRun.map((run) => run.instanceId)).size === runs.perRun.length,
    {
      message: "a fresh-instantiation claim requires distinct instance ids",
      path: ["freshInstances"],
    },
  );
export type RunsBlock = z.infer<typeof RunsBlockSchema>;

export const BaselineBlockSchema = z.strictObject({
  /** The post-fixture, pre-probe state commitment every run must reproduce (§5.1 step 9). */
  commitment: Word32Schema,
  observation: ResourceDescriptorSchema,
});
export type BaselineBlock = z.infer<typeof BaselineBlockSchema>;

export const NetworkPolicyObservationSchema = z.strictObject({
  egress: z.literal("denied"),
  dns: z.literal("absent"),
  archiveRpc: z.literal("unreachable"),
  forkBackend: z.enum(["absent", "present"]),
});

/** Design §5.1 step 2's two evidence modes. Neither one alone covers both instance shapes,
 * which is why the mode is a field and both are exercised by the kit. */
export const CLOSURE_EVIDENCE_MODES = ["fork-backend-refusal", "sealed-boundary"] as const;
export type ClosureEvidenceMode = (typeof CLOSURE_EVIDENCE_MODES)[number];

export const IsolationEvidenceSchema = z.strictObject({
  networkPolicy: NetworkPolicyObservationSchema,
  closureEvidenceMode: z.enum(CLOSURE_EVIDENCE_MODES),
  /** §4.2's boundary rule as evidence: outside the committed slice, reads are empty. Present
   * for sealed instances, where no fetch is possible and absence of errors is not closure evidence. */
  boundaryProbe: z.strictObject({
    probeId: z.string().min(1),
    readsEmptyOutsideSlice: z.boolean(),
  }).optional(),
  egressAttempts: z.array(z.strictObject({
    target: z.string().min(1),
    outcome: z.enum(["refused", "succeeded"]),
    detail: z.string().min(1).optional(),
  })),
  forbiddenProbes: z.array(z.strictObject({
    method: z.string().min(1),
    expectedClass: z.string().min(1),
    observedClass: z.string().min(1),
    passed: z.boolean(),
  })),
  signerScope: z.strictObject({
    declaredRoles: z.array(z.string().min(1)),
    exposedAccounts: z.array(AddressSchema),
    unexpectedAccounts: z.array(AddressSchema),
  }),
  /** Design §5.1 step 6's reset requirement, when the record declares one. The post-reset
   * STATE COMMITMENT `ChainMaterializer.reset` returned, compared against the baseline
   * commitment -- not an observation digest. */
  resetCommitment: Word32Schema.optional(),
  resolutionLog: ResourceDescriptorSchema,
});
export type IsolationEvidence = z.infer<typeof IsolationEvidenceSchema>;

/** Design §5.3's cost observations and §5.4's honest table, as recorded facts. Nothing here
 * gates an outcome; cost is what makes third-party re-verification budgetable. */
export const CostObservationsSchema = z.strictObject({
  artifactBytes: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  wallSeconds: z.number().nonnegative().finite(),
  cpuSeconds: z.number().nonnegative().finite().optional(),
  maxMemoryBytes: z.number().int().nonnegative().optional(),
  diskBytes: z.number().int().nonnegative().optional(),
  rpcCalls: z.number().int().nonnegative().optional(),
  rpcBytes: z.number().int().nonnegative().optional(),
});
export type CostObservations = z.infer<typeof CostObservationsSchema>;

export const ProviderObservationSchema = z.strictObject({
  id: z.string().min(1),
  observedAt: Rfc3339UtcSchema,
  rpcCalls: z.number().int().nonnegative(),
  rpcBytes: z.number().int().nonnegative(),
  observationDigest: PrefixedSha256Schema,
});
export type ProviderObservation = z.infer<typeof ProviderObservationSchema>;

export const COMPONENT_ROLES = ["chain-world", "information-world", "service-runtime"] as const;

/** Design §4.4 + §5.1 step 6: what exists only once worlds are combined. */
export const CompositionEvidenceSchema = z.strictObject({
  routing: z.array(z.strictObject({
    origin: z.string().min(1),
    world: PrefixedSha256Schema,
    precedence: z.number().int().nonnegative(),
  })),
  collisions: z.array(z.strictObject({
    origin: z.string().min(1),
    worlds: z.array(PrefixedSha256Schema).min(2),
  })),
  missPolicy: z.string().min(1),
  allowlistedOrigins: z.array(z.string().min(1)),
  requestBudget: z.strictObject({
    requests: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    enforced: z.boolean(),
  }),
  /**
   * Component records, and their own attestations where the verifier had them. A composite
   * attestation never substitutes for these; `requiresComponentAttestations` reads this list.
   */
  components: z.array(z.strictObject({
    role: z.enum(COMPONENT_ROLES),
    record: PrefixedSha256Schema,
    attestation: PrefixedSha256Schema.optional(),
  })).min(1),
  wholeWorldOfflineBoot: z.boolean(),
});
export type CompositionEvidence = z.infer<typeof CompositionEvidenceSchema>;

export const DivergenceSchema = z.strictObject({
  referenceRunIndex: z.number().int().nonnegative(),
  referenceObservationDigest: PrefixedSha256Schema,
  divergentRuns: z.array(z.strictObject({
    index: z.number().int().nonnegative(),
    instanceId: z.string().min(1),
    observationDigest: PrefixedSha256Schema,
    observation: ResourceDescriptorSchema,
  })).min(1),
});

export const CoverageFailureSchema = z.strictObject({
  uncoveredAccounts: z.array(AddressSchema),
  uncoveredCodeEntries: z.array(AddressSchema),
  uncoveredStorageSlots: z.array(z.strictObject({ address: AddressSchema, slot: Word32Schema })),
  undeclaredMutations: z.array(AddressSchema),
});

export const FailureBlockSchema = z.strictObject({
  stage: z.enum(CHAIN_VERIFICATION_STAGES),
  reason: z.enum(CHAIN_VERIFICATION_FAILURE_REASONS),
  detail: z.string().min(1).optional(),
  divergence: DivergenceSchema.optional(),
  coverage: CoverageFailureSchema.optional(),
});
export type FailureBlock = z.infer<typeof FailureBlockSchema>;

const PredicateShapeSchema = z.strictObject({
  protocol: z.literal(CHAIN_ENVIRONMENT_VERIFICATION_PROTOCOL_URI),
  /** Component and composite claims are different claims; the discriminator is what stops a
   * consumer reading one as the other (Finding F-CE3-4). */
  scope: z.enum(["component", "composite"]),
  outcome: z.enum(CHAIN_VERIFICATION_OUTCOMES),
  window: VerificationWindowSchema,
  verifier: VerifierIdentitySchema,
  /** Every resource step 1 resolved and digest-verified. */
  materials: z.array(ResourceDescriptorSchema).min(1),
  environment: EnvironmentObservationSchema,
  runs: RunsBlockSchema.optional(),
  baseline: BaselineBlockSchema.optional(),
  isolation: IsolationEvidenceSchema,
  cost: CostObservationsSchema,
  providers: z.array(ProviderObservationSchema).min(1).optional(),
  composition: CompositionEvidenceSchema.optional(),
  failure: FailureBlockSchema.optional(),
  evidence: z.array(ResourceDescriptorSchema).optional(),
});

export const ChainEnvironmentVerificationPredicateSchema = PredicateShapeSchema.superRefine(
  (predicate, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: "custom", message, path });
    };

    // --- Presence: repetition evidence exists iff a complete K-run observation exists.
    const runBearing = isRunBearingOutcome(predicate.outcome);
    if (runBearing) {
      if (predicate.runs === undefined) issue("a run-bearing outcome requires runs", ["runs"]);
      if (predicate.baseline === undefined) {
        issue("a run-bearing outcome requires a baseline", ["baseline"]);
      }
      if (
        predicate.runs !== undefined
        && predicate.baseline !== undefined
        && predicate.baseline.observation.digest.sha256
          !== predicate.runs.observationDigest.slice("sha256:".length)
      ) {
        issue(
          "baseline.observation must name the canonical observation in runs.observationDigest",
          ["baseline", "observation"],
        );
      }
    } else {
      if (predicate.runs !== undefined) {
        issue("this outcome carries no complete run sequence", ["runs"]);
      }
      if (predicate.baseline !== undefined) {
        issue("this outcome carries no baseline", ["baseline"]);
      }
    }

    // --- The two positive outcomes carry no failure; every other outcome carries one, and
    // the failure's reason is what fixes the outcome and the stage.
    const positive = predicate.outcome === "closed-reproducible"
      || predicate.outcome === "archive-observed";
    if (positive) {
      if (predicate.failure !== undefined) {
        issue("a positive outcome carries no failure block", ["failure"]);
      }
    } else if (predicate.failure === undefined) {
      issue("a negative outcome requires a failure block", ["failure"]);
    } else {
      if (outcomeForFailureReason(predicate.failure.reason) !== predicate.outcome) {
        issue(
          `reason ${predicate.failure.reason} is the outcome `
          + `${outcomeForFailureReason(predicate.failure.reason)}`,
          ["outcome"],
        );
      }
      if (stageForFailureReason(predicate.failure.reason) !== predicate.failure.stage) {
        issue(
          `reason ${predicate.failure.reason} belongs to stage `
          + `${stageForFailureReason(predicate.failure.reason)}`,
          ["failure", "stage"],
        );
      }
    }

    // --- Fidelity determines which source blocks exist (design §4.3).
    const local = predicate.environment.fidelityClass === "local";
    if (local && predicate.environment.anchor !== undefined) {
      issue("a local record claims no source anchor", ["environment", "anchor"]);
    }
    if (!local && predicate.environment.anchor === undefined) {
      issue("anchored-subset and full-state records carry a source anchor",
        ["environment", "anchor"]);
    }
    if (local && predicate.environment.coverage !== undefined) {
      issue("artifact coverage is computed against a source manifest, which local has none of",
        ["environment", "coverage"]);
    }
    if (!local && predicate.environment.coverage === undefined) {
      issue("E13 coverage is computed for anchored-subset and full-state",
        ["environment", "coverage"]);
    }

    // --- Closure evidence mode follows the instance shape, never the verifier's preference.
    const forkBacked = predicate.isolation.networkPolicy.forkBackend === "present";
    const expectedMode = forkBacked ? "fork-backend-refusal" : "sealed-boundary";
    if (predicate.isolation.closureEvidenceMode !== expectedMode) {
      issue(
        `a ${predicate.isolation.networkPolicy.forkBackend} fork backend is the ${expectedMode} mode`,
        ["isolation", "closureEvidenceMode"],
      );
    }
    if (forkBacked) {
      if (predicate.isolation.boundaryProbe !== undefined) {
        issue("the boundary probe is the sealed mode's evidence", ["isolation", "boundaryProbe"]);
      }
      if (
        predicate.isolation.egressAttempts.length === 0
        && predicate.failure?.reason !== "fork-backend-fetch-unrefused"
      ) {
        issue(
          "fork-backend closure is evidenced by a refused fetch, so an attempt must be recorded",
          ["isolation", "egressAttempts"],
        );
      }
    } else if (predicate.isolation.boundaryProbe === undefined) {
      issue(
        "a sealed instance evidences closure through the boundary rule, not absence of errors",
        ["isolation", "boundaryProbe"],
      );
    }

    // --- Cost: a closed run that spent archive RPC is a contradiction.
    if (predicate.environment.closureClass === "closed-state") {
      if (predicate.cost.rpcCalls !== undefined || predicate.cost.rpcBytes !== undefined) {
        issue("a closed-state run makes no archive RPC calls", ["cost", "rpcCalls"]);
      }
      if (predicate.providers !== undefined) {
        issue("a closed-state run names no providers", ["providers"]);
      }
    } else if (predicate.providers === undefined) {
      issue("an archive-dependent observation records the providers it consulted",
        ["providers"]);
    }

    // --- The two positive outcomes, in detail.
    if (predicate.outcome === "closed-reproducible") {
      if (predicate.environment.closureClass !== "closed-state") {
        issue("closed-reproducible is a closed-state claim", ["environment", "closureClass"]);
      }
      predicate.runs?.perRun.forEach((run, index) => {
        if (run.observationDigest !== predicate.runs?.observationDigest) {
          issue(
            "closed-reproducible requires every per-run observation digest to equal the canonical one",
            ["runs", "perRun", index, "observationDigest"],
          );
        }
      });
      if (predicate.runs?.freshInstances !== true) {
        issue("closed-reproducible requires K fresh materializations", ["runs", "freshInstances"]);
      }
      predicate.isolation.egressAttempts.forEach((attempt, index) => {
        if (attempt.outcome !== "refused") {
          issue("a successful egress is offline-dependency-detected",
            ["isolation", "egressAttempts", index, "outcome"]);
        }
      });
      if (!forkBacked && predicate.isolation.boundaryProbe?.readsEmptyOutsideSlice !== true) {
        issue("the boundary rule requires out-of-slice reads to be empty",
          ["isolation", "boundaryProbe", "readsEmptyOutsideSlice"]);
      }
      predicate.isolation.forbiddenProbes.forEach((probe, index) => {
        if (!probe.passed) {
          issue("a failed forbidden-method probe is capability-mismatch",
            ["isolation", "forbiddenProbes", index, "passed"]);
        }
      });
      if (predicate.isolation.signerScope.unexpectedAccounts.length > 0) {
        issue("an unexpected signer account is capability-mismatch",
          ["isolation", "signerScope", "unexpectedAccounts"]);
      }
    }

    if (predicate.outcome === "archive-observed"
      && predicate.environment.closureClass !== "archive-dependent") {
      issue("archive-observed is the archive-dependent class's outcome",
        ["environment", "closureClass"]);
    }

    // --- The three divergence outcomes must carry the evidence they are named for.
    if (predicate.outcome === "probe-divergence") {
      if (predicate.failure?.divergence === undefined) {
        issue("probe-divergence requires divergence evidence", ["failure", "divergence"]);
      }
      if (predicate.runs?.allObservationsEqual !== false) {
        issue("probe-divergence is observed inequality", ["runs", "allObservationsEqual"]);
      }
    }
    if (predicate.outcome === "reset-divergence") {
      if (predicate.isolation.resetCommitment === undefined) {
        issue("reset-divergence requires the post-reset commitment",
          ["isolation", "resetCommitment"]);
      } else if (predicate.isolation.resetCommitment === predicate.baseline?.commitment) {
        issue("a post-reset commitment equal to the baseline is not a divergence",
          ["isolation", "resetCommitment"]);
      }
    }
    if (predicate.outcome === "provider-disagreement") {
      const digests = new Set((predicate.providers ?? []).map((one) => one.observationDigest));
      if (digests.size < 2) {
        issue("provider-disagreement requires two providers that disagreed", ["providers"]);
      }
    }

    // --- E13.
    if (predicate.outcome === "source-coverage-incomplete") {
      const coverage = predicate.failure?.coverage;
      if (coverage === undefined) {
        issue("source-coverage-incomplete requires the uncovered set", ["failure", "coverage"]);
      } else if (
        coverage.uncoveredAccounts.length === 0
        && coverage.uncoveredCodeEntries.length === 0
        && coverage.uncoveredStorageSlots.length === 0
        && coverage.undeclaredMutations.length === 0
      ) {
        issue("an empty uncovered set is not incomplete coverage", ["failure", "coverage"]);
      }
    }
    if (predicate.environment.coverage !== undefined
      && predicate.environment.coverage.uncovered > 0
      && predicate.outcome !== "source-coverage-incomplete") {
      issue("uncovered artifact entries are source-coverage-incomplete",
        ["environment", "coverage", "uncovered"]);
    }

    // --- Composite scope.
    if (predicate.scope === "composite") {
      if (predicate.composition === undefined) {
        issue("a composite attestation carries the composition block", ["composition"]);
      } else {
        const byOrigin = new Map<string, Set<string>>();
        for (const route of predicate.composition.routing) {
          const worlds = byOrigin.get(route.origin) ?? new Set<string>();
          worlds.add(route.world);
          byOrigin.set(route.origin, worlds);
        }
        for (const [origin, worlds] of byOrigin) {
          const declared = predicate.composition.collisions
            .some((collision) => collision.origin === origin);
          if (worlds.size > 1 && !declared) {
            issue(`origin ${origin} is claimed by two worlds without a recorded collision`,
              ["composition", "collisions"]);
          }
        }
        const chainWorlds = predicate.composition.components
          .filter((component) => component.role === "chain-world");
        if (chainWorlds.length !== 1) {
          issue("a composite has exactly one chain world", ["composition", "components"]);
        }
        if (predicate.outcome === "closed-reproducible") {
          if (predicate.composition.collisions.length > 0) {
            issue("routing collisions are capability-mismatch", ["composition", "collisions"]);
          }
          if (!predicate.composition.wholeWorldOfflineBoot) {
            issue("a composite closure claim requires the whole world to boot offline",
              ["composition", "wholeWorldOfflineBoot"]);
          }
          if (!predicate.composition.requestBudget.enforced) {
            issue("an unenforced request budget is capability-mismatch",
              ["composition", "requestBudget", "enforced"]);
          }
        }
      }
    } else if (predicate.composition !== undefined) {
      issue("the composition block belongs to a composite attestation", ["composition"]);
    }
  },
);

export type ChainEnvironmentVerificationPredicate = z.infer<typeof PredicateShapeSchema>;

export function parseChainEnvironmentVerificationPredicate(
  value: unknown,
): ChainEnvironmentVerificationPredicate {
  const result = ChainEnvironmentVerificationPredicateSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    invalidInput(
      first
        ? `Invalid chain verification predicate at /${first.path.join("/")}: ${first.message}`
        : "Invalid chain verification predicate.",
    );
  }
  return result.data;
}
