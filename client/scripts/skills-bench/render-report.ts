/**
 * Renders the public capability report (spec §1/§4 of
 * docs/superpowers/specs/2026-07-30-skills-factory-mvp-design.md, v0.2) for a
 * completed `--task-set` skills-bench run: `report.md`, `badge.svg`,
 * `embed.md`, and a `data/` directory carrying the raw run data a reader
 * needs to check the report's math (never the full transcripts, unless
 * explicitly opted in — session files can embed the task repo's own
 * content).
 *
 * This CLI is the --task-set counterpart of render-receipts.ts (which
 * renders slate-mode runs); it refuses a run dir whose manifest has no
 * `taskSetSha256` with a pointer to render-receipts.ts instead.
 *
 * INVARIANT (final-review I6, see trigger.ts's module doc): `--skill` MUST
 * name the same arm name the run's `--arms` file used for this treatment
 * (i.e. the string `mountSkill` mounted the skill under,
 * `.claude/skills/<arm.name>`) — trigger detection below is keyed on that
 * name, not on the skill's own `SKILL.md` `name:`. A revision arm named
 * something else (e.g. `tdd-v2` in a §9 re-eval run) silently reads a 0%
 * trigger rate. `computeTriggerByKey` below also runs a cheap warning check
 * (`findMismatchedSkillInvocations`) for the common failure shape (the model
 * invoked a Skill under a different name than this arm's).
 *
 * Usage:
 *   yarn tsx scripts/skills-bench/render-report.ts \
 *     --run ../bench/runs/tdd-pilot --task-set ../bench/task-sets/tdd \
 *     --skill tdd --report-url https://github.com/Jinn-Network/skills-eval/blob/main/reports/tdd@<sha>/report.md \
 *     [--out ../bench/runs/tdd-pilot/report] [--measured-on 2026-08-01] \
 *     [--agent claude-code] [--skill-source mattpocock/skills@abc123] [--include-transcripts]
 */
import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAttempts, type BenchManifest } from '../../src/skills-bench/attempts.js';
import {
  buildCapabilityReport, buildEmbedSnippet, deriveCostOverhead, renderBadgeSvg, renderCapabilityReportMd,
} from '../../src/skills-bench/capability-report.js';
import { detectSkillTrigger, findMismatchedSkillInvocations } from '../../src/skills-bench/trigger.js';
import { attemptKey } from '../../src/skills-bench/attempts.js';
import type { SkillPin } from '../../src/skills-bench/skill-pin.js';
import { loadTaskSet } from '../../src/skills-bench/task-set.js';

// client/scripts/skills-bench/render-report.ts -> client/scripts/skills-bench -> client/scripts -> client
const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Args {
  runDir: string;
  taskSetDir: string;
  skill: string;
  reportUrl: string;
  outDir: string;
  measuredOn: string;
  agent: string;
  skillSource: string | undefined;
  includeTranscripts: boolean;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { agent: 'claude-code', includeTranscripts: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--run': args.runDir = resolve(String(argv[++i])); break;
      case '--task-set': args.taskSetDir = resolve(String(argv[++i])); break;
      case '--skill': args.skill = String(argv[++i]); break;
      case '--report-url': args.reportUrl = String(argv[++i]); break;
      case '--out': args.outDir = resolve(String(argv[++i])); break;
      case '--measured-on': args.measuredOn = String(argv[++i]); break;
      case '--agent': args.agent = String(argv[++i]); break;
      case '--skill-source': args.skillSource = String(argv[++i]); break;
      case '--include-transcripts': args.includeTranscripts = true; break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!args.runDir) throw new Error('--run is required');
  if (!args.taskSetDir) throw new Error('--task-set is required');
  if (!args.skill) throw new Error('--skill is required');
  if (!args.reportUrl) throw new Error('--report-url is required');
  if (!args.outDir) args.outDir = join(args.runDir, 'report');
  if (!args.measuredOn) args.measuredOn = today();
  return args as Args;
}

async function loadManifest(runDir: string): Promise<BenchManifest> {
  const raw = await readFile(join(runDir, 'bench-manifest.json'), 'utf8');
  return JSON.parse(raw) as BenchManifest;
}

/** Reads `transcripts/<attemptKey>.session.jsonl` for every solved+failed
 *  (passed !== null) treatment-arm attempt and runs the trigger detector
 *  (trigger.ts) — mirrors render-receipts.ts's computeTriggerRate, but keeps
 *  the per-attempt result (never just the aggregate) so the per-task table
 *  can show each attempt's own triggered status. A missing/unreadable
 *  session file leaves the key absent from the map — `buildCapabilityReport`
 *  reads an absent key as `unknown`, never as "not triggered". */
