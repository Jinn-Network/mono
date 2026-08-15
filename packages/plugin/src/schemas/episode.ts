/**
 * EpisodeV1 — the complete-trajectory evidence record (architecture spec §5).
 * Superset of `packages/core/src/captured-task.ts`'s CapturedTask:
 * the full trajectory as one ordered `kind`-discriminated span sequence, a
 * skills loadout, token + USD cost, a per-record retention field, and optional
 * lineage hooks. Strict at every level (unknown fields rejected), following the
 * capture.ts / envelope.ts convention.
 *
 * Deviation from CapturedTask, noted per plan (#1658): `task.distributionTags`
 * defaults to `[]` rather than requiring `.min(1)` — Stage 1 has no tagging
 * policy yet (S1-F2). `trajectory` is one ordered span sequence (`.min(1)`; a
 * zero-tool-call session still has ≥1 `jinn.agent_turn` step). `cost.usdEstimate`
 * is restored (optional) so EpisodeV1 stays a true CapturedTask superset.
 */
import { z } from 'zod';
import { EligibilityVerdictSchema } from './eligibility-verdict.js';
import {
  ContributionCandidateV1ReadSchema,
  ContributionCandidateV1Schema,
} from './contribution-candidate.js';

export const EPISODE_SCHEMA_VERSION = 'jinn.episode.v1' as const;
export const EPISODE_PROVENANCES = [
  'contributed',
  'imported',
  'derived-from-history',
] as const;
export const EpisodeProvenanceSchema = z.enum(EPISODE_PROVENANCES);

const UnixNanoSchema = z.string().regex(/^\d+$/, 'unix-nanosecond digit string');

/**
 * `kind` tracks the DR-2026-07-14 §6 working names: `jinn.agent_turn` carries a
 * `role: user|assistant` in `attributes`; `jinn.tool_call` is a tool invocation.
 * Re-declared inline (rather than imported) because #1473 is still open and arch
 * §6 forbids the plugin package importing from `operator/src/**`.
 */
const StepShape = {
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).nullable(),
  kind: z.enum(['jinn.agent_turn', 'jinn.tool_call']),
  name: z.string().min(1),
  startTimeUnixNano: UnixNanoSchema,
  endTimeUnixNano: UnixNanoSchema,
  attributes: z.record(z.string(), z.unknown()),
  redactedKeys: z.array(z.string().min(1)).default([]),
  /** Public scrub projection receipt; absent on ordinary local episodes. */
  truncatedKeys: z.array(z.string().min(1)).optional(),
  /** Canonical OTLP observations are additive for read compatibility. */
  events: z.array(z.strictObject({
    timeUnixNano: UnixNanoSchema,
    name: z.string().min(1),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
  status: z.strictObject({
    code: z.enum(['UNSET', 'OK', 'ERROR']),
    message: z.string().min(1).optional(),
  }).optional(),
};

const StepWriteSchema = z.strictObject(StepShape);
const StepReadSchema = z.looseObject(StepShape);

/**
 * Rescope (2026-07-16): `searchedTerms`/`providedRefs` are the current
 * evidence-first pickup facts. The pre-rescope `surfacedRefs`/`fetchedRefs`/
 * `installedSkillRefs` trio remains in the schema — defaulted, so existing
 * local episode files (and hosts that have not yet migrated) still parse —
 * but is no longer the primary signal a new pickup writes.
 */
const LegacyActivityShape = {
  searchedTerms: z.array(z.string().min(1)).default([]),
  providedRefs: z.array(z.string().min(1)).default([]),
  /** @deprecated rescope — retained for read-compat with pre-rescope episode files. */
  surfacedRefs: z.array(z.string().min(1)).default([]),
  /** @deprecated rescope — retained for read-compat; still recorded as an
   *  internal fetch-attempt detail by the current pickup (rescope §3.6). */
  fetchedRefs: z.array(z.string().min(1)).default([]),
  /** @deprecated rescope — the skill adopt/install path no longer exists in pickup. */
  installedSkillRefs: z.array(z.string().min(1)).default([]),
};

const DeliveryActivityShape = {
  retrievalFired: z.boolean(),
  eligibleRefs: z.array(z.string().min(1)),
  deliveredRefs: z.array(z.string().min(1)),
  deliveryMode: z.enum(['delivered', 'disabled', 'degraded', 'withheld']),
  deliveredContentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
};

export const SessionActivityFactsWriteSchema = z.strictObject({
  ...LegacyActivityShape,
  ...DeliveryActivityShape,
}).superRefine((activity, context) => {
  if (
    (activity.deliveryMode === 'delivered' || activity.deliveredRefs.length > 0)
    && activity.deliveredContentHash === undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['deliveredContentHash'],
      message: 'delivered evidence requires the exact sha256 content hash',
    });
  }
});

