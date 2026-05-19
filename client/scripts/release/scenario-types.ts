import { z } from 'zod';

export const FailClassSchema = z.enum(['real-bug', 'flake-infra', 'flake-timing', 'agent-crash']);
export type FailClass = z.infer<typeof FailClassSchema>;

export const VerdictKindSchema = z.enum(['pass', 'fail', 'skip']);
export type VerdictKind = z.infer<typeof VerdictKindSchema>;

export const ScenarioVerdictSchema = z.object({
  scenarioId: z.string(),
  verdict: VerdictKindSchema,
  wallClockMs: z.number().int().nonnegative(),
  evidencePath: z.string(),
  failClass: FailClassSchema.nullable(),
  failNotes: z.string().nullable(),
}).refine(
  (v) => v.verdict !== 'fail' || v.failClass !== null,
  { message: 'fail verdicts must include a failClass' },
);

export type ScenarioVerdict = z.infer<typeof ScenarioVerdictSchema>;

export interface ScenarioOptions {
  /** Where the scenario should write its evidence (log file path). */
  evidencePath: string;
  /** Wall-clock budget in ms; scenario should abort if exceeded. */
  wallClockBudgetMs?: number;
  /** Optional RPC URL override. */
  rpcUrl?: string;
}

const FLAKE_INFRA_PATTERNS = [
  /HTTP request failed/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /socket hang up/i,
  /network/i,
  /getaddrinfo/i,
];
const FLAKE_TIMING_PATTERNS = [
  /timed out/i,
  /timeout/i,
  /waiting for/i,
];

export function classifyFailure(err: unknown): FailClass {
  const msg = err instanceof Error ? err.message : String(err);
  for (const re of FLAKE_INFRA_PATTERNS) {
    if (re.test(msg)) return 'flake-infra';
  }
  for (const re of FLAKE_TIMING_PATTERNS) {
    if (re.test(msg)) return 'flake-timing';
  }
  return 'real-bug';
}
