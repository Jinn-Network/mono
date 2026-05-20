import * as fs from 'node:fs/promises';
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

/** Outcome a scenario body returns when it does not fail (which throws). */
export type ScenarioOutcome =
  | { verdict: 'pass' }
  | { verdict: 'skip'; failNotes: string };

/** Append-only evidence log handed to a scenario body. */
export interface EvidenceLog {
  log(msg: string): void;
}

/**
 * Run a Tier-1 scenario body with the shared boilerplate: wall-clock timing,
 * timestamped evidence-log accumulation, the evidence-file write, and the
 * pass/fail/skip verdict shape. The body runs its logic and either returns a
 * non-fail outcome or throws — a thrown error becomes a classified `fail`.
 */
export async function runScenario(
  scenarioId: string,
  opts: ScenarioOptions,
  body: (evidence: EvidenceLog) => Promise<ScenarioOutcome>,
): Promise<ScenarioVerdict> {
  const started = Date.now();
  const evidenceLines: string[] = [];
  const evidence: EvidenceLog = {
    log: (msg) => evidenceLines.push(`[${new Date().toISOString()}] ${msg}`),
  };

  const writeEvidence = (): Promise<void> =>
    fs.writeFile(opts.evidencePath, evidenceLines.join('\n'));

  try {
    const outcome = await body(evidence);
    await writeEvidence();
    return {
      scenarioId,
      verdict: outcome.verdict,
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: null,
      failNotes: outcome.verdict === 'skip' ? outcome.failNotes : null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    evidence.log(`FAILED: ${message}`);
    await writeEvidence();
    return {
      scenarioId,
      verdict: 'fail',
      wallClockMs: Date.now() - started,
      evidencePath: opts.evidencePath,
      failClass: classifyFailure(err),
      failNotes: message,
    };
  }
}