const SessionShape = {
  sessionId: z.string().min(1).max(128),
  capturedAt: z.iso.datetime(),
  kind: z.enum(['user', 'host-internal']),
  parentSessionId: z.string().min(1).max(128).optional(),
};

const TaskShape = {
  summary: z.string().min(1),
  distributionTags: z.array(z.string().min(1)).default([]),
  repositorySlug: z.string().min(1).optional(),
  /** Post-training tuple join/freshness fields (#1827/#1842). */
  baseCommit: z.string().min(1).optional(),
  createdAt: z.number().int().nonnegative().optional(),
  instanceId: z.string().min(1).optional(),
};

export const VERIFICATION_STRENGTHS = [
  'user-accepted',
  'tests-passed',
  'evaluator-verified',
] as const;
export const VerificationStrengthSchema = z.enum(VERIFICATION_STRENGTHS);

const OutcomeShape = {
  status: z.enum(['completed', 'failed', 'abandoned']),
  /** The one outcome-verification axis used by new local and public records.
   * `verifiabilityTier` is normalized into this field on compatible reads and
   * writes; the outer execution envelope's evidenceTier remains transport /
   * attestation assurance and is not misrepresented as outcome correctness. */
  verificationStrength: VerificationStrengthSchema,
  summary: z.string().min(1).optional(),
  acceptedDiff: z.boolean().optional(),
  testRuns: z.strictObject({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }).optional(),
};

function normalizeOutcomeCompatibility(value: unknown): unknown {
  const raw = asRecord(value);
  if (!raw) return value;
  const normalized: UnknownRecord = { ...raw };
  const legacy = normalized['verifiabilityTier'];
  const canonical = normalized['verificationStrength'];
  if (legacy !== undefined) {
    // A disagreement is made deliberately unparseable instead of silently
    // choosing one axis.
    normalized['verificationStrength'] =
      canonical !== undefined && canonical !== legacy
        ? [canonical, legacy]
        : legacy;
    delete normalized['verifiabilityTier'];
  }
  return normalized;
}

const OutcomeWriteSchema = z.preprocess(
  normalizeOutcomeCompatibility,
  z.strictObject(OutcomeShape),
);

const GeneratorModelShape = {
  id: z.string().min(1),
  provider: z.string().min(1).optional(),
  openWeights: z.boolean().optional(),
  source: z.enum(['stream', 'config']),
};

const GeneratorModelWriteSchema = z.strictObject(GeneratorModelShape);
const GeneratorModelReadSchema = z.looseObject(GeneratorModelShape);

const F2pP2pVerifierShape = {
  type: z.literal('f2p-p2p'),
  failToPass: z.array(z.string().min(1)),
  passToPass: z.array(z.string().min(1)),
  evalSemanticsVersion: z.string().min(1),
};

const OtherVerifierShape = {
  type: z.enum(['command', 'none']),
  failToPass: z.array(z.string().min(1)).default([]),
  passToPass: z.array(z.string().min(1)).default([]),
  evalSemanticsVersion: z.string().min(1).optional(),
};

const VerifierWriteSchema = z.discriminatedUnion('type', [
  z.strictObject(F2pP2pVerifierShape),
  z.strictObject(OtherVerifierShape),
]);
const VerifierReadSchema = z.discriminatedUnion('type', [
  z.looseObject(F2pP2pVerifierShape),
  z.looseObject(OtherVerifierShape),
]);

