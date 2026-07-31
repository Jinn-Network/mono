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
  buildCapabilityReport, buildEmbedSnippet, deriveVerdictLine, renderBadgeSvg, renderCapabilityReportMd,
} from '../../src/skills-bench/capability-report.js';
import { detectSkillTrigger } from '../../src/skills-bench/trigger.js';
import { attemptKey } from '../../src/skills-bench/attempts.js';
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
  const rerunCommand =
    `yarn tsx scripts/skills-bench/run-bench.ts --task-set ${taskSetRelFromClient} ` +
    `--arms <arms.json mounting '${treatmentArm.name}' @ skillSha256=${treatmentArm.skillSha256 ?? 'n/a'}> ` +
    `--model ${manifest.model} --out <fresh-out-dir>`;

  const report = buildCapabilityReport({
    skill: args.skill,
    outcomes,
    taskSet,
    baselineArm: baselineArm.name,
    treatmentArm: treatmentArm.name,
    profile: {
      model: manifest.model,
      agent: args.agent,
      // See capability-report.ts's module doc: reused, not forked, for the
      // task-set path — set sha256 as the "slate" identity, manifest.half
      // (fixed 'feedback' for --task-set runs) as the "slate half".
      slateSha256: taskSet.sha256,
      slateHalf: manifest.half,
      measuredOn: args.measuredOn,
      skillSha256: treatmentArm.skillSha256 ?? undefined,
      skillSource: args.skillSource,
    },
    triggerByKey,
    links: { dataPaths, rerunCommand },
  });

  const reportPath = join(args.outDir, 'report.md');
  await writeFile(reportPath, renderCapabilityReportMd(report));
  console.log(`[render-report] wrote ${reportPath}`);

  const badgePath = join(args.outDir, 'badge.svg');
  await writeFile(badgePath, renderBadgeSvg({
    skill: args.skill,
    verdictLine: deriveVerdictLine(report.receipt),
    measuredOn: args.measuredOn,
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
