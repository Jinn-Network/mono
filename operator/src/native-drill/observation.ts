// operator/src/native-drill/observation.ts
/**
 * The machine-readable result one role-host process returns to the drill driver.
 *
 * Observations cross a real process boundary as canonical JSON, so every field is a plain
 * JSON-representable value; `bigint` never appears here.
 */
import { z } from 'zod/v3';
import { PHASE_B_RESTART_CHECKPOINT_SET } from '../daemon/phase-b-closure-manifest.js';

export const DrillRunModeSchema = z.enum(['uninterrupted', 'recovered']);
export type DrillRunMode = z.infer<typeof DrillRunModeSchema>;

export const RunObservationSchema = z.object({
  checkpoint: z.enum(PHASE_B_RESTART_CHECKPOINT_SET),
  seed: z.string().min(1),
  mode: DrillRunModeSchema,
  /** Terminal lifecycle state of the drilled record, e.g. `published`, `solution-settled`. */
  finalState: z.string().min(1),
  /** Digest of the canonical record graph the run produced; the equality anchor of the drill. */
  graphDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  /** Logical operation ids — stable across a restart by construction. */
  operationIds: z.array(z.string().min(1)),
  /** Every transaction hash the run attached to an operation, including replacements. */
  transactionHashes: z.array(z.string().regex(/^0x[0-9a-f]{64}$/u)),
  /** Signed source-chain head entry digests the run advanced. */
  sourceHeads: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/u)),
  /** Durable side-effect counters (posts, claims, publications, settlements, duplicates). */
  effects: z.record(z.number().int().min(0)),
  /** Port invocation counters — a restart may legitimately raise these where effects do not. */
  invocations: z.record(z.number().int().min(0)),
  /** Sanitized one-line state summaries either side of the injected boundary. */
  stateBefore: z.string().min(1),
  stateAfter: z.string().min(1),
}).strict();

export type RunObservation = z.infer<typeof RunObservationSchema>;

export interface RunComparison {
  readonly equal: boolean;
  readonly differences: readonly string[];
}

/**
 * The drill's central assertion: a run recovered from a killed process must be indistinguishable
 * from the uninterrupted run in every durable respect. Port invocation counts are deliberately
 * excluded — a recovery legitimately re-reads the chain — but every durable effect, the operation
 * identities, the source heads, and the final graph digest must match exactly.
 */
export function compareRuns(
  uninterrupted: RunObservation,
  recovered: RunObservation,
): RunComparison {
  const differences: string[] = [];
  const scalar = <K extends 'finalState' | 'graphDigest'>(key: K): void => {
    if (uninterrupted[key] !== recovered[key]) {
      differences.push(`${key}: uninterrupted=${uninterrupted[key]} recovered=${recovered[key]}`);
    }
  };
  scalar('finalState');
  scalar('graphDigest');

  const list = (key: 'operationIds' | 'sourceHeads'): void => {
    const left = [...uninterrupted[key]].sort();
    const right = [...recovered[key]].sort();
    if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
      differences.push(`${key}: uninterrupted=[${left.join(',')}] recovered=[${right.join(',')}]`);
    }
  };
  list('operationIds');
  list('sourceHeads');

  for (const name of new Set([
    ...Object.keys(uninterrupted.effects),
    ...Object.keys(recovered.effects),
  ])) {
    const left = uninterrupted.effects[name];
    const right = recovered.effects[name];
    if (left !== right) {
      differences.push(`effects.${name}: uninterrupted=${left ?? 'absent'} recovered=${right ?? 'absent'}`);
    }
  }

  return { equal: differences.length === 0, differences };
}

/**
 * The runbook's "zero duplicate posts/claims/deliveries/settlements" proofs, made checkable.
 * A missing counter is a failure, not a pass: a drill that stopped counting must not read as clean.
 */
export function checkRequiredEffects(
  observation: RunObservation,
  required: Readonly<Record<string, number>>,
): readonly string[] {
  const failures: string[] = [];
  for (const [name, expected] of Object.entries(required)) {
    const actual = observation.effects[name];
    if (actual === undefined) {
      failures.push(`effects.${name} was not reported (expected ${expected})`);
    } else if (actual !== expected) {
      failures.push(`effects.${name}=${actual}, expected ${expected}`);
    }
  }
  return failures;
}
