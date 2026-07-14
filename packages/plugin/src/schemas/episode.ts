/**
 * EpisodeV1 — the complete-trajectory evidence record (architecture spec §5).
 * Superset of `client/packages/harness-layer/src/capture.ts`'s CapturedTask:
 * all turns (not just the first), a skills loadout, a per-record retention
 * field, and optional lineage hooks. Strict at every level (unknown fields
 * rejected), following the capture.ts / envelope.ts convention.
 *
 * Deviation from CapturedTask, noted per plan (#1658): `task.distributionTags`
 * defaults to `[]` rather than requiring `.min(1)` — Stage 1 has no tagging
 * policy yet (S1-F2). `toolCalls` is not `.min(1)` — a session can have zero
 * tool calls.
 */
import { z } from 'zod';

export const EPISODE_SCHEMA_VERSION = 'jinn.episode.v1' as const;

const UnixNanoSchema = z.string().regex(/^\d+$/, 'unix-nanosecond digit string');

const TurnSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
  timestamp: z.iso.datetime(),
});

const ToolCallSchema = z.strictObject({
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).nullable(),
  name: z.string().min(1),
  startTimeUnixNano: UnixNanoSchema,
  endTimeUnixNano: UnixNanoSchema,
  attributes: z.record(z.string(), z.unknown()),
  redactedKeys: z.array(z.string().min(1)).default([]),
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
  turns: z.array(TurnSchema).min(1),
  toolCalls: z.array(ToolCallSchema),
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
  }),
  retention: z.strictObject({
    policy: z.enum(['local-private', 'contribution-eligible']),
  }),
  provenance: z.enum(['contributed', 'imported']).default('contributed'),
  lineage: z.strictObject({
    episodeId: z.string().min(1),
    mintRef: z.string().min(1).optional(),
  }).optional(),
});

export type EpisodeV1 = z.infer<typeof EpisodeV1Schema>;
