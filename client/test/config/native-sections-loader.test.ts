/**
 * Loader-level behaviour of the dark shape-v2 native sections (one-swap M1,
 * umbrella #2461). The keys land UNUSED: the legacy loader must accept them,
 * the shape-v2 migration must never write them, and their presence — including
 * an explicit `evaluator.enabled: true` — must change nothing on the current
 * daemon path.
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA_TODAY } from '@jinn-network/marketplace-binding';
import { loadConfig } from '../../src/config.js';
import { migrateConfigShapeV2 } from '../../src/config/migrate-shape-v2.js';
import { resolveOperatorVerticalMode } from '../../src/daemon/native-vertical-mode.js';

const MODULE_DIGEST = `sha256:${'ab'.repeat(32)}`;
const METHOD_DIGEST = `sha256:${'cd'.repeat(32)}`;
const POLICY_DIGEST = `sha256:${'ef'.repeat(32)}`;

/** `client/fixtures/config.example.json` + the stage-1 shape-v2 keys. */
function fleetConfigV2(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    network: 'testnet',
    rpcUrl: 'https://sepolia.base.org',
    claudeModel: 'claude-haiku-4-5-20251001',
    pollIntervalMs: 5000,
    apiPort: 7331,
    tasks: [],
    configShapeVersion: 2,
    claimPolicy: { mode: 'match-legacy-manifest-digest' },
    executionWiring: [
      {
        workKind: 'prediction.v1',
        harness: 'claude-code',
        model: 'claude-haiku-4-5-20251001',
        plugins: [],
        credentialRef: 'claude-code-default',
        isolationPolicy: 'process',
        legacyManifestDigest: '0xabc',
      },
    ],
    posting: [],
    ...extra,
  };
}

function nativeSections(evaluatorExtra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evaluator: {
      deploymentModule: '/opt/jinn/prediction-market-deployment.mjs',
      moduleDigest: MODULE_DIGEST,
      signerHandle: 'verdict',
      evaluationMethodDigest: METHOD_DIGEST,
      ...evaluatorExtra,
    },
    identityStores: {
      solver: '/var/lib/jinn/identity/solver.json',
      evaluator: '/var/lib/jinn/identity/evaluator.json',
    },
    trustRootsPath: '/var/lib/jinn/trust-roots.json',
    trustPolicyGenesisDigest: POLICY_DIGEST,
    finality: { confirmations: 12 },
  };
}