const AttemptGroupShape = {
  groupId: z.string().min(1),
  attemptId: z.string().min(1),
  relatedAttemptRefs: z.array(z.string().min(1)).default([]),
  groupSize: z.number().int().positive().optional(),
  nPass: z.number().int().nonnegative().optional(),
  nFail: z.number().int().nonnegative().optional(),
};

function attemptGroupCountsMatch(group: {
  groupSize?: number;
  nPass?: number;
  nFail?: number;
}): boolean {
  return !(
    group.groupSize !== undefined
    && group.nPass !== undefined
    && group.nFail !== undefined
    && group.groupSize !== group.nPass + group.nFail
  );
}

const AttemptGroupWriteSchema = z.strictObject(AttemptGroupShape).superRefine((group, context) => {
  if (!attemptGroupCountsMatch(group)) {
    context.addIssue({
      code: 'custom',
      path: ['groupSize'],
      message: 'groupSize must equal nPass + nFail when all counts are materialized',
    });
  }
});

const AttemptGroupReadSchema = z.looseObject(AttemptGroupShape).superRefine((group, context) => {
  if (!attemptGroupCountsMatch(group)) {
    context.addIssue({
      code: 'custom',
      path: ['groupSize'],
      message: 'groupSize must equal nPass + nFail when all counts are materialized',
    });
  }
});

const CostShape = {
  durationMs: z.number().int().nonnegative(),
  tokens: z.strictObject({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }).optional(),
  usdEstimate: z.string().regex(/^\d+(\.\d+)?$/).optional(),
};

const OriginStampSchema = z.strictObject({
  writer: z.string().min(1),
  build: z.string().min(1),
});
const OriginStampReadSchema = z.looseObject({
  writer: z.string().min(1),
  build: z.string().min(1),
});

const RetentionShape = {
  policy: z.enum(['local-private', 'contribution-eligible']),
};

const LineageShape = {
  episodeId: z.string().min(1),
  mintRef: z.string().min(1).optional(),
};

function validateContributionAttachment(
  episode: {
    episodeId: string;
    session: { kind: 'user' | 'host-internal' };
    contributionCandidate?: { sourceId: string };
  },
  context: z.RefinementCtx,
): void {
  const candidate = episode.contributionCandidate;
  if (!candidate) return;
  if (episode.session.kind === 'host-internal') {
    context.addIssue({
      code: 'custom',
      path: ['contributionCandidate'],
      message: 'host-internal episodes cannot carry a contribution candidate',
    });
  }
  if (candidate.sourceId !== episode.episodeId) {
    context.addIssue({
      code: 'custom',
      path: ['contributionCandidate', 'sourceId'],
      message: 'contribution candidate sourceId must match episodeId',
    });
  }
}

export const EpisodeV1WriteSchema = z.strictObject({
  schemaVersion: z.literal(EPISODE_SCHEMA_VERSION),
  episodeId: z.string().min(1),
  /** W2 allowlist decision recorded in canonical content. The legacy
   * `retrieval:visible.v1` distribution tag remains read-compatible. */
  retrievalVisible: z.boolean().default(false),
  session: z.strictObject(SessionShape),
  origin: OriginStampSchema,
  task: z.strictObject(TaskShape),
  trajectory: z.array(StepWriteSchema).min(1),
  environment: z.strictObject({
    harness: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
    model: z.string().min(1),
    tools: z.array(z.string().min(1)),
    skillsLoadout: z.array(z.string().min(1)),
    generatorModel: GeneratorModelWriteSchema.optional(),
    distributionClass: z.enum(['open', 'restricted-tos', 'unknown']).optional(),
    verifier: VerifierWriteSchema.optional(),
  }),
  outcome: OutcomeWriteSchema,
  cost: z.strictObject(CostShape),
  retention: z.strictObject(RetentionShape),
  provenance: EpisodeProvenanceSchema.default('contributed'),
  lineage: z.strictObject(LineageShape).optional(),
  attemptGroup: AttemptGroupWriteSchema.optional(),
  activity: SessionActivityFactsWriteSchema.optional(),
  eligibility: EligibilityVerdictSchema.optional(),
  /** Private local mining facts. Publication projections must omit this field. */
  contributionCandidate: ContributionCandidateV1Schema.optional(),
}).superRefine(validateContributionAttachment);

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function withoutNulls(value: unknown, optionalKeys: readonly string[]): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const normalized = { ...record };
  for (const key of optionalKeys) {
    if (normalized[key] === null) delete normalized[key];
  }
  return normalized;
}

