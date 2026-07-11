import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { HfRow } from '../harnesses/impls/swe-rebench-v2-evaluator/index.js';
import type { PilotInstance } from './instance.js';
import type { SolveTokens } from './solve.js';
import type { PilotReport, SolveOutcome } from './tally.js';

export interface PilotInstanceRef {
  instance_id: string;
  hf_dataset: string;
  hf_split: string;
}

export interface PilotArmConfig {
  name: string;
  skills: string[];
  jinnAgentHome?: string;
}

export interface PilotSemanticArmConfig {
  name: string;
  skills: string[];
}

export interface PilotSemanticConfig {
  instances: PilotInstanceRef[];
  repeats: number;
  arms: PilotSemanticArmConfig[];
  maxTurns: number;
  gradeTimeoutMs: number;
  /** Dry-run and real records must never share a durable store: dry-run
   *  writes synthetic `graded` records that would silently pollute a real
   *  report. Absent (legacy manifests) normalizes to 'real', so a dry run
   *  against a pre-mode store fails closed. */
  mode?: 'dry-run' | 'real';
  /** Whether every arm's solve prompt carries the neutral "check your
   *  available skills" line. Semantic: it changes solve behavior, so nudged
   *  and un-nudged attempts must not share a store. Absent (legacy
   *  manifests) normalizes to false. */
  skillsNudge?: boolean;
  provider?: string;
  model?: string;
  taskSource?: string;
  slateHash?: string;
}

interface LegacyPilotSemanticConfig extends Omit<PilotSemanticConfig, 'arms'> {
  arms?: PilotSemanticArmConfig[];
  skills?: string[];
  armBJinnAgentHome?: string;
}

export interface PilotManifest {
  schema: 'jinn.pilot.manifest.v1';
  generatedAt: string;
  semanticConfig: PilotSemanticConfig;
  attemptCount: number;
}

export interface FrozenPilotInstance {
  ref: PilotInstanceRef;
  instance: PilotInstance;
  hfRow: HfRow;
}

export interface PilotInstancesFile {
  schema: 'jinn.pilot.instances.v1';
  instances: FrozenPilotInstance[];
}

export interface PilotAttemptSpec {
  instance_id: string;
  arm: string;
  repeat: number;
}

export type PilotAttemptStatus = 'graded' | 'ungradeable' | 'solve-error' | 'grade-error';

