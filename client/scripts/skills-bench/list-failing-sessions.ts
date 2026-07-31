/**
 * Lists the failing/regressed working set a human uses to write the private
 * annex (spec §1.1/§3.1 step 6 of
 * docs/superpowers/specs/2026-07-30-skills-factory-mvp-design.md, v0.2):
 * every treatment-arm attempt that did not resolve — whether it regressed a
 * baseline pass, concordantly failed alongside the baseline, or graded as
 * ungradeable — paired with its transcript path, session-JSONL path, and
 * measured trigger status. Manual-first per the v0.2 plan: this script is a
 * filter over data already captured, not a diagnosis tool — no LLM tooling.
 *
 * Usage:
 *   yarn tsx scripts/skills-bench/list-failing-sessions.ts \
 *     --run ../bench/runs/tdd-pilot [--arm tdd]
 *
 * `--arm` selects the treatment arm; if omitted, the run's sole non-baseline
 * arm (per bench-manifest.json) is used, and the script refuses to guess
 * when a run has more than one.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { attemptKey, loadAttempts, type BenchManifest, type BenchOutcome } from '../../src/skills-bench/attempts.js';
import { detectSkillTrigger } from '../../src/skills-bench/trigger.js';

// ---------------------------------------------------------------------------
// Pure selection logic — no filesystem. The CLI (main, below) does the I/O
// and formatting; this is what capability-report.test.ts-style tests drive
// directly with synthetic outcomes.
// ---------------------------------------------------------------------------

export type SessionOutcomeLabel = 'regressed' | 'failed' | 'ungradeable';

export interface FailingSessionSelection {
  taskId: string;
  repeat: number;
  outcomeLabel: SessionOutcomeLabel;
}

/** Selects every treatment-arm attempt that did not resolve
 *  (`passed !== true`) — the annex's working set is "the treatment failed or
 *  regressed" (plan work item 5), which this reads as the union of:
 *  - `regressed`: the paired baseline attempt (same instanceId + repeat)
 *    resolved but the treatment did not — the sharpest diagnosis case
 *    (actively harmful or masking a working baseline path).
 *  - `failed`: the treatment did not resolve and either there's no paired
 *    baseline attempt or the baseline didn't resolve either (concordant
 *    fail) — still useful for the never-triggered / vague-guidance
 *    diagnosis, just not evidence of harm on its own.
 *  - `ungradeable`: the treatment attempt's patch never graded at all.
 *  A resolved (`passed === true`) treatment attempt is never included — it
 *  is not part of the failing/regressed working set. */
export function selectFailingSessions(
  outcomes: BenchOutcome[],
  opts: { baselineArm: string; treatmentArm: string },
): FailingSessionSelection[] {
  const baselineByKey = new Map<string, BenchOutcome>();
  for (const o of outcomes) {
    if (o.arm === opts.baselineArm) baselineByKey.set(`${o.instanceId}#${o.repeat}`, o);
  }
  const results: FailingSessionSelection[] = [];
  for (const o of outcomes) {
    if (o.arm !== opts.treatmentArm || o.passed === true) continue;
    let outcomeLabel: SessionOutcomeLabel;
    if (o.passed === null) {
      outcomeLabel = 'ungradeable';
    } else {
      const base = baselineByKey.get(`${o.instanceId}#${o.repeat}`);
      outcomeLabel = base?.passed === true ? 'regressed' : 'failed';
    }
    results.push({ taskId: o.instanceId, repeat: o.repeat, outcomeLabel });
  }
  return results.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.repeat - b.repeat);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  runDir: string;
  arm: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--run': args.runDir = resolve(String(argv[++i])); break;
      case '--arm': args.arm = String(argv[++i]); break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!args.runDir) throw new Error('--run is required');
  return args as Args;
}

async function loadManifest(runDir: string): Promise<BenchManifest> {
  const raw = await readFile(join(runDir, 'bench-manifest.json'), 'utf8');
  return JSON.parse(raw) as BenchManifest;
}

function resolveTreatmentArmName(manifest: BenchManifest, requested: string | undefined): string {
  const treatmentArms = manifest.arms.filter((arm) => arm.skillSha256 !== null);
  if (requested) {
    if (!treatmentArms.some((arm) => arm.name === requested)) {
      throw new Error(`no treatment arm named '${requested}' in bench-manifest.json — available: ` +
        treatmentArms.map((a) => a.name).join(', '));
    }
    return requested;
  }
  if (treatmentArms.length === 0) throw new Error('bench-manifest.json has no treatment arm (every arm has skillSha256: null)');
  if (treatmentArms.length > 1) {
    throw new Error(
      `bench-manifest.json has ${treatmentArms.length} treatment arms (${treatmentArms.map((a) => a.name).join(', ')}) ` +
      `— pass --arm <name> to select one`,
    );
  }
  return treatmentArms[0]!.name;
}

async function triggeredLabel(runDir: string, key: string, armName: string): Promise<string> {
  try {
    const text = await readFile(join(runDir, 'transcripts', `${key}.session.jsonl`), 'utf8');
    const result = detectSkillTrigger(text, armName);
    return result.triggered ? 'yes' : 'no';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest(args.runDir);
  const baselineArm = manifest.arms.find((arm) => arm.skillSha256 === null);
  if (!baselineArm) throw new Error('bench-manifest.json has no baseline arm (skillSha256: null)');
  const treatmentArmName = resolveTreatmentArmName(manifest, args.arm);

  const outcomes = await loadAttempts(join(args.runDir, 'attempts.jsonl'));
  const selections = selectFailingSessions(outcomes, { baselineArm: baselineArm.name, treatmentArm: treatmentArmName });

  if (selections.length === 0) {
    console.log(`[list-failing-sessions] no failing/regressed attempts for arm '${treatmentArmName}' in ${args.runDir}`);
    return;
  }

  console.log(`[list-failing-sessions] ${selections.length} failing/regressed attempt(s) for arm '${treatmentArmName}':`);
  for (const s of selections) {
    const key = attemptKey({ instanceId: s.taskId, arm: treatmentArmName, repeat: s.repeat });
    const triggered = await triggeredLabel(args.runDir, key, treatmentArmName);
    const transcriptPath = join(args.runDir, 'transcripts', `${key}.json`);
    const sessionPath = join(args.runDir, 'transcripts', `${key}.session.jsonl`);
    console.log(
      `${key} — ${s.outcomeLabel} — triggered: ${triggered} — transcript: ${transcriptPath} — session: ${sessionPath}`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
