/**
 * Renders the public capability-report artifact (design §1/§5 of
 * docs/superpowers/specs/2026-07-31-capability-report-artifact-design.md) for
 * a completed `--task-set` skills-bench run: `report.md`, `card.svg`,
 * `badge.svg`, an optional `rank-badge.svg`, `embed.md`, and a `data/`
 * directory carrying the raw run data a reader needs to check the report's
 * math (never the full transcripts, unless explicitly opted in — session
 * files can embed the task repo's own content).
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
 * Identity (design §1): every artifact is pinned to `<skill>@<sha>`, where
 * `sha` is the short (8-char) form of `pin.json`'s resolved `commit` — NOT
 * the vendored-bytes `sha256`. `--pin` is required so this identity, and the
 * license/repoLicense/skillSource fields the report and card read from it,
 * are read from the real pinned record rather than synthesized. `--pin`'s
 * `name` must equal `--skill` — a mismatched pin puts the wrong identity on
 * every rendered artifact.
 *
 * `--base-url` MUST be a raw-content base, never a GitHub "blob" URL (D1 I6):
 * `https://github.com/<org>/<repo>/blob/<ref>` serves an HTML page for every
 * path under it, not the image bytes, so a badge/card embedded through it is
 * broken in every reader. Use `https://raw.githubusercontent.com/<org>/<repo>/<ref>`
 * (or a GitHub Pages URL) instead — `main` rejects a `/blob/` base outright,
 * naming the fix, since this is the one string an author is most likely to
 * copy from a browser address bar.
 *
 * Usage:
 *   yarn tsx scripts/skills-bench/render-report.ts \
 *     --run ../bench/runs/tdd-pilot --task-set ../bench/task-sets/tdd \
 *     --skill tdd --pin ../bench/skills-under-test/tdd/pin.json \
 *     --base-url https://raw.githubusercontent.com/Jinn-Network/skills-eval/main \
 *     [--out ../bench/runs/tdd-pilot/report] [--measured-on 2026-08-01] \
 *     [--agent claude-code] [--skill-source mattpocock/skills@abc123] \
 *     [--include-transcripts] [--cohort ../bench/cohorts/python-testing.json] \
 *     [--narrative ../bench/runs/tdd-pilot/narrative.json]
 */
import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAttempts, type BenchManifest } from '../../src/skills-bench/attempts.js';
import { renderCapabilityCardSvg } from '../../src/skills-bench/capability-card.js';
import {
  assertRankBadgeAccompanied, buildCapabilityReport, buildEmbedSnippet, deriveCostOverhead, renderBadgeSvg,
  renderCapabilityReportMd, renderCohortRankBadgeSvg, renderPerTaskTableMd, validateCohort,
  type Cohort, type ReportNarrative,
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
  pinPath: string;
  baseUrl: string;
  outDir: string;
  measuredOn: string;
  agent: string;
  skillSource: string | undefined;
  includeTranscripts: boolean;
  cohortPath: string | undefined;
  narrativePath: string | undefined;
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
      case '--pin': args.pinPath = resolve(String(argv[++i])); break;
      case '--base-url': args.baseUrl = String(argv[++i]); break;
      case '--out': args.outDir = resolve(String(argv[++i])); break;
      case '--measured-on': args.measuredOn = String(argv[++i]); break;
      case '--agent': args.agent = String(argv[++i]); break;
      case '--skill-source': args.skillSource = String(argv[++i]); break;
      case '--include-transcripts': args.includeTranscripts = true; break;
      case '--cohort': args.cohortPath = resolve(String(argv[++i])); break;
      case '--narrative': args.narrativePath = resolve(String(argv[++i])); break;
      default: throw new Error(`unknown argument ${a}`);
    }
  }
  if (!args.runDir) throw new Error('--run is required');
  if (!args.taskSetDir) throw new Error('--task-set is required');
  if (!args.skill) throw new Error('--skill is required');
  if (!args.pinPath) throw new Error('--pin is required');
  if (!args.baseUrl) throw new Error('--base-url is required');
  if (!args.outDir) args.outDir = join(args.runDir, 'report');
  if (!args.measuredOn) args.measuredOn = today();
  return args as Args;
}

