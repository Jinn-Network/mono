/**
 * `GET /v1/status` response schema (spec/2026-08-04-headless-operator-rederivation-design.md
 * §8 artifacts 1–2).
 *
 * This is the source of truth for `StatusV1Response` — `client/src/api/status-build.ts`
 * imports the type from here (it used to declare it locally as a hand-maintained ~30-member
 * interface with no runtime schema and no contract test). The SPA imports the same type
 * instead of maintaining its own copy.
 *
 * One field, `operator` on `predictionV1Status`, stays deliberately untyped
 * (`Record<string, unknown>`) rather than importing its real type
 * (`PredictionOperatorStatusForApi`, derived from `PredictionOperatorStatus` in
 * `src/solver-nets/prediction-operator-ux.ts`, ~670 lines). Even a type-only import of
 * that module still makes `tsc` parse and check its whole transitive graph (type erasure
 * only skips *emission*, not *checking*) — under the SPA's stricter `noUnusedLocals`
 * tsconfig that graph surfaced dozens of pre-existing, unrelated "unused symbol" errors
 * in daemon-only modules several hops away, which is not a risk worth taking for one
 * field this module already treats as opaque at runtime (`z.custom`, object-shape check
 * only). Every other member of `StatusV1Response` has a real Zod schema and, where a
 * nested shape's type is reused rather than restated, only leaf types with a narrow
 * import graph are pulled in via `import type` — see
 * `test/architecture/contract-browser-safety.test.ts`.
 */
import { z } from 'zod/v4';
import { contractVersionSchema } from './version.js';

// ── fleet ──────────────────────────────────────────────────────────────────

const fleetServiceSchema = z.object({
  index: z.number(),
  step: z.string(),
  serviceId: z.number().nullable(),
  safeAddress: z.string().nullable(),
  mechAddress: z.string().nullable(),
  stakingAddress: z.string().nullable(),
  agentId: z.string().nullable(),
  identityRegistryAddress: z.string().nullable(),
  safeBoundToAgent: z.boolean(),
  identityBindingStatus: z.enum(['bound', 'pending', 'not_applicable']),
});

const fleetSchema = z.object({
  loaded: z.boolean(),
  chain: z.string().optional(),
  stakingMode: z.string().optional(),
  masterAddress: z.string().nullable().optional(),
  services: z.array(fleetServiceSchema),
  stakedLikeCount: z.number(),
  completeCount: z.number(),
});

// ── balances / gas ───────────────────────────────────────────────────────────

const ethBalanceEntrySchema = z.object({
  address: z.string().nullable(),
  balanceWei: z.string().nullable(),
  error: z.string().optional(),
});

const gasBlockSchema = z.object({
  address: z.string().nullable(),
  balanceWei: z.string().optional(),
  dailyEstimateWei: z.string(),
  runwayDaysExcess: z.string().optional(),
  minEthWei: z.string().optional(),
  error: z.string().optional(),
});

// ── activity ─────────────────────────────────────────────────────────────────

const recentActivityEntrySchema = z.object({
  id: z.number(),
  ts: z.string().nullable(),
  kind: z.string(),
  requestId: z.string().nullable(),
  serviceIndex: z.number().nullable(),
  txHash: z.string().nullable(),
  solverType: z.string().nullable(),
  outcome: z.string().nullable(),
});

// ── cost surface (client/src/spend/cost-surface-status.ts) ───────────────────

const costSurfaceHarnessStatusSchema = z.object({
  credentialId: z.string().nullable(),
  usesPaidApiKey: z.boolean(),
});

export const costSurfaceStatusSchema = z.object({
  harnesses: z.record(z.string(), costSurfaceHarnessStatusSchema),
});
export type CostSurfaceStatus = z.infer<typeof costSurfaceStatusSchema>;

// ── harness rollup (client/src/api/status-harness-rollup.ts) ─────────────────

export const harnessRollupSchema = z.object({
  ready: z.boolean(),
  name: z.string().nullable(),
  reason: z.string().nullable(),
});
export type HarnessRollup = z.infer<typeof harnessRollupSchema>;

// ── spend / AI-units (client/src/api/status-build.ts) ────────────────────────

