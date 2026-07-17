/**
 * EpisodeV1 — the complete-trajectory evidence record (architecture spec §5).
 * Superset of `client/packages/harness-layer/src/capture.ts`'s CapturedTask:
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

export const EPISODE_SCHEMA_VERSION = 'jinn.episode.v1' as const;

const UnixNanoSchema = z.string().regex(/^\d+$/, 'unix-nanosecond digit string');

/**
 * `kind` tracks the DR-2026-07-14 §6 working names: `jinn.agent_turn` carries a
 * `role: user|assistant` in `attributes`; `jinn.tool_call` is a tool invocation.
 * Re-declared inline (rather than imported) because #1473 is still open and arch
 * §6 forbids the plugin package importing from `client/src/**`.
 */
const StepSchema = z.strictObject({
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).nullable(),
  kind: z.enum(['jinn.agent_turn', 'jinn.tool_call']),
  name: z.string().min(1),
  startTimeUnixNano: UnixNanoSchema,
  endTimeUnixNano: UnixNanoSchema,
  attributes: z.record(z.string(), z.unknown()),
  redactedKeys: z.array(z.string().min(1)).default([]),
});

export const SessionActivityFactsSchema = z.strictObject({
  surfacedRefs: z.array(z.string().min(1)),
  fetchedRefs: z.array(z.string().min(1)),
  installedSkillRefs: z.array(z.string().min(1)),
});

export const EpisodeV1Schema = z.strictObject({
  schemaVersion: z.literal(EPISODE_SCHEMA_VERSION),
  episodeId: z.string().min(1),
  session: z.strictObject({
    sessionId: z.string().min(1).max(128),
    capturedAt: z.iso.datetime(),
  }),
  task: z.strictObject({
    summary: z.string().min(1),
    distributionTags: z.array(z.string().min(1)).default([]),
  }),
  trajectory: z.array(StepSchema).min(1),
  environment: z.strictObject({
    harness: z.strictObject({ name: z.string().min(1), version: z.string().min(1) }),
    model: z.string().min(1),
    tools: z.array(z.string().min(1)),
    skillsLoadout: z.array(z.string().min(1)),
  }),
  outcome: z.strictObject({
    status: z.enum(['completed', 'failed', 'abandoned']),
    verifiabilityTier: z.enum(['user-accepted', 'tests-passed', 'evaluator-verified']),
    summary: z.string().min(1).optional(),
  }),
  cost: z.strictObject({
    durationMs: z.number().int().nonnegative(),
    tokens: z.strictObject({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    }).optional(),
    usdEstimate: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  }),
  retention: z.strictObject({
    policy: z.enum(['local-private', 'contribution-eligible']),
  }),
  provenance: z.enum(['contributed', 'imported']).default('contributed'),
  lineage: z.strictObject({
    episodeId: z.string().min(1),
    mintRef: z.string().min(1).optional(),
  }).optional(),
  activity: SessionActivityFactsSchema.optional(),
  eligibility: EligibilityVerdictSchema.optional(),
});

export type EpisodeV1 = z.infer<typeof EpisodeV1Schema>;
export type SessionActivityFacts = z.infer<typeof SessionActivityFactsSchema>;

/** Shallow-copy `value` without the listed keys when they are literal `null`. */
function stripNullKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out = { ...value };
  for (const key of keys) {
    if (out[key] === null) delete out[key];
  }
  return out;
}

/**
 * READ-side tolerant EpisodeV1 parse (#1811). An older jinn-agent wheel
 * serialized explicit `None`s into the optional slots, so real on-disk
 * episodes carry literal JSON `null` in `outcome.summary`, `cost.tokens`,
 * `cost.usdEstimate`, `lineage`, `lineage.mintRef`, `activity`, and
 * `eligibility`. `.optional()` on a strictObject is absent-OK but null-fatal,
 * so every such file failed strict parse and was silently dropped.
 *
 * This helper strips literal `null` from exactly those known optional slots,
 * then delegates to the unchanged strict `EpisodeV1Schema.parse` — it throws
 * on genuinely invalid input just like `.parse`. Writes stay strict: `put`
 * and `SessionEndRequestV1Schema` must keep using `EpisodeV1Schema` directly.
 */
export function parseEpisodeV1Read(json: unknown): EpisodeV1 {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return EpisodeV1Schema.parse(json);
  }
  let candidate = stripNullKeys(json as Record<string, unknown>, [
    'lineage',
    'activity',
    'eligibility',
  ]);
  const outcome = candidate.outcome;
  if (outcome && typeof outcome === 'object' && !Array.isArray(outcome)) {
    candidate = { ...candidate, outcome: stripNullKeys(outcome as Record<string, unknown>, ['summary']) };
  }
  const cost = candidate.cost;
  if (cost && typeof cost === 'object' && !Array.isArray(cost)) {
    candidate = { ...candidate, cost: stripNullKeys(cost as Record<string, unknown>, ['tokens', 'usdEstimate']) };
  }
  const lineage = candidate.lineage;
  if (lineage && typeof lineage === 'object' && !Array.isArray(lineage)) {
    candidate = { ...candidate, lineage: stripNullKeys(lineage as Record<string, unknown>, ['mintRef']) };
  }
  return EpisodeV1Schema.parse(candidate);
}