async function loadJson<T>(path: string, label: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${label} ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

async function loadManifest(runDir: string): Promise<BenchManifest> {
  return loadJson<BenchManifest>(join(runDir, 'bench-manifest.json'), 'bench-manifest.json');
}

/** D1 I4: validates every `SkillPin` field before casting, not just `name`/
 *  `commit` — the earlier version cast straight through after checking two of
 *  eight fields, so a pin.json predating a field (e.g. `repoLicense`, added
 *  after `bench/skills-under-test/tdd/pin.json` was written) silently carried
 *  `undefined` where the type declares `string | null`. Exported for direct
 *  unit testing (no filesystem needed). */
export function parsePinShape(raw: Partial<SkillPin>, path: string): SkillPin {
  for (const key of ['name', 'source', 'commit', 'skillPath', 'sha256', 'fetchedAt'] as const) {
    if (typeof raw[key] !== 'string' || !raw[key]) {
      throw new Error(`--pin ${path} is missing "${key}" — not a valid pin.json`);
    }
  }
  for (const key of ['license', 'repoLicense'] as const) {
    if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== 'string') {
      throw new Error(`--pin ${path} "${key}" must be a string or null`);
    }
  }
  return {
    name: raw.name!,
    source: raw.source!,
    commit: raw.commit!,
    skillPath: raw.skillPath!,
    sha256: raw.sha256!,
    fetchedAt: raw.fetchedAt!,
    // Normalize an absent optional to `null` explicitly (design contract:
    // `string | null`, never `undefined`) rather than leaking whatever the
    // source JSON happened to omit.
    license: raw.license ?? null,
    repoLicense: raw.repoLicense ?? null,
  };
}

/** Reads and validates `--pin`'s pin.json, then enforces the identity
 *  invariant (design §1): a pin naming a different skill than `--skill`
 *  would put the wrong identity on every artifact this CLI writes. */
async function loadPin(path: string, skill: string): Promise<SkillPin> {
  const raw = await loadJson<Partial<SkillPin>>(path, 'pin.json');
  const pin = parsePinShape(raw, path);
  if (pin.name !== skill) {
    throw new Error(
      `--pin ${path} names skill '${pin.name}', which does not match --skill '${skill}' — a mismatched pin ` +
      'puts the wrong identity on every rendered artifact. Pass the pin.json for the skill actually under test.',
    );
  }
  return pin;
}

/** D1 I6: refuses a GitHub "blob" `--base-url` outright — `blob` URLs serve
 *  an HTML page, not the image bytes, so every badge/card embed built from
 *  one is broken in every reader, and this is the one string an author is
 *  most likely to copy straight from a browser address bar. Exported for
 *  direct unit testing. */
export function validateBaseUrl(baseUrl: string): void {
  if (/^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\//i.test(baseUrl)) {
    throw new Error(
      `--base-url ${baseUrl} is a GitHub "blob" URL — GitHub serves blob URLs as an HTML page, not the raw ` +
      'bytes, so every badge/card image embedded through it would be broken. Use a raw-content base instead: ' +
      'https://raw.githubusercontent.com/<org>/<repo>/<ref> (or a GitHub Pages URL).',
    );
  }
}

/** Fail-loud shape check ahead of `validateCohort` (capability-report.ts),
 *  which assumes the `Cohort` shape already holds — a `--cohort` file that
 *  isn't even shaped like one (e.g. missing "entries") should not surface as
 *  an opaque "Cannot read properties of undefined". */
async function loadCohort(path: string): Promise<Cohort> {
  const parsed = await loadJson<Partial<Cohort>>(path, '--cohort');
  if (typeof parsed.domain !== 'string' || !Array.isArray(parsed.entries)) {
    throw new Error(
      `--cohort ${path} does not match the Cohort shape ({ domain: string; entries: CohortEntry[] })`,
    );
  }
  const cohort = parsed as Cohort;
  validateCohort(cohort);
  return cohort;
}