const spendCredentialRowSchema = z.object({
  credentialId: z.string(),
  capUsd: z.number(),
  spentTodayUsd: z.number(),
  paused: z.boolean(),
  resetsAt: z.string(),
});

export const spendStatusSchema = z.object({
  credentials: z.array(spendCredentialRowSchema),
});
export type SpendStatus = z.infer<typeof spendStatusSchema>;

const aiUnitsPausedWindowSchema = z.enum(['block', 'week']).nullable();
export type AiUnitsPausedWindow = z.infer<typeof aiUnitsPausedWindowSchema>;

const aiUnitsCredentialRowSchema = z.object({
  credentialId: z.string(),
  unitsThisBlock: z.number(),
  unitsThisWeek: z.number(),
  capPerBlock: z.number(),
  capPerWeek: z.number(),
  usdMicrosThisBlock: z.number(),
  usdMicrosThisWeek: z.number(),
  capPerBlockUsdMicros: z.number(),
  capPerWeekUsdMicros: z.number(),
  estimated: z.boolean(),
  paused: z.boolean(),
  active: z.boolean(),
  pausedWindow: aiUnitsPausedWindowSchema,
  blockResetsAt: z.string(),
  weekResetsAt: z.string().nullable(),
});

export const aiUnitsStatusSchema = z.object({
  credentials: z.array(aiUnitsCredentialRowSchema),
});
export type AiUnitsStatus = z.infer<typeof aiUnitsStatusSchema>;

// ── config migration (client/src/api/status-build.ts) ────────────────────────

export const configMigrationStatusSchema = z.object({
  shapeVersion: z.literal(2),
  wiringEntries: z.number(),
  postingEntries: z.number(),
  backupPath: z.string().optional(),
  capsUnset: z.boolean(),
});
export type ConfigMigrationStatus = z.infer<typeof configMigrationStatusSchema>;

// ── Phase D transition usage, Class O — observation (§7) ─────────────────────

const phaseDTransitionSignalSchema = z.enum([
  'legacy-operator-composition',
  'marketplace-pipeline-invocation',
  'legacy-task-submission-synthesis',
  'legacy-evaluator-delivery-watcher-loaded',
  'legacy-wiring-config-field',
  'native-operator-composition',
]);

const phaseDTransitionUsageCounterSchema = z.object({
  signal: phaseDTransitionSignalSchema,
  count: z.number().int(),
  firstObservedAt: z.string(),
  lastObservedAt: z.string(),
});

/** Tagged `class: 'observation'` (§7 Class O) so a consumer cannot treat this as a gate input. */
export const phaseDTransitionUsageStatusSchema = z.object({
  schemaVersion: z.literal(1),
  durable: z.boolean(),
  observationWindowStartedAt: z.string(),
  counters: z.array(phaseDTransitionUsageCounterSchema).readonly(),
  class: z.literal('observation'),
});
export type PhaseDTransitionUsageStatus = z.infer<typeof phaseDTransitionUsageStatusSchema>;

// ── operator vertical mode ───────────────────────────────────────────────────

export const operatorVerticalModeSchema = z.enum(['legacy', 'native-v1']);
export type OperatorVerticalMode = z.infer<typeof operatorVerticalModeSchema>;

// ── portfolio.v0 (client/src/api/portfolio-v0-build.ts) ──────────────────────

const inFlightTaskSummarySchema = z.object({
  requestId: z.string(),
  state: z.string(),
  solverType: z.string().nullable(),
  implName: z.string().nullable(),
  windowStartTs: z.number(),
  windowEndTs: z.number(),
  stateUpdatedAt: z.number(),
  lastError: z.string().nullable(),
});

const verdictSummarySchema = z.object({
  requestId: z.string(),
  state: z.enum(['COMPLETE', 'FAILED', 'RACE_LOST']),
  implName: z.string().nullable(),
  solverType: z.string().nullable(),
  windowStartTs: z.number(),
  windowEndTs: z.number(),
  stateUpdatedAt: z.number(),
  failureReason: z.string().nullable(),
  manifestCid: z.string().nullable(),
  deliveryTxHash: z.string().nullable(),
});

const snapshotSummarySchema = z.object({
  id: z.string(),
  requestId: z.string(),
  title: z.string(),
  outcome: z.string(),
  createdAt: z.string(),
});

const claudeOutcomeSummarySchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
  durationMs: z.number(),
  aborted: z.boolean(),
  fillsInSessionWindow: z.number(),
  coinCounts: z.record(z.string(), z.number()),
  fillsQueryError: z.string().optional(),
});

const portfolioV0TotalsSchema = z.object({
  delivered: z.number(),
  failed: z.number(),
  settledFailed: z.number(),
  localErrors: z.number(),
  raceLost: z.number(),
  active: z.number(),
});

export const portfolioV0StatusSchema = z.object({
  totals: portfolioV0TotalsSchema,
  inFlight: z.array(inFlightTaskSummarySchema),
  recentVerdicts: z.array(verdictSummarySchema),
  recentSnapshots: z.array(snapshotSummarySchema),
  recentClaudeOutcomes: z.array(claudeOutcomeSummarySchema),
});
export type PortfolioV0Status = z.infer<typeof portfolioV0StatusSchema>;

// ── prediction.v1 (client/src/api/prediction-v1-build.ts) ────────────────────

const predictionV1TaskRunSummarySchema = z.object({
  requestId: z.string(),
  taskId: z.string().nullable(),
  taskCid: z.string(),
  state: z.string(),
  taskRole: z.enum(['restoration', 'evaluation']).nullable(),
  implName: z.string().nullable(),
  windowStartTs: z.number(),
  windowEndTs: z.number(),
  runStartedAt: z.number().nullable(),
  stateUpdatedAt: z.number(),
  manifestCid: z.string().nullable(),
  deliveryTxHash: z.string().nullable(),
  failureReason: z.string().nullable(),
});

const predictionV1TotalsSchema = z.object({
  observedTasks: z.number(),
  activeTaskRuns: z.number(),
  solutions: z.number(),
  verdicts: z.number(),
  failed: z.number(),
  settledFailed: z.number(),
  localErrors: z.number(),
  raceLost: z.number(),
});

/**
 * `operator` stays opaque — see the module docstring. `z.custom` performs a shallow runtime
 * check (object, not `PredictionOperatorStatusForApi` field by field) and the TS type is a
 * deliberately narrow `Record<string, unknown>` rather than the real daemon-side type.
 */
const predictionOperatorStatusForApiSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null,
  { message: 'operator must be an object' },
);

export const predictionV1StatusSchema = z.object({
  operator: predictionOperatorStatusForApiSchema.nullable(),
  operatorError: z.string().optional(),
  totals: predictionV1TotalsSchema,
  latest: z.object({
    taskAt: z.number().nullable(),
    solutionAt: z.number().nullable(),
    verdictAt: z.number().nullable(),
  }),
  recentTasks: z.array(predictionV1TaskRunSummarySchema),
  recentSolutions: z.array(predictionV1TaskRunSummarySchema),
  recentVerdicts: z.array(predictionV1TaskRunSummarySchema),
});
export type PredictionV1Status = z.infer<typeof predictionV1StatusSchema>;

// ── generic task runs (client/src/api/task-runs-build.ts) ────────────────────

const runOutcomeSchema = z.enum(['pass', 'fail', 'awaiting', 'accepted', 'rejected']).nullable();

const taskRunSummarySchema = z.object({
  requestId: z.string(),
  taskId: z.string().nullable(),
  taskCid: z.string(),
  solverType: z.string().nullable(),
  state: z.string(),
  taskRole: z.enum(['restoration', 'evaluation']).nullable(),
  implName: z.string().nullable(),
  windowStartTs: z.number(),
  windowEndTs: z.number(),
  runStartedAt: z.number().nullable(),
  stateUpdatedAt: z.number(),
  manifestCid: z.string().nullable(),
  deliveryTxHash: z.string().nullable(),
  failureReason: z.string().nullable(),
  outcome: runOutcomeSchema,
});

export const taskRunsStatusSchema = z.object({
  totals: z.object({
    observedTasks: z.number(),
    activeTaskRuns: z.number(),
    completed: z.number(),
    solutions: z.number(),
    verdicts: z.number(),
    failed: z.number(),
    settledFailed: z.number(),
    localErrors: z.number(),
    raceLost: z.number(),
  }),
  inFlight: z.array(taskRunSummarySchema),
  recentTasks: z.array(taskRunSummarySchema),
});
export type TaskRunsStatus = z.infer<typeof taskRunsStatusSchema>;