async function computeTriggerByKey(
  runDir: string,
  outcomes: { instanceId: string; arm: string; repeat: number; passed: boolean | null }[],
  armName: string,
): Promise<Map<string, boolean | null>> {
  const transcriptsDir = join(runDir, 'transcripts');
  const byKey = new Map<string, boolean | null>();
  for (const o of outcomes) {
    if (o.arm !== armName || o.passed === null) continue;
    const key = attemptKey(o);
    try {
      const text = await readFile(join(transcriptsDir, `${key}.session.jsonl`), 'utf8');
      byKey.set(key, detectSkillTrigger(text, armName).triggered);
      // I6: cheap warning-only check for the arm-name/skill-identity
      // mismatch this module's header documents — if the model invoked a
      // Skill under a DIFFERENT name than this arm's, trigger detection
      // above still reads this attempt correctly (it only checks armName),
      // but a 0% (or partial) trigger rate elsewhere in this same run could
      // actually be this mismatch, not genuine non-use. Diagnostic only —
      // never changes byKey.
      const mismatches = findMismatchedSkillInvocations(text, armName);
      if (mismatches.length > 0) {
        console.warn(
          `[render-report] WARNING: ${key} invoked Skill under a different name than this arm ` +
          `('${armName}'): ${mismatches.join(', ')} — check that the arm name matches the mounted ` +
          `skill's own identity (see this file's and trigger.ts's module docs, final-review I6).`,
        );
      }
    } catch {
      // Left absent — unknown, per the doc comment above.
    }
  }
  return byKey;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const manifest = await loadManifest(args.runDir);
  if (manifest.dryRun) {
    throw new Error(
      `${join(args.runDir, 'bench-manifest.json')} is a dry-run manifest (dryRun: true) — refusing to ` +
      `render a report from synthesized outcomes. Use a real (non-dry-run) --run dir.`,
    );
  }
  if (!manifest.taskSetSha256) {
    throw new Error(
      `${join(args.runDir, 'bench-manifest.json')} has no taskSetSha256 — this looks like a --slate run; ` +
      `use render-receipts.ts for slate-mode runs.`,
    );
  }
  const taskSet = await loadTaskSet(args.taskSetDir);
  if (taskSet.sha256 !== manifest.taskSetSha256) {
    throw new Error(
      `task-set mismatch: ${args.taskSetDir} sha256=${taskSet.sha256} does not match ` +
      `bench-manifest.json taskSetSha256=${manifest.taskSetSha256}`,
    );
  }

  const baselineArm = manifest.arms.find((arm) => arm.skillSha256 === null);
  if (!baselineArm) throw new Error('bench-manifest.json has no baseline arm (skillSha256: null)');
  const treatmentArm = manifest.arms.find((arm) => arm.name === args.skill);
  if (!treatmentArm) {
    throw new Error(
      `no arm named '${args.skill}' in ${join(args.runDir, 'bench-manifest.json')} — available arms: ` +
      manifest.arms.map((a) => a.name).join(', '),
    );
  }
  // I5: --skill must resolve to a TREATMENT arm — refuse the baseline arm
  // (skillSha256: null) rather than silently rendering a baseline-vs-baseline
  // report (net 0/N, `skill: baseline` in the receipt block). Mirrors the
  // sibling CLIs' guard (list-failing-sessions.ts's resolveTreatmentArmName,
  // record-annex.ts's arm lookup).
  if (treatmentArm.skillSha256 === null) {
    const treatmentArms = manifest.arms.filter((a) => a.skillSha256 !== null);
    throw new Error(
      `'${args.skill}' resolves to the baseline arm (skillSha256: null) in ` +
      `${join(args.runDir, 'bench-manifest.json')} — refusing to render a baseline-vs-baseline report. ` +
      `Pass --skill naming a treatment arm instead — available: ${treatmentArms.map((a) => a.name).join(', ') || '(none)'}`,
    );
  }

  const outcomes = await loadAttempts(join(args.runDir, 'attempts.jsonl'));
  const triggerByKey = await computeTriggerByKey(args.runDir, outcomes, treatmentArm.name);

  await mkdir(join(args.outDir, 'data'), { recursive: true });
  await copyFile(join(args.runDir, 'attempts.jsonl'), join(args.outDir, 'data', 'attempts.jsonl'));
  await copyFile(join(args.runDir, 'bench-manifest.json'), join(args.outDir, 'data', 'bench-manifest.json'));
  await copyFile(join(args.taskSetDir, 'set.json'), join(args.outDir, 'data', 'set.json'));
  const dataPaths = ['data/attempts.jsonl', 'data/bench-manifest.json', 'data/set.json'];
  if (args.includeTranscripts) {
    await cp(join(args.runDir, 'transcripts'), join(args.outDir, 'data', 'transcripts'), { recursive: true });
    dataPaths.push('data/transcripts/');
  }

  const taskSetRelFromClient = relative(clientDir, args.taskSetDir);
  // I4/nit: point at data/bench-manifest.json for arm reconstruction instead
  // of a bracketed arms-file placeholder with no source — the manifest's own
  // "arms" field (name + skillSha256 per arm) is the actual source of truth
  // for rebuilding the --arms JSON this run used.
  const rerunCommand =
    `yarn tsx scripts/skills-bench/run-bench.ts --task-set ${taskSetRelFromClient} ` +
    `--arms <rebuild from data/bench-manifest.json's "arms" field — treatment '${treatmentArm.name}' ` +
    `@ skillSha256=${treatmentArm.skillSha256 ?? 'n/a'}> ` +
    `--model ${manifest.model} --out <fresh-out-dir>`;

  // A1 interim: `pin` is a new required input to `buildCapabilityReport`
  // (design §2 field contract — capability-report.ts's `ReportFields`), but
  // this CLI does not yet read a real `pin.json` — that `--pin <path>` wiring
  // is a later work item (A5). Until then, synthesize the fields already on
  // hand from this run's own args/manifest; license/repoLicense/skillPath are
  // genuinely unknown at this call site and stay null/empty rather than
  // fabricated until A5 replaces this with the real pin.json read.
  const [pinSource, pinCommit] = (args.skillSource ?? '').split('@');
  const pin: SkillPin = {
    name: args.skill,
    source: pinSource ?? '',
    commit: pinCommit ?? '',
    skillPath: '',
    sha256: treatmentArm.skillSha256 ?? '',
    license: null,
    repoLicense: null,
    fetchedAt: args.measuredOn,
  };

  const report = buildCapabilityReport({
    skill: args.skill,
    outcomes,
    taskSet,
    baselineArm: baselineArm.name,
    treatmentArm: treatmentArm.name,
    pin,
    profile: {
      model: manifest.model,
      agent: args.agent,
      // See capability-report.ts's module doc: reused, not forked, for the
      // task-set path — set sha256 as the "slate" identity, manifest.half
      // (fixed 'feedback' for --task-set runs) as the "slate half". I1:
      // identityKind marks this a task-set identity so renderReceiptMd
      // renders "task set" vocabulary, never "slate", to the reader.
      slateSha256: taskSet.sha256,
      slateHalf: manifest.half,
      identityKind: 'task-set',
      measuredOn: args.measuredOn,
      skillSha256: treatmentArm.skillSha256 ?? undefined,
      skillSource: args.skillSource,
    },
    triggerByKey,
    links: { dataPaths, rerunCommand },
    // Round-2 fix to I8: thread the run-scoped eligible set straight from
    // this run's own manifest — never re-derive it from the task set's
    // authoring-time screening.kept, which doesn't know about THIS run's
    // --include-screened-out flag (see BuildCapabilityReportOptions' doc).
    eligibleTaskIds: manifest.eligibleTaskIds,
  });

  const reportPath = join(args.outDir, 'report.md');
  await writeFile(reportPath, renderCapabilityReportMd(report));
  console.log(`[render-report] wrote ${reportPath}`);

  const badgePath = join(args.outDir, 'badge.svg');
  await writeFile(badgePath, renderBadgeSvg({
    skill: args.skill,
    measuredOn: args.measuredOn,
    netDelta: report.receipt.treatment.passed - report.receipt.baseline.passed,
    // C1: pass the trigger rate through so a low/unknown rate renders the
    // honesty caveat instead of the bare net delta — see BadgeOptions'
    // doc comment (capability-report.ts) for why this must never be
    // dropped on this path.
    triggerRate: report.receipt.triggerRate,
    costOverhead: deriveCostOverhead(report.receipt),
  }));
  console.log(`[render-report] wrote ${badgePath}`);

  const badgeUrl = args.reportUrl.replace(/report\.md$/, 'badge.svg');
  const embedPath = join(args.outDir, 'embed.md');
  await writeFile(embedPath, await buildEmbedSnippet({
    skill: args.skill,
    reportUrl: args.reportUrl,
    badgeUrl,
    measuredOn: args.measuredOn,
    reportFilePath: reportPath,
  }));
  console.log(`[render-report] wrote ${embedPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