/** Additive v1 reader normalization. Writers never use this path. */
function normalizeEpisodeRead(value: unknown): unknown {
  const raw = asRecord(value);
  if (!raw) return value;
  const normalized: UnknownRecord = { ...raw };

  const session = asRecord(withoutNulls(raw['session'], ['parentSessionId']));
  if (session) normalized['session'] = { kind: 'user', ...session };

  if (raw['origin'] === undefined) {
    normalized['origin'] = 'legacy-unstamped';
  }

  normalized['task'] = withoutNulls(
    raw['task'],
    ['repositorySlug', 'baseCommit', 'createdAt', 'instanceId'],
  );
  if (Array.isArray(raw['trajectory'])) {
    normalized['trajectory'] = raw['trajectory'].map(
      (step) => withoutNulls(step, ['truncatedKeys']),
    );
  }
  const environment = asRecord(withoutNulls(
    raw['environment'],
    ['generatorModel', 'distributionClass', 'verifier'],
  ));
  if (environment) {
    const cleanEnvironment: UnknownRecord = { ...environment };
    const generatorModel = asRecord(withoutNulls(
      environment['generatorModel'],
      ['provider', 'openWeights'],
    ));
    if (generatorModel) cleanEnvironment['generatorModel'] = generatorModel;
    const verifier = asRecord(withoutNulls(
      environment['verifier'],
      ['evalSemanticsVersion'],
    ));
    if (verifier) cleanEnvironment['verifier'] = verifier;
    normalized['environment'] = cleanEnvironment;
  }
  normalized['outcome'] = normalizeOutcomeCompatibility(
    withoutNulls(raw['outcome'], ['summary', 'acceptedDiff', 'testRuns']),
  );
  normalized['cost'] = withoutNulls(raw['cost'], ['tokens', 'usdEstimate']);
  for (const key of [
    'lineage',
    'attemptGroup',
    'activity',
    'eligibility',
    'contributionCandidate',
  ] as const) {
    if (normalized[key] === null) delete normalized[key];
  }

  const lineage = asRecord(normalized['lineage']);
  if (lineage) normalized['lineage'] = withoutNulls(lineage, ['mintRef']);

  const attemptGroup = asRecord(normalized['attemptGroup']);
  if (attemptGroup) {
    normalized['attemptGroup'] = withoutNulls(
      attemptGroup,
      ['groupSize', 'nPass', 'nFail'],
    );
  }

  const activity = asRecord(normalized['activity']);
  if (activity) {
    const clean = asRecord(withoutNulls(activity, ['deliveredContentHash'])) ?? {};
    const searchedTerms = clean['searchedTerms'] === undefined ? [] : clean['searchedTerms'];
    const legacyProvided = clean['providedRefs'];
    const deliveredRefs = clean['deliveredRefs'] === undefined
      ? legacyProvided === undefined ? [] : legacyProvided
      : clean['deliveredRefs'];
    const eligibleRefs = clean['eligibleRefs'] === undefined
      ? deliveredRefs
      : clean['eligibleRefs'];
    const retrievalFired = clean['retrievalFired'] !== undefined
      ? clean['retrievalFired']
      : (Array.isArray(searchedTerms) && searchedTerms.length > 0)
        || (Array.isArray(deliveredRefs) && deliveredRefs.length > 0);
    normalized['activity'] = {
      ...clean,
      searchedTerms,
      providedRefs: legacyProvided === undefined ? deliveredRefs : legacyProvided,
      surfacedRefs: clean['surfacedRefs'] === undefined ? [] : clean['surfacedRefs'],
      fetchedRefs: clean['fetchedRefs'] === undefined ? [] : clean['fetchedRefs'],
      installedSkillRefs: clean['installedSkillRefs'] === undefined
        ? []
        : clean['installedSkillRefs'],
      retrievalFired,
      eligibleRefs,
      deliveredRefs,
      deliveryMode: clean['deliveryMode'] === undefined
        ? (retrievalFired === true ? 'delivered' : 'disabled')
        : clean['deliveryMode'],
    };
  }

  return normalized;
}

