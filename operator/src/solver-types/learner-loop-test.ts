import { z } from 'zod/v3';
import type { SolverTypeDefinition } from './solver-type.js';

/**
 * Synthetic SolverType for verifying the claude-code-learner full cycle
 * end-to-end. NO venue dependencies, NO real money. The task describes
 * a trivial deterministic task: write a JSON output file with N named
 * fields each containing a fixed value.
 *
 * Why this kind exists: to exercise the learner's pipeline (Orient →
 * Strategize → Plan → Execute → Debrief → Improve → Memory consolidation)
 * with real LLM agents but without the cost / fragility of real-venue
 * kinds. Used by:
 *   - manual smoke testing per docs/superpowers/runbooks/2026-04-26-claude-code-learner-manual-smoke.md
 *   - automated yarn e2e:full-cycle harness (gated on claude availability)
 *
 * Plan 4 T2 / bd jinn-mono-k8s.
 */

const LearnerLoopTestSpecSchema = z.object({
  /** Field names the agent must include in the output JSON. */
  fieldNames: z.array(z.string().min(1)).min(1).max(20),
  /** The fixed string value each field must contain. */
  fieldValue: z.string(),
});

const LearnerLoopTestTaskSchema = z.object({
  spec: z.object({ kind: z.literal('learner-loop-test') }).merge(LearnerLoopTestSpecSchema),
  window: z.object({ startTs: z.number(), endTs: z.number() }),
  eligibility: z.unknown().optional(),
});

export const learnerLoopTest: SolverTypeDefinition = {
  solverType: 'learner-loop-test',
  async parseSpec(raw) {
    const task = LearnerLoopTestTaskSchema.parse(raw);
    return { window: task.window, spec: task.spec, eligibility: task.eligibility };
  },
  ui: {
    description: 'Synthetic test kind for claude-code-learner full-cycle verification',
    category: 'test',
  },
};