function workspace(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-native-sections-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

describe('loader tolerance for the dark native sections', () => {
  it('loads a shape-v2 fleet config carrying every native section', () => {
    const loaded = loadConfig(workspace(fleetConfigV2(nativeSections())));

    expect(loaded.evaluator).toEqual({
      deploymentModule: '/opt/jinn/prediction-market-deployment.mjs',
      moduleDigest: MODULE_DIGEST,
      signerHandle: 'verdict',
      evaluationMethodDigest: METHOD_DIGEST,
    });
    expect(loaded.identityStores).toEqual({
      solver: '/var/lib/jinn/identity/solver.json',
      evaluator: '/var/lib/jinn/identity/evaluator.json',
    });
    expect(loaded.trustRootsPath).toBe('/var/lib/jinn/trust-roots.json');
    expect(loaded.trustPolicyGenesisDigest).toBe(POLICY_DIGEST);
    expect(loaded.finality).toEqual({ confirmations: 12 });
  });

  it('loads a shape-v2 fleet config carrying none of them (absent is not an error)', () => {
    const loaded = loadConfig(workspace(fleetConfigV2()));

    expect(loaded.evaluator).toBeUndefined();
    expect(loaded.identityStores).toBeUndefined();
    expect(loaded.trustRootsPath).toBeUndefined();
    expect(loaded.trustPolicyGenesisDigest).toBeUndefined();
    expect(loaded.finality).toBeUndefined();
  });

  it('carries per-registration digests and deployment-owned grader bindings through the loader', () => {
    const loaded = loadConfig(
      workspace(
        fleetConfigV2(
          nativeSections({
            evaluationMethodDigest: { prediction: METHOD_DIGEST, 'swe-rebench': MODULE_DIGEST },
            graderReportSources: { 'swe-rebench': 'deployment-owned' },
          }),
        ),
      ),
    );

    expect(loaded.evaluator?.evaluationMethodDigest).toEqual({
      prediction: METHOD_DIGEST,
      'swe-rebench': MODULE_DIGEST,
    });
    expect(loaded.evaluator?.graderReportSources).toEqual({ 'swe-rebench': 'deployment-owned' });
  });

  it('refuses a malformed native section rather than dropping it', () => {
    expect(() =>
      loadConfig(workspace(fleetConfigV2({ finality: { confirmations: 0 } }))),
    ).toThrow(/Invalid config/u);
    expect(() =>
      loadConfig(workspace(fleetConfigV2({ trustRootsPath: 'relative/trust.json' }))),
    ).toThrow(/Invalid config/u);
  });

  it('keeps the root non-strict: an unknown top-level key still loads', () => {
    expect(() =>
      loadConfig(workspace(fleetConfigV2({ ...nativeSections(), someFutureKey: 'tolerated' }))),
    ).not.toThrow();
  });
});

describe('the dark sections are inert on the current daemon path', () => {
  // Enablement semantics belong to M2's mode selection. A stray
  // `evaluator.enabled: true` on the pre-swap daemon must annotate nothing,
  // refuse nothing, and change nothing else in the loaded config.
  it('a config with evaluator.enabled=true loads identically once the new keys are stripped', () => {
    const withoutNative = loadConfig(workspace(fleetConfigV2()));
    const withNative = loadConfig(
      workspace(fleetConfigV2(nativeSections({ enabled: true }))),
    );

    expect(withNative.evaluator?.enabled).toBe(true);

    const {
      evaluator: _evaluator,
      identityStores: _identityStores,
      trustRootsPath: _trustRootsPath,
      trustPolicyGenesisDigest: _trustPolicyGenesisDigest,
      finality: _finality,
      ...rest
    } = withNative;
    expect(rest).toEqual(withoutNative);
  });

  // The product boundary is `operator.verticalMode`, not these keys. An
  // enabled evaluator block does not author a vertical-mode request.
  // After D5 (deleted native-v1 parallel entry), omitted requestedMode on
  // testnet + BASE_SEPOLIA_TODAY resolves to native-v1, not legacy.
  it('does not move the vertical-mode decision off the resolver default', () => {
    const loaded = loadConfig(workspace(fleetConfigV2(nativeSections({ enabled: true }))));
    expect(loaded.operator?.verticalMode).toBeUndefined();

    const decision = resolveOperatorVerticalMode({
      requestedMode: loaded.operator?.verticalMode,
      network: 'testnet',
      chain: BASE_SEPOLIA_TODAY,
    });
    expect(decision.effectiveMode).toBe('native-v1');
  });
});

describe('the shape-v2 migration writes none of the dark sections', () => {
  it('migrating an unmigrated config adds only the stage-1 keys', () => {
    const { configShapeVersion: _v, claimPolicy: _p, executionWiring: _w, posting: _o, ...v1 } =
      fleetConfigV2();
    const configPath = workspace(v1);

    const report = migrateConfigShapeV2({ configPath });
    expect(report.migrated).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const added = Object.keys(written).filter((key) => !(key in v1));
    expect(added.sort()).toEqual(['claimPolicy', 'configShapeVersion', 'executionWiring', 'posting']);
    for (const key of ['evaluator', 'identityStores', 'trustRootsPath', 'trustPolicyGenesisDigest', 'finality']) {
      expect(written[key]).toBeUndefined();
    }
  });

  it('leaves an already-v2 file byte-identical, native sections and all', () => {
    const configPath = workspace(fleetConfigV2(nativeSections()));
    const before = readFileSync(configPath, 'utf-8');

    const report = migrateConfigShapeV2({ configPath });

    expect(report.migrated).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('is idempotent: a second migration of an unmigrated file is byte-identical', () => {
    const { configShapeVersion: _v, claimPolicy: _p, executionWiring: _w, posting: _o, ...v1 } =
      fleetConfigV2(nativeSections());
    const configPath = workspace(v1);

    expect(migrateConfigShapeV2({ configPath }).migrated).toBe(true);
    const afterFirst = readFileSync(configPath, 'utf-8');
    expect(migrateConfigShapeV2({ configPath }).migrated).toBe(false);

    expect(readFileSync(configPath, 'utf-8')).toBe(afterFirst);
    // The native sections survive the migration unmodified.
    const written = JSON.parse(afterFirst) as Record<string, unknown>;
    expect(written['trustPolicyGenesisDigest']).toBe(POLICY_DIGEST);
    expect(written['finality']).toEqual({ confirmations: 12 });
  });

  it('preserves the shipped pre-migration backup shape', () => {
    const { configShapeVersion: _v, claimPolicy: _p, executionWiring: _w, posting: _o, ...v1 } =
      fleetConfigV2(nativeSections());
    const configPath = workspace(v1);
    const original = readFileSync(configPath, 'utf-8');

    const report = migrateConfigShapeV2({
      configPath,
      now: () => new Date('2026-08-06T12:34:56.000Z'),
    });

    expect(report.backupPath).toBe(`${configPath}.backup-20260806T123456Z`);
    expect(readFileSync(report.backupPath!, 'utf-8')).toBe(original);
    const backups = readdirSync(join(configPath, '..')).filter((name) => name.includes('.backup-'));
    expect(backups).toHaveLength(1);
  });
});
