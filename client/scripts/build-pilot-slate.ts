#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  distillationSourceIds,
  selectValidatedCleanTasks,
} from '../src/pilot/task-selection.js';
import {
  ACTIVE_HELD_OUT_SLATE_VERSIONS,
  hashHeldOutSlateArtifact,
  loadActiveHeldOutSlateIds,
  type HeldOutSlateArtifact,
} from '../src/solver-types/_swe-rebench-v2-held-out-slate.js';
import {
  buildHistoricalPool,
  fetchHfSplit,
  listMonthlyPartitions,
} from '../src/solver-types/_swe-rebench-v2-pool.js';
import {
  EVAL_SEMANTICS_VERSION,
  ValidatedPoolStore,
} from '../src/solver-types/_swe-rebench-v2-validated-pool.js';
import { fetchHfWithRetry } from '../src/harnesses/impls/swe-rebench-v2-evaluator/hf-fetcher.js';

const DATASET = 'nebius/SWE-rebench-leaderboard';
const SOLVER_TYPE = 'swe-rebench-v2.v1';
export const VERSION = 'v3';
const SEED = 'jinn.pilot.validated-clean.v3';
const POLICY_VERSION = 'jinn.pilot.validated-clean.v1';

/** Active versions to exclude while building `buildingVersion` (older actives only). */
export function resolveExcludedActiveSlateVersions(
  active: readonly string[],
  buildingVersion: string,
): string[] {
  return active.filter((version) => version !== buildingVersion);
}

interface Args {
  distillationDir: string;
  qualityScreenFile: string;
  stateDir: string;
  outDir: string;
  count: number;
}

function defaultStateDir(): string {
  if (process.env['JINN_SWE_REBENCH_V2_STATE_DIR']) return process.env['JINN_SWE_REBENCH_V2_STATE_DIR'];
  if (process.env['JINN_STATE_DIR']) return join(process.env['JINN_STATE_DIR'], 'swe-rebench-v2');
  return join(homedir(), '.jinn-client', 'swe-rebench-v2');
}

function parseArgs(argv: string[]): Args {
  let distillationDir = '';
  let qualityScreenFile = '';
  let stateDir = defaultStateDir();
  let outDir = resolvePath(process.cwd(), 'src', 'solver-types', 'slates');
  let count = 24;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--distillation-dir') distillationDir = resolvePath(String(argv[++index]));
    else if (arg === '--quality-screen-file') qualityScreenFile = resolvePath(String(argv[++index]));
    else if (arg === '--state-dir') stateDir = resolvePath(String(argv[++index]));
    else if (arg === '--out-dir') outDir = resolvePath(String(argv[++index]));
    else if (arg === '--count') count = Number(argv[++index]);
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!distillationDir) throw new Error('--distillation-dir is required');
  if (!qualityScreenFile) throw new Error('--quality-screen-file is required');
  if (!Number.isInteger(count) || count <= 0) throw new Error('--count must be a positive integer');
  return { distillationDir, qualityScreenFile, stateDir, outDir, count };
}

async function loadProductionPool() {
  const splitsUrl = `https://datasets-server.huggingface.co/splits?dataset=${encodeURIComponent(DATASET)}`;
  const response = await fetchHfWithRetry(splitsUrl, {});
  if (!response.ok) throw new Error(`HF splits fetch failed: ${response.status}`);
  const body = await response.json() as { splits?: Array<{ split: string }> };
  const months = listMonthlyPartitions((body.splits ?? []).map((entry) => entry.split));
  if (months.length === 0) throw new Error('HF returned no monthly SWE-rebench partitions');
  return buildHistoricalPool({
    months,
    fetchSplit: (split) => fetchHfSplit({ dataset: DATASET, split, limit: 100 }),
  });
}

export interface QualityAssessment {
  instance_id: string;
  code: 'A' | 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6';
  reason: string;
}

function parseQualityAssessments(raw: unknown): QualityAssessment[] {
  if (!Array.isArray(raw)) {
    throw new Error('quality screen assessments must be a JSON array');
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`quality screen entry ${index} is invalid`);
    }
    const item = entry as Record<string, unknown>;
    if (
      typeof item['instance_id'] !== 'string'
      || !/^(?:A|B[1-6])$/.test(String(item['code']))
      || typeof item['reason'] !== 'string'
    ) {
      throw new Error(`quality screen entry ${index} has invalid fields`);
    }
    return item as unknown as QualityAssessment;
  });
}

