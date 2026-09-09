// operator/src/native-drill/report.ts
/**
 * The sanitized, digestable recovery report one restart drill emits (#2434).
 *
 * Its digest is the value the Phase B closure manifest carries in `recoveryReports[].digest`
 * (`operator/src/daemon/phase-b-closure-manifest.ts`), so the report is sealed with the same
 * canonical encoding and the same fail-closed private-material scan as the manifest itself.
 *
 * The report's retention list is the runbook's
 * (`docs/runbooks/phase-b-native-vertical.md`, "Six mandatory restart drills"): seed, injected
 * boundary, sanitized before/after state summaries, operation ids and transaction hashes, source
 * heads, final graph digest, and the comparison with the uninterrupted run.
 */
import { documentDigest, serializeCanonicalJson } from '@jinn-network/task-execution-protocol';
import { z } from 'zod/v3';
import {
  PHASE_B_RESTART_CHECKPOINT_SET,
  assertNoPrivateMaterial,
} from '../daemon/phase-b-closure-manifest.js';
import { RunObservationSchema, type RunComparison, type RunObservation } from './observation.js';

const ARTIFACT = 'Phase B restart-drill report';

/** The observation as it appears inside a report: identity fields are lifted to the report itself. */
const ReportRunSchema = RunObservationSchema.omit({ checkpoint: true, seed: true, mode: true });

export const DrillRecoveryReportSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('jinn.phase-b-restart-drill-report'),
  checkpoint: z.enum(PHASE_B_RESTART_CHECKPOINT_SET),
  seed: z.string().min(1),
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  chain: z.object({
    chainId: z.literal(84532),
    /** `hermetic` is a local Anvil pinned to 84532; `fork` is an Anvil fork of Base Sepolia. */
    mode: z.enum(['hermetic', 'fork']),
    /** Present only in `fork` mode: the pinned block that makes the fork re-runnable. */
    forkBlockNumber: z.string().regex(/^(0|[1-9]\d*)$/u).optional(),
  }).strict(),
  injectedBoundary: z.object({
    role: z.enum(['requester', 'solver', 'evaluator']),
    /** How the process died: always an uncatchable kill, never a cooperative in-process throw. */
    injection: z.literal('SIGKILL'),
    description: z.string().min(1),
    proof: z.string().min(1),
  }).strict(),
  uninterrupted: ReportRunSchema,
  recovered: ReportRunSchema,
  comparison: z.object({
    equalToUninterrupted: z.literal(true),
    /** Retained so a reader can see which invariants were compared, not merely that they held. */
    comparedInvariants: z.array(z.string().min(1)).min(1),
    requiredEffects: z.record(z.number().int().min(0)),
  }).strict(),
  /**
   * What the deterministic drill does NOT cover, named explicitly. The live closure run supplies
   * these; a reader must not mistake a green drill for a green live round trip.
   */
  liveRunDelta: z.array(z.string().min(1)).min(1),
}).strict();

export type DrillRecoveryReport = z.infer<typeof DrillRecoveryReportSchema>;

export interface SealedDrillReport {
  readonly report: DrillRecoveryReport;
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
}

export const LIVE_RUN_DELTA: readonly string[] = [
  'a funded, mech-registered operator Safe and the escrowed marketplace post/claim/deliver legs',
  'a live requester record source serving its signed .well-known introduction',
  'container-graded evaluation (Docker), which is deploy-time by construction',
];

/**
 * Seal a report: reject private material, validate, and canonically encode. The digest is over the
 * exact bytes written, so a manifest citing it is citing the file on disk.
 */
export function sealDrillReport(input: DrillRecoveryReport): SealedDrillReport {
  assertNoPrivateMaterial(input, ARTIFACT);
  const report = DrillRecoveryReportSchema.parse(input);
  const bytes = serializeCanonicalJson(report as Parameters<typeof serializeCanonicalJson>[0]);
  return { report, bytes, digest: documentDigest(bytes) };
}

/** Read back a report written by this harness and re-prove its canonical encoding. */
export function parseDrillReport(bytes: Uint8Array): SealedDrillReport {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`${ARTIFACT} is not UTF-8 JSON: ${String(cause)}`);
  }
  const sealed = sealDrillReport(DrillRecoveryReportSchema.parse(decoded));
  if (!Buffer.from(sealed.bytes).equals(Buffer.from(bytes))) {
    throw new Error(`${ARTIFACT} does not use the canonical producer encoding`);
  }
  return sealed;
}

export const COMPARED_INVARIANTS: readonly string[] = [
  'final record-graph digest',
  'logical operation ids',
  'signed source heads',
  'durable effect counters',
  'terminal lifecycle state',
];

/**
 * Build a report from a proven-equal run pair. `comparison.equalToUninterrupted` is a literal
 * `true` in the schema, so an unequal pair cannot be represented as a report at all -- the drill
 * has to fail instead of emitting a report that records its own divergence.
 */
export function buildDrillReport(input: {
  readonly runId: string;
  readonly createdAt: string;
  readonly chain: DrillRecoveryReport['chain'];
  readonly boundary: DrillRecoveryReport['injectedBoundary'];
  readonly uninterrupted: RunObservation;
  readonly recovered: RunObservation;
  readonly comparison: RunComparison;
  readonly requiredEffects: Readonly<Record<string, number>>;
}): SealedDrillReport {
  if (!input.comparison.equal) {
    throw new Error(
      `${ARTIFACT} refused: recovered run diverged from the uninterrupted run — `
      + input.comparison.differences.join('; '),
    );
  }
  const { checkpoint, seed } = input.uninterrupted;
  if (input.recovered.checkpoint !== checkpoint || input.recovered.seed !== seed) {
    throw new Error(`${ARTIFACT} refused: run pair does not share one checkpoint and seed`);
  }
  const strip = (observation: RunObservation): z.infer<typeof ReportRunSchema> => {
    const { checkpoint: _checkpoint, seed: _seed, mode: _mode, ...rest } = observation;
    return rest;
  };
  return sealDrillReport({
    schemaVersion: 1,
    kind: 'jinn.phase-b-restart-drill-report',
    checkpoint,
    seed,
    runId: input.runId,
    createdAt: input.createdAt,
    chain: input.chain,
    injectedBoundary: input.boundary,
    uninterrupted: strip(input.uninterrupted),
    recovered: strip(input.recovered),
    comparison: {
      equalToUninterrupted: true,
      comparedInvariants: [...COMPARED_INVARIANTS],
      requiredEffects: { ...input.requiredEffects },
    },
    liveRunDelta: [...LIVE_RUN_DELTA],
  });
}
