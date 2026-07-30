/**
 * Renders paired-stats receipts from a completed skills-bench run: one
 * `receipts/<arm>.md` per non-baseline arm (buildReceipt + renderReceiptMd),
 * plus `receipts/SUMMARY.md` — a table derived from the same ReceiptData,
 * never free text.
 *
 * Baseline arm is whichever manifest arm has `skillSha256: null` (the
 * run-bench convention — see scripts/skills-bench/run-bench.ts). Every
 * other arm in the manifest is a treatment arm.
 *
 * Usage:
 *   yarn tsx scripts/skills-bench/render-receipts.ts \
 *     --run ../bench/runs/wave1 --slate ../bench/slate/slate.json \
 *     --half both --measured-on 2026-08-01 --out ../bench/runs/wave1/receipts \
 *     [--agent claude-code]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadAttempts, type BenchManifest, type BenchOutcome } from '../../src/skills-bench/attempts.js';
import { buildReceipt, renderReceiptMd, type ReceiptData } from '../../src/skills-bench/receipt.js';
import type { SkillsBenchSlate } from '../../src/skills-bench/slate.js';

interface Args {
  runDir: string;
  slatePath: string;
  half: 'feedback' | 'holdout' | 'both';
  measuredOn: string;
  outDir: string;
  agent: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { agent: 'claude-code' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--run': args.runDir = resolve(String(argv[++i])); break;
      case '--slate': args.slatePath = resolve(String(argv[++i])); break;
      case '--half': {
        const v = String(argv[++i]);
        if (v !== 'feedback' && v !== 'holdout' && v !== 'both') throw new Error(`invalid --half ${v}`);
        args.half = v;
        break;
      }
      case '--measured-on': args.measuredOn = String(argv[++i]); break;
      case '--out': args.outDir = resolve(String(argv[++i])); break;
      case '--agent': args.agent = String(argv[++i]); break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!args.runDir) throw new Error('--run is required');
  if (!args.slatePath) throw new Error('--slate is required');
  if (!args.half) throw new Error('--half is required');
  if (!args.measuredOn) throw new Error('--measured-on is required');
  if (!args.outDir) throw new Error('--out is required');
  return args as Args;
}

async function loadManifest(runDir: string): Promise<BenchManifest> {
  const raw = await readFile(join(runDir, 'bench-manifest.json'), 'utf8');
  return JSON.parse(raw) as BenchManifest;
}

async function loadSlate(slatePath: string): Promise<SkillsBenchSlate> {
  const raw = await readFile(slatePath, 'utf8');
  return JSON.parse(raw) as SkillsBenchSlate;
}

function summaryRow(arm: string, data: ReceiptData): string {
  const baseline = `${data.baseline.passed}/${data.baseline.scorable}`;
  const treatment = `${data.treatment.passed}/${data.treatment.scorable}`;
  const delta = data.treatment.passed - data.baseline.passed;
  const net = `${delta >= 0 ? '+' : ''}${delta}`;
  return `| ${arm} | ${baseline} | ${treatment} | ${net} |`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const manifest = await loadManifest(args.runDir);
  const slate = await loadSlate(args.slatePath);
  if (slate.sha256 !== manifest.slateSha256) {
    throw new Error(
      `slate mismatch: ${args.slatePath} sha256=${slate.sha256} does not match ` +
      `bench-manifest.json slateSha256=${manifest.slateSha256}`,
    );
  }

  const outcomes: BenchOutcome[] = await loadAttempts(join(args.runDir, 'attempts.jsonl'));

  const baselineArm = manifest.arms.find((arm) => arm.skillSha256 === null);
  if (!baselineArm) throw new Error('bench-manifest.json has no baseline arm (skillSha256: null)');
  const treatmentArms = manifest.arms.filter((arm) => arm.name !== baselineArm.name);
  if (treatmentArms.length === 0) throw new Error('bench-manifest.json has no non-baseline arms to render');

  await mkdir(args.outDir, { recursive: true });

  const rows: string[] = [];
  for (const arm of treatmentArms) {
    const data = buildReceipt(outcomes, {
      baselineArm: baselineArm.name,
      treatmentArm: arm.name,
      profile: {
        model: manifest.model,
        agent: args.agent,
        slateSha256: manifest.slateSha256,
        slateHalf: args.half,
        measuredOn: args.measuredOn,
      },
    });
    await writeFile(join(args.outDir, `${arm.name}.md`), renderReceiptMd(data));
    rows.push(summaryRow(arm.name, data));
    console.log(`[render-receipts] wrote ${join(args.outDir, `${arm.name}.md`)}`);
  }

  const summary = [
    '| skill | baseline | with skill | net |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
  await writeFile(join(args.outDir, 'SUMMARY.md'), summary);
  console.log(`[render-receipts] wrote ${join(args.outDir, 'SUMMARY.md')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