const SessionActivityFactsReadSchema = z.looseObject({
  ...LegacyActivityShape,
  ...DeliveryActivityShape,
});

export const SessionActivityFactsSchema = z.preprocess(
  (value) => {
    const wrapper = normalizeEpisodeRead({
      schemaVersion: EPISODE_SCHEMA_VERSION,
      episodeId: 'activity-reader',
      session: { sessionId: 'activity-reader', capturedAt: '1970-01-01T00:00:00.000Z' },
      task: { summary: 'activity reader', distributionTags: [] },
      trajectory: [{
        spanId: 'activity-reader',
        parentSpanId: null,
        kind: 'jinn.agent_turn',
        name: 'activity-reader',
        startTimeUnixNano: '0',
        endTimeUnixNano: '0',
        attributes: {},
        redactedKeys: [],
      }],
      environment: {
        harness: { name: 'activity-reader', version: '1' },
        model: 'activity-reader',
        tools: [],
        skillsLoadout: [],
      },
      outcome: { status: 'completed', verificationStrength: 'user-accepted' },
      cost: { durationMs: 0 },
      retention: { policy: 'local-private' },
      activity: value,
    }) as UnknownRecord;
    return wrapper['activity'];
  },
  SessionActivityFactsReadSchema,
);

const EpisodeV1ReadObjectSchema = z.looseObject({
  schemaVersion: z.literal(EPISODE_SCHEMA_VERSION),
  episodeId: z.string().min(1),
  retrievalVisible: z.boolean().default(false),
  session: z.looseObject(SessionShape),
  origin: z.union([OriginStampReadSchema, z.literal('legacy-unstamped')]),
  task: z.looseObject(TaskShape),
  trajectory: z.array(StepReadSchema).min(1),
  environment: z.looseObject({
    harness: z.looseObject({ name: z.string().min(1), version: z.string().min(1) }),
    model: z.string().min(1),
    tools: z.array(z.string().min(1)),
    skillsLoadout: z.array(z.string().min(1)),
    generatorModel: GeneratorModelReadSchema.optional(),
    distributionClass: z.enum(['open', 'restricted-tos', 'unknown']).optional(),
    verifier: VerifierReadSchema.optional(),
  }),
  outcome: z.looseObject({
    ...OutcomeShape,
    testRuns: z.looseObject({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }).optional(),
  }),
  cost: z.looseObject({
    ...CostShape,
    tokens: z.looseObject({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    }).optional(),
  }),
  retention: z.looseObject(RetentionShape),
  provenance: EpisodeProvenanceSchema.default('contributed'),
  lineage: z.looseObject(LineageShape).optional(),
  attemptGroup: AttemptGroupReadSchema.optional(),
  activity: SessionActivityFactsReadSchema.optional(),
  eligibility: z.looseObject({
    eligible: z.boolean(),
    reason: z.string().min(1),
    checkedAt: z.iso.datetime(),
  }).optional(),
  contributionCandidate: ContributionCandidateV1ReadSchema.optional(),
}).superRefine(validateContributionAttachment);

export const EpisodeV1Schema = z.preprocess(normalizeEpisodeRead, EpisodeV1ReadObjectSchema);

export type EpisodeV1 = z.infer<typeof EpisodeV1Schema>;
export type SessionActivityFacts = z.infer<typeof SessionActivityFactsSchema>;
export type EpisodeV1Write = z.infer<typeof EpisodeV1WriteSchema>;
export type VerificationStrength = z.infer<typeof VerificationStrengthSchema>;
