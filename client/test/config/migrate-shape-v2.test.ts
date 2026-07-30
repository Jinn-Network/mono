import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateConfigShapeV2 } from '../../src/config/migrate-shape-v2.js';

function workspace(config: Record<string, unknown>): { configPath: string; launchedDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-migrate-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const launchedDir = join(dir, 'solvernets', 'launched');
  mkdirSync(launchedDir, { recursive: true });
  return { configPath, launchedDir };
}

const JOINED = {
  joinedSolverNets: {
    QmSolver: {
      manifestCid: 'QmSolver',
      name: 'prediction',
      roles: ['solver', 'evaluator'],
      harness: 'claude-code',
      model: 'claude-haiku-4-5-20251001',
      plugins: ['learner'],
      disabledDefaultPlugins: [],
    },
    QmEvalOnly: {
      manifestCid: 'QmEvalOnly',
      roles: ['evaluator'],
      plugins: [],
      disabledDefaultPlugins: [],
    },
  },
  spendCap: { capUsd: 12 },
  aiUnits: { capPerBlockUsdMicros: 30_000_000 },
};

describe('config shape v2 migration', () => {
  it('writes one wiring entry per solver-role join and keeps joinedSolverNets', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    const report = migrateConfigShapeV2({ configPath, launchedRecordsDir: launchedDir });
    expect(report.migrated).toBe(true);
    expect(report.wiringEntries).toBe(1);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.configShapeVersion).toBe(2);
    expect(written.executionWiring).toEqual([
      {
        workKind: 'QmSolver',
        harness: 'claude-code',
        model: 'claude-haiku-4-5-20251001',
        plugins: ['learner'],
        credentialRef: 'claude-code-default',
        isolationPolicy: 'process',
        legacyManifestDigest: 'QmSolver',
      },
    ]);
    // Amendment (coordinator amendment 1): a configured operator carries the
    // legacy-manifest-digest mode across the migration (its joinedSolverNets
    // entries are still the operative claim predicate). No cap fields are
    // written — see the no-cap-fields test below.
    expect(written.claimPolicy.mode).toBe('match-legacy-manifest-digest');
    expect(Object.keys(written.joinedSolverNets)).toEqual(['QmSolver', 'QmEvalOnly']);
  });

  // Amendment (coordinator amendment 1): spec §9's "behavior-identical on day
  // one" is the binding sentence. The migration writes NO spendCapWei/aiUnitCap
  // — the host's USD rolling-window gates (kept per spec §6.5) remain the
  // operative spend bound, exactly today's behavior for a configured operator.
  it('writes a claimPolicy with no spendCapWei or aiUnitCap own-property', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    migrateConfigShapeV2({ configPath, launchedRecordsDir: launchedDir });
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(Object.prototype.hasOwnProperty.call(written.claimPolicy, 'spendCapWei')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(written.claimPolicy, 'aiUnitCap')).toBe(false);
    expect(written.claimPolicy).toEqual({ mode: 'match-legacy-manifest-digest' });
  });

  // Divergence from the plan's Step-3 pseudocode: a legacy joined entry can
  // carry no per-net `model` (the daemon fell back to the operator's
  // top-level `claudeModel` at solve time). The plan's `entry.model ?? ''`
  // would write an empty string, which fails
  // `ExecutionWiringConfigEntrySchema`'s `z.string().min(1)` and breaks
  // config validation on the next boot. The migration falls back to the
  // operator's `claudeModel` (or a hardcoded default) instead.
  it('falls back to the operator claudeModel when a solver join has no per-net model', () => {
    const { configPath, launchedDir } = workspace({
      claudeModel: 'claude-opus-4-8',
      joinedSolverNets: {
        'legacy:prediction': {
          manifestCid: 'legacy:prediction',
          roles: ['solver'],
          harness: 'claude-code',
          plugins: [],
        },
      },
    });
    migrateConfigShapeV2({ configPath, launchedRecordsDir: launchedDir });
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.executionWiring[0].model).toBe('claude-opus-4-8');
  });

  it('writes one posting entry per launched record this operator owns', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    writeFileSync(
      join(launchedDir, 'QmSolver.json'),
      JSON.stringify({ manifestCid: 'QmSolver', status: 'launched', generatorEnabled: true }),
    );
    writeFileSync(
      join(launchedDir, 'QmDraft.json'),
      JSON.stringify({ manifestCid: 'QmDraft', status: 'draft', generatorEnabled: true }),
    );
    const report = migrateConfigShapeV2({ configPath, launchedRecordsDir: launchedDir });
    expect(report.postingEntries).toBe(1);
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.posting).toEqual([
      {
        workKind: 'QmSolver',
        launchedRecordPath: join(launchedDir, 'QmSolver.json'),
        generatorEnabled: true,
        legacyManifestDigest: 'QmSolver',
      },
    ]);
  });

  it('is idempotent — a second call migrates nothing and writes no second backup', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    migrateConfigShapeV2({ configPath, launchedRecordsDir: launchedDir });
    const first = readFileSync(configPath, 'utf-8');
    const second = migrateConfigShapeV2({ configPath, launchedRecordsDir: launchedDir });
    expect(second.migrated).toBe(false);
    expect(second.backupPath).toBeUndefined();
    expect(readFileSync(configPath, 'utf-8')).toBe(first);
    const backups = readdirSync(join(configPath, '..')).filter((n) => n.includes('.backup-'));
    expect(backups).toHaveLength(1);
  });

  it('takes a timestamped backup before the first write', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    const report = migrateConfigShapeV2({
      configPath,
      launchedRecordsDir: launchedDir,
      now: () => new Date('2026-07-30T09:15:00.000Z'),
    });
    expect(report.backupPath).toBe(`${configPath}.backup-20260730T091500Z`);
    expect(JSON.parse(readFileSync(report.backupPath!, 'utf-8')).configShapeVersion).toBeUndefined();
  });

  it('leaves a prior daemon generation able to read the migrated file', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    migrateConfigShapeV2({ configPath, launchedRecordsDir: launchedDir });
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    // The pre-cutover daemon reads only these keys; they must be byte-identical.
    expect(written.joinedSolverNets).toEqual(JOINED.joinedSolverNets);
    expect(written.spendCap).toEqual(JOINED.spendCap);
  });

  it('never truncates the config when the write throws mid-flight', () => {
    const { configPath, launchedDir } = workspace(JOINED);
    expect(() =>
      migrateConfigShapeV2({
        configPath,
        launchedRecordsDir: launchedDir,
        now: () => {
          throw new Error('clock exploded');
        },
      }),
    ).toThrow('clock exploded');
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual(JOINED);
  });
});
