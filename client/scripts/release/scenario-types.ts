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

/**
 * Flake-classification rules, checked top to bottom — list order is precedence.
 * A failure not matched by any rule defaults to `real-bug` (conservative).
 */
const FLAKE_RULES: { klass: FailClass; patterns: RegExp[] }[] = [
  {
    klass: 'flake-infra',
    // Each pattern must denote a genuine connectivity failure. A bare /network/i
    // over-matches real bugs (e.g. "network mismatch (expected base-sepolia)"),
    // so connectivity is matched only via the specific phrases below.
    patterns: [
      /HTTP request failed/i,
      /ECONNREFUSED/i,
      /ECONNRESET/i,
      /socket hang up/i,
      /network error/i,
      /network connection/i,
      /getaddrinfo/i,
    ],
  },
  {
    klass: 'flake-timing',
    patterns: [/timed out/i, /timeout/i, /waiting for/i],
  },
];

export function classifyFailure(err: unknown): FailClass {
  const msg = err instanceof Error ? err.message : String(err);
  for (const { klass, patterns } of FLAKE_RULES) {
    if (patterns.some((re) => re.test(msg))) return klass;
  }
  return 'real-bug';
}

/**
 * The run-tier process exit code for a set of scenario verdicts — the contract
 * `environment-suite.yml` decodes (1 → product-red, 4 → infra-blocked, 0 → ok):
 *
 *   1 = product-red    — at least one `real-bug`. A hard product failure; the
 *                        gate fails and blocks the cut.
 *   4 = infra-blocked  — at least one OTHER fail (flake-timing / flake-infra /
 *                        agent-crash) and no real-bug. A timeout/connectivity/
 *                        crash symptom is NOT proof of a transient, so it must
 *                        SURFACE and block (named as infra), never clear the
 *                        gate green. (This is the flake-mask fix: these used to
 *                        exit 0 and silently pass, letting a deterministic-
 *                        trigger failure — e.g. a stuck launch — slip the gate.)
 *                        A genuine one-off transient is re-cleared by re-running
 *                        the authoritative dispatch; the gate never lies meanwhile.
 *   0 = every scenario passed or was skipped.
 *
 * real-bug dominates infra-blocked (a confirmed product regression is the more
 * severe, more actionable signal).
 */
export function exitCodeForVerdicts(verdicts: ScenarioVerdict[]): 0 | 1 | 4 {
  const isFail = (v: ScenarioVerdict): boolean => v.verdict === 'fail';
  if (verdicts.some((v) => isFail(v) && v.failClass === 'real-bug')) return 1;
  if (verdicts.some((v) => isFail(v) && v.failClass !== 'real-bug')) return 4;
  return 0;
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