export function loadQualityScreen(path: string): { bytes: string; assessments: QualityAssessment[] } {
  const bytes = readFileSync(path, 'utf8');
  const raw = JSON.parse(bytes) as unknown;
  if (Array.isArray(raw)) {
    return { bytes, assessments: parseQualityAssessments(raw) };
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const assessments = (raw as Record<string, unknown>)['assessments'];
    if (!Array.isArray(assessments)) {
      throw new Error('quality screen object must include an assessments array');
    }
    return { bytes, assessments: parseQualityAssessments(assessments) };
  }
  throw new Error('quality screen must be a JSON array or object with assessments');
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const selectionPath = join(args.distillationDir, 'selection.json');
  const manifestPath = join(args.distillationDir, 'manifest.json');
  const selectionBytes = readFileSync(selectionPath, 'utf8');
  const selection = JSON.parse(selectionBytes) as unknown;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const sourceIds = distillationSourceIds(selection);
  const qualityScreen = loadQualityScreen(args.qualityScreenFile);

  const store = new ValidatedPoolStore({ stateDir: args.stateDir });
  const validations = await store.getScorableEntries(EVAL_SEMANTICS_VERSION);
  if (!validations) {
    throw new Error(`validated pool is missing or incompatible with eval semantics ${EVAL_SEMANTICS_VERSION}`);
  }
  const pool = await loadProductionPool();
  const qualityById = new Map(qualityScreen.assessments.map((assessment) => [assessment.instance_id, assessment]));
  const qualityEnrichedPool = pool.map((task) => qualityById.has(task.instance_id)
    ? {
        ...task,
        meta: {
          llm_metadata: {
            code: qualityById.get(task.instance_id)!.code,
            detected_issues: Object.fromEntries(
              ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'].map((code) => [
                code,
                qualityById.get(task.instance_id)!.code === code,
              ])),
          },
        } as typeof task.meta,
      }
    : task);
  const excludedVersions = resolveExcludedActiveSlateVersions(
    ACTIVE_HELD_OUT_SLATE_VERSIONS,
    VERSION,
  );
  const olderSlateIds = loadActiveHeldOutSlateIds(SOLVER_TYPE, excludedVersions);
  const excludedIds = new Set([...sourceIds, ...olderSlateIds]);
  const selected = selectValidatedCleanTasks({
    pool: qualityEnrichedPool,
    scorableEntries: validations.entries,
    excludedIds,
    count: args.count,
    seed: SEED,
  });

  const generatedAt = typeof manifest['generatedAt'] === 'string'
    ? manifest['generatedAt']
    : validations.updatedAt;
  const artifact: HeldOutSlateArtifact = {
    schemaVersion: 'held-out-slate.v1',
    solverType: SOLVER_TYPE,
    version: VERSION,
    generatedAt,
    instanceIds: selected.map((entry) => entry.instance_id),
  };
  const slate = {
    comment: 'VALIDATED CLEAN PAIRED-SKILL EVAL (2026-07-10). Deterministically selected from current-semantics scorable, metadata-clean SWE-rebench tasks after excluding all active older slates and paired-distillation source instances. Scores are comparable within v3 only.',
    ...artifact,
    hash: hashHeldOutSlateArtifact(artifact),
  };
  const report = {
    schema: 'jinn.pilot.slate-screening.v1',
    generatedAt,
    solverType: SOLVER_TYPE,
    slateVersion: VERSION,
    dataset: DATASET,
    evalSemanticsVersion: EVAL_SEMANTICS_VERSION,
    policyVersion: POLICY_VERSION,
    seed: SEED,
    count: selected.length,
    validatedPoolUpdatedAt: validations.updatedAt,
    distillation: {
      manifestGeneratedAt: manifest['generatedAt'],
      selectionSha256: sha256(selectionBytes),
      sourceInstanceIds: [...sourceIds].sort(),
    },
    qualityScreen: {
      model: 'claude-haiku-4-5-20251001',
      policy: 'smallest-input-36 validated non-source non-active-slate candidates; A/B1-B6 alignment review',
      sha256: sha256(qualityScreen.bytes),
      assessed: qualityScreen.assessments.length,
      accepted: qualityScreen.assessments.filter((assessment) => assessment.code === 'A').length,
      assessments: qualityScreen.assessments,
    },
    excludedActiveSlateVersions: excludedVersions,
    selected,
  };

  mkdirSync(args.outDir, { recursive: true });
  const base = `held-out-slate.swe-rebench-v2.${VERSION}`;
  writeFileSync(join(args.outDir, `${base}.json`), `${JSON.stringify(slate, null, 2)}\n`);
  writeFileSync(join(args.outDir, `${base}.screening-report.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(args.outDir, `${base}.quality-screen.json`), `${JSON.stringify({
    schema: 'jinn.pilot.quality-screen.v1',
    model: 'claude-haiku-4-5-20251001',
    assessments: qualityScreen.assessments,
  }, null, 2)}\n`);
  console.log(`wrote ${selected.length} validated clean tasks to ${join(args.outDir, `${base}.json`)}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