// ── loop completion + impl-state cadence (client/src/api/loop-completion-build.ts) ──

export const loopCompletionStatusSchema = z.object({
  total: z.number(),
  delivered: z.number(),
  withGating: z.number(),
  reachedExecute: z.number(),
  reachedImprove: z.number(),
  reachedMemoryConsolidation: z.number(),
  fullLoop: z.number(),
  phaseCounts: z.record(z.string(), z.number()),
});
export type LoopCompletionStatus = z.infer<typeof loopCompletionStatusSchema>;

const implStateRepoCadenceSchema = z.object({
  name: z.string(),
  commits: z.number(),
  lastCommit: z
    .object({
      shortHash: z.string(),
      timestamp: z.number(),
      date: z.string(),
    })
    .nullable(),
});

export const implStateCadenceStatusSchema = z.object({
  repos: z.array(implStateRepoCadenceSchema),
  error: z.string().optional(),
});
export type ImplStateCadenceStatus = z.infer<typeof implStateCadenceStatusSchema>;

// ── evidence indexing (client/src/types/evidence-indexing.ts) ────────────────

const evidenceIndexingFailureSummarySchema = z.object({
  reference: z.string(),
  category: z.string(),
  message: z.string(),
});

export const evidenceIndexingStatusSchema = z.object({
  failures: z.array(evidenceIndexingFailureSummarySchema).readonly(),
  pending: z.number(),
});
export type EvidenceIndexingStatus = z.infer<typeof evidenceIndexingStatusSchema>;

// ── the envelope ───────────────────────────────────────────────────────────

export const statusV1ResponseSchema = z.object({
  /** Read-contract handshake (§8 artifact 1). */
  contractVersion: contractVersionSchema,
  statusMode: z.enum(['full', 'sqlite_only']),
  version: z.string(),
  latestVersion: z.string().nullable(),
  daemon: z.object({
    shutdownState: z.string().nullable(),
    startedAt: z.string().nullable(),
    dbPath: z.string(),
    timestamp: z.string(),
  }),
  rpc: z.object({
    ok: z.boolean(),
    chainId: z.number().optional(),
    blockNumber: z.string().optional(),
    error: z.string().optional(),
  }),
  fleet: fleetSchema,
  autoRestake: z.object({
    enabled: z.boolean(),
    checkIntervalMs: z.number(),
  }),
  activity: z.object({
    counts: z.record(z.string(), z.number()),
    recent: z.array(recentActivityEntrySchema),
  }),
  rewards: z.object({
    claimLoopIntervalMs: z.number(),
    lastClaimTickAt: z.string().nullable(),
    claimedStakingRewardsWei: z.string(),
    claimedStakingRewardsLast24hWei: z.string().nullable(),
  }),
  balances: z.object({
    eth: z.object({
      master: ethBalanceEntrySchema,
      agent: ethBalanceEntrySchema,
      safe: ethBalanceEntrySchema,
    }),
  }),
  masterGas: gasBlockSchema,
  l1MasterGas: gasBlockSchema.optional(),
  earnings: z.object({
    hint: z.string(),
  }),
  nextActions: z.array(z.string()),
  portfolioV0: portfolioV0StatusSchema.optional(),
  predictionV1: predictionV1StatusSchema.optional(),
  taskRuns: taskRunsStatusSchema.optional(),
  loopCompletion: loopCompletionStatusSchema.optional(),
  implStateCadence: implStateCadenceStatusSchema.optional(),
  evidenceIndexing: evidenceIndexingStatusSchema.optional(),
  spend: spendStatusSchema.optional(),
  aiUnits: aiUnitsStatusSchema.optional(),
  costSurface: costSurfaceStatusSchema,
  harness: harnessRollupSchema,
  security: z.object({
    lastPasswordRotationAt: z.string().nullable(),
  }),
  configMigration: configMigrationStatusSchema.optional(),
  phaseDTransitionUsage: phaseDTransitionUsageStatusSchema.optional(),
  effectiveMode: operatorVerticalModeSchema,
});

export type StatusV1Response = z.infer<typeof statusV1ResponseSchema>;