export interface PilotAttemptRecord extends PilotAttemptSpec {
  schema: 'jinn.pilot.attempt.v1';
  status: PilotAttemptStatus;
  passed: boolean | null;
  costUsd: number;
  tokens?: SolveTokens;
  sessionId?: string;
  patchRelPath?: string;
  error?: string;
  tokenError?: string;
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

export function attemptKey(spec: PilotAttemptSpec): string {
  return `${spec.instance_id}:${spec.arm}:${spec.repeat}`;
}

export function attemptRecordFileName(spec: PilotAttemptSpec): string {
  return `${Buffer.from(attemptKey(spec), 'utf8').toString('base64url')}.json`;
}

function attemptPatchFileName(spec: PilotAttemptSpec): string {
  return `${basename(attemptRecordFileName(spec), '.json')}.patch`;
}

export function buildAttemptSpecs(config: PilotSemanticConfig): PilotAttemptSpec[] {
  const normalized = normalizePilotSemanticConfig(config);
  const specs: PilotAttemptSpec[] = [];
  for (const ref of normalized.instances) {
    for (const arm of normalized.arms) {
      for (let repeat = 0; repeat < normalized.repeats; repeat++) {
        specs.push({ instance_id: ref.instance_id, arm: arm.name, repeat });
      }
    }
  }
  return specs;
}

export function normalizePilotSemanticConfig(config: PilotSemanticConfig | LegacyPilotSemanticConfig): PilotSemanticConfig {
  const raw = config as LegacyPilotSemanticConfig;
  const arms = Array.isArray(raw.arms)
    ? raw.arms.map((arm) => ({ name: arm.name, skills: arm.skills }))
    : [
        { name: 'A', skills: [] },
        { name: 'B', skills: Array.isArray(raw.skills) ? raw.skills : [] },
      ];
  return {
    instances: raw.instances,
    repeats: raw.repeats,
    arms,
    maxTurns: raw.maxTurns,
    gradeTimeoutMs: raw.gradeTimeoutMs,
    mode: raw.mode ?? 'real',
    skillsNudge: raw.skillsNudge ?? false,
    ...(raw.provider ? { provider: raw.provider } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    ...(raw.taskSource ? { taskSource: raw.taskSource } : {}),
    ...(raw.slateHash ? { slateHash: raw.slateHash } : {}),
  };
}

export function buildPilotManifest(
  config: PilotSemanticConfig,
  opts: { generatedAt?: string } = {},
): PilotManifest {
  const normalized = normalizePilotSemanticConfig(config);
  return {
    schema: 'jinn.pilot.manifest.v1',
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    semanticConfig: normalized,
    attemptCount: buildAttemptSpecs(normalized).length,
  };
}

function comparableSemanticValue(config: PilotSemanticConfig, key: keyof PilotSemanticConfig): unknown {
  if (key === 'arms') {
    return config.arms.map((arm) => ({ name: arm.name, skills: arm.skills }));
  }
  return config[key];
}

export function instanceRefKey(ref: PilotInstanceRef): string {
  return `${ref.instance_id}|${ref.hf_dataset}|${ref.hf_split}`;
}

export function assertCompatiblePilotManifest(manifest: PilotManifest, requested: PilotSemanticConfig): void {
  const frozen = normalizePilotSemanticConfig(manifest.semanticConfig);
  const normalizedRequested = normalizePilotSemanticConfig(requested);
  // Slates are append-only: a requested instance SUPERSET is compatible (the
  // run extends the store; existing per-attempt records stay valid), while
  // dropping or mutating a frozen instance is a semantic change.
  const requestedRefKeys = new Set(normalizedRequested.instances.map(instanceRefKey));
  const missing = frozen.instances.filter((ref) => !requestedRefKeys.has(instanceRefKey(ref)));
  if (missing.length > 0) {
    throw new Error(
      `different frozen pilot config for instances: requested set is missing ${missing.length} frozen instance(s) ` +
      `(e.g. ${missing[0]!.instance_id}); instances may only be added, not removed or changed — pass --force to rebuild`,
    );
  }
  const keys = ['repeats', 'arms', 'maxTurns', 'gradeTimeoutMs', 'mode', 'skillsNudge', 'provider', 'model', 'taskSource', 'slateHash'] as const;
  for (const key of keys) {
    const frozenValue = comparableSemanticValue(frozen, key);
    const requestedValue = comparableSemanticValue(normalizedRequested, key);
    if ((key === 'taskSource' || key === 'slateHash') && frozenValue === undefined) continue;
    if (stableJson(frozenValue) !== stableJson(requestedValue)) {
      throw new Error(
        `different frozen pilot config for ${key}: existing --out was created with ` +
        `${stableJson(frozenValue)}, requested ${stableJson(requestedValue)}; pass --force to rebuild`,
      );
    }
  }
}

export function writePilotManifest(outDir: string, manifest: PilotManifest): void {
  writeJsonAtomic(join(outDir, 'manifest.json'), manifest);
}

export function loadPilotManifest(outDir: string): PilotManifest | null {
  const path = join(outDir, 'manifest.json');
  if (!existsSync(path)) return null;
  const manifest = readJson(path) as PilotManifest;
  return {
    ...manifest,
    semanticConfig: normalizePilotSemanticConfig(manifest.semanticConfig),
  };
}

export function writeFrozenInstances(outDir: string, instances: FrozenPilotInstance[]): void {
  writeJsonAtomic(join(outDir, 'instances.json'), {
    schema: 'jinn.pilot.instances.v1',
    instances,
  } satisfies PilotInstancesFile);
}

export function loadFrozenInstances(outDir: string): FrozenPilotInstance[] | null {
  const path = join(outDir, 'instances.json');
  if (!existsSync(path)) return null;
  return (readJson(path) as PilotInstancesFile).instances;
}

export function clearPilotOutput(outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
}

export function writePatch(outDir: string, spec: PilotAttemptSpec, patch: string): string {
  const relPath = join('patches', attemptPatchFileName(spec));
  const absPath = join(outDir, relPath);
  mkdirSync(join(absPath, '..'), { recursive: true });
  writeFileSync(absPath, patch);
  return relPath;
}

export function writeAttemptRecord(outDir: string, record: PilotAttemptRecord): void {
  writeJsonAtomic(join(outDir, 'attempts', attemptRecordFileName(record)), record);
}

export function loadAttemptRecords(outDir: string): Map<string, PilotAttemptRecord> {
  const dir = join(outDir, 'attempts');
  const records = new Map<string, PilotAttemptRecord>();
  if (!existsSync(dir)) return records;
  for (const entry of readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const record = readJson(join(dir, entry.name)) as PilotAttemptRecord;
    records.set(attemptKey(record), record);
  }
  return records;
}

function isRetryableError(record: PilotAttemptRecord): boolean {
  if (record.status === 'solve-error' || record.status === 'grade-error') return true;
  // An infra-ungradeable (eval_timeout, docker outage, …) whose solve is
  // banked as a saved patch retries as a $0 regrade — the inference is
  // already paid for. An ungradeable without a patch never auto-respends.
  return record.status === 'ungradeable' && Boolean(record.patchRelPath);
}

export function selectRunnableAttempts(
  specs: PilotAttemptSpec[],
  records: Map<string, PilotAttemptRecord>,
  opts: { retryErrors: boolean; maxNewSolves: number },
): PilotAttemptSpec[] {
  const selected: PilotAttemptSpec[] = [];
  if (opts.maxNewSolves <= 0) return selected;
  for (const spec of specs) {
    const existing = records.get(attemptKey(spec));
    if (existing && !(opts.retryErrors && isRetryableError(existing))) continue;
    selected.push(spec);
    if (Number.isFinite(opts.maxNewSolves) && selected.length >= opts.maxNewSolves) break;
  }
  return selected;
}

export function recordsToOutcomes(records: Iterable<PilotAttemptRecord>): SolveOutcome[] {
  return Array.from(records, (record) => ({
    instance_id: record.instance_id,
    arm: record.arm,
    repeat: record.repeat,
    passed: record.passed,
    costUsd: record.costUsd,
  }));
}

export function orderedRecordsForSpecs(
  specs: PilotAttemptSpec[],
  records: Map<string, PilotAttemptRecord>,
): PilotAttemptRecord[] {
  return specs.map((spec) => records.get(attemptKey(spec))).filter((record): record is PilotAttemptRecord => Boolean(record));
}

export function writePilotReport(outDir: string, report: PilotReport, outcomes: SolveOutcome[]): void {
  writeJsonAtomic(join(outDir, 'report.json'), {
    schema: 'jinn.pilot.report.v1',
    generatedAt: new Date().toISOString(),
    report,
    outcomes,
  });
}