/** Fail-loud shape check for `--narrative` (design §6 sections 6-7's
 *  human-authored annex content): `{ pattern?: { text, evidence? },
 *  changes?: string[] }`. Absent file → absent narrative; a present but
 *  malformed file is refused rather than silently dropped. */
async function loadNarrative(path: string): Promise<ReportNarrative> {
  const parsed = await loadJson<Partial<ReportNarrative>>(path, '--narrative');
  if (parsed.pattern !== undefined) {
    const pattern = parsed.pattern as Partial<ReportNarrative['pattern']> | undefined;
    if (!pattern || typeof pattern.text !== 'string' || !pattern.text) {
      throw new Error(`--narrative ${path} "pattern" must be { text: string; evidence?: string }`);
    }
    if (pattern.evidence !== undefined && typeof pattern.evidence !== 'string') {
      throw new Error(`--narrative ${path} "pattern.evidence" must be a string`);
    }
  }
  if (parsed.changes !== undefined) {
    if (!Array.isArray(parsed.changes) || parsed.changes.some((c) => typeof c !== 'string')) {
      throw new Error(`--narrative ${path} "changes" must be a string array`);
    }
  }
  return parsed as ReportNarrative;
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
  validateBaseUrl(args.baseUrl);

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

  const pin = await loadPin(args.pinPath, args.skill);
  const cohort = args.cohortPath ? await loadCohort(args.cohortPath) : undefined;
  const narrative = args.narrativePath ? await loadNarrative(args.narrativePath) : undefined;

  const outcomes = await loadAttempts(join(args.runDir, 'attempts.jsonl'));
  const triggerByKey = await computeTriggerByKey(args.runDir, outcomes, treatmentArm.name);

  await mkdir(join(args.outDir, 'data'), { recursive: true });
  await copyFile(join(args.runDir, 'attempts.jsonl'), join(args.outDir, 'data', 'attempts.jsonl'));
  await copyFile(join(args.runDir, 'bench-manifest.json'), join(args.outDir, 'data', 'bench-manifest.json'));
  await copyFile(join(args.taskSetDir, 'set.json'), join(args.outDir, 'data', 'set.json'));
  // D1 I9: `data/per-task.md` is NOT listed here — `renderReproduce`
  // (capability-report.ts) already gives it its own "Per-task outcomes:"
  // line; including it again in `dataPaths` doubled it into "Raw data:" too.
  const dataPaths = ['data/attempts.jsonl', 'data/bench-manifest.json', 'data/set.json'];
  if (args.includeTranscripts) {
    await cp(join(args.runDir, 'transcripts'), join(args.outDir, 'data', 'transcripts'), { recursive: true });
    dataPaths.push('data/transcripts/');
  }

  // D1 I9: a `--task-set` outside the client tree (e.g. an e2e run against
  // /tmp) produces a `relative()` path several `../` deep — technically
  // correct but not a command a reader can usefully copy. Fall back to the
  // absolute path whenever the relative form would climb out of the repo.
  const taskSetRelFromClient = relative(clientDir, args.taskSetDir);
  const taskSetPathForCommand = taskSetRelFromClient.startsWith('..') ? args.taskSetDir : taskSetRelFromClient;
  // I4/nit: point at data/bench-manifest.json for arm reconstruction instead
  // of a bracketed arms-file placeholder with no source — the manifest's own
  // "arms" field (name + skillSha256 per arm) is the actual source of truth
  // for rebuilding the --arms JSON this run used.
  const rerunCommand =
    `yarn tsx scripts/skills-bench/run-bench.ts --task-set ${taskSetPathForCommand} ` +
    `--arms <rebuild from data/bench-manifest.json's "arms" field — treatment '${treatmentArm.name}' ` +
    `@ skillSha256=${treatmentArm.skillSha256 ?? 'n/a'}> ` +
    `--model ${manifest.model} --out <fresh-out-dir>`;

  // Identity (design §1): `<skill>@<sha>`, sha = short form of pin.commit
  // (the resolved upstream commit) — NOT `pin.sha256` (the vendored-bytes
  // hash, a different identity; see capability-report.ts's
  // `shortShaFromSource`/`ReportPresentation.shortSha` doc comments for the
  // same distinction on the card/report face). This derivation stays
  // necessary here (unlike the card/report) because it feeds `links.reportUrl`
  // etc., which must exist BEFORE `buildCapabilityReport` — and therefore
  // before `report.presentation.shortSha` — can be computed.
  const shortSha = pin.commit.slice(0, 8);
  const baseUrl = args.baseUrl.replace(/\/+$/, '');
  const artifactRoot = `${baseUrl}/reports/${args.skill}@${shortSha}`;
  const reportUrl = `${artifactRoot}/report.md`;
  const badgeUrl = `${artifactRoot}/badge.svg`;
  const cardUrl = `${artifactRoot}/card.svg`;
  const rankBadgeUrl = `${artifactRoot}/rank-badge.svg`;

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
    links: { dataPaths, rerunCommand, reportUrl },
    // Round-2 fix to I8: thread the run-scoped eligible set straight from
    // this run's own manifest — never re-derive it from the task set's
    // authoring-time screening.kept, which doesn't know about THIS run's
    // --include-screened-out flag (see BuildCapabilityReportOptions' doc).
    eligibleTaskIds: manifest.eligibleTaskIds,
    ...(cohort ? { cohort } : {}),
    ...(narrative ? { narrative } : {}),
  });

  const reportPath = join(args.outDir, 'report.md');
  await writeFile(reportPath, renderCapabilityReportMd(report));
  console.log(`[render-report] wrote ${reportPath}`);

  const cardPath = join(args.outDir, 'card.svg');
  await writeFile(cardPath, renderCapabilityCardSvg(report));
  console.log(`[render-report] wrote ${cardPath}`);

  const badgePath = join(args.outDir, 'badge.svg');
  await writeFile(badgePath, renderBadgeSvg({
    skill: args.skill,
    measuredOn: args.measuredOn,
    // D1 (d): read the once-computed presentation value rather than
    // re-deriving `treatment.passed - baseline.passed` at this call site —
    // one of six places the delta used to be independently recomputed.
    netDelta: report.presentation.netDelta,
    // C1: pass the trigger rate through so a low/unknown rate renders the
    // honesty caveat instead of the bare net delta — see BadgeOptions'
    // doc comment (capability-report.ts) for why this must never be
    // dropped on this path.
    triggerRate: report.receipt.triggerRate,
    costOverhead: deriveCostOverhead(report.receipt),
  }));
  console.log(`[render-report] wrote ${badgePath}`);

  // Design §3: the rank badge may never be emitted without the three-axis
  // badge alongside it — badge.svg above is always written on this path, so
  // this call is always satisfied, but the assertion is the enforced
  // invariant rather than relying on that ordering as an unstated convention.
  if (report.cohort) {
    assertRankBadgeAccompanied(true);
    const rankBadgePath = join(args.outDir, 'rank-badge.svg');
    await writeFile(rankBadgePath, renderCohortRankBadgeSvg(report.cohort, args.skill));
    console.log(`[render-report] wrote ${rankBadgePath}`);
  }

  const perTaskPath = join(args.outDir, 'data', 'per-task.md');
  await writeFile(perTaskPath, renderPerTaskTableMd(report));
  console.log(`[render-report] wrote ${perTaskPath}`);

  const embedPath = join(args.outDir, 'embed.md');
  await writeFile(embedPath, await buildEmbedSnippet({
    skill: args.skill,
    reportUrl,
    badgeUrl,
    cardUrl,
    measuredOn: args.measuredOn,
    reportFilePath: reportPath,
  }));
  console.log(`[render-report] wrote ${embedPath}`);

  if (report.cohort) {
    console.log(`[render-report] rank badge public URL: ${rankBadgeUrl}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
