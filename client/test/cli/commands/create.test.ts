import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { runCreate } from '../../../src/cli/commands/create.js';

let TMP: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'jinn-create-'));
});

afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

describe('runCreate (forecaster pattern)', () => {
  it('emits a forecaster package matching the template', async () => {
    const target = await runCreate({
      target: 'harness',
      pattern: 'forecaster',
      packageName: '@example/test-forecaster',
      solverTypeString: 'prediction.v0',
      network: 'base-sepolia',
      outDir: TMP,
    });
    expect(target).toBe(join(TMP, '@example/test-forecaster'));
    const pkgRoot = target;
    expect(existsSync(join(pkgRoot, 'package.json'))).toBe(true);
    expect(existsSync(join(pkgRoot, 'jinn.manifest.json'))).toBe(true);
    expect(existsSync(join(pkgRoot, 'src/index.ts'))).toBe(true);
    expect(existsSync(join(pkgRoot, 'test/unit.test.ts'))).toBe(true);
    expect(existsSync(join(pkgRoot, 'tsconfig.json'))).toBe(true);
    expect(existsSync(join(pkgRoot, 'README.md'))).toBe(true);
    expect(existsSync(join(pkgRoot, '.gitignore'))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@example/test-forecaster');
    expect(pkg.dependencies['@jinn-network/sdk']).toBe('^0.1.0');

    const manifest = JSON.parse(
      readFileSync(join(pkgRoot, 'jinn.manifest.json'), 'utf8'),
    );
    expect(manifest.name).toBe('@example/test-forecaster');
    expect(manifest.supportedSolverTypes).toContain('prediction.v0>=1.0.0');
    // base-sepolia chain id substituted into capabilities.rpc[0].chainId
    expect(manifest.capabilities.rpc[0].chainId).toBe(84532);

    const indexTs = readFileSync(join(pkgRoot, 'src/index.ts'), 'utf8');
    expect(indexTs).toContain("solverType === 'prediction.v0'");
    expect(indexTs).not.toContain('{{');

    const unitTs = readFileSync(join(pkgRoot, 'test/unit.test.ts'), 'utf8');
    expect(unitTs).not.toContain('{{');
  });

  it('substitutes networkChainId from the network flag', async () => {
    const target = await runCreate({
      target: 'harness',
      pattern: 'forecaster',
      packageName: '@example/mainnet',
      solverTypeString: 'prediction.v0',
      network: 'base-mainnet',
      outDir: TMP,
    });
    const manifest = JSON.parse(
      readFileSync(join(target, 'jinn.manifest.json'), 'utf8'),
    );
    expect(manifest.capabilities.rpc[0].chainId).toBe(8453);
  });

  it('rejects unknown networks', async () => {
    await expect(
      runCreate({
        target: 'harness',
        pattern: 'forecaster',
        packageName: '@example/x',
        solverTypeString: 'prediction.v0',
        network: 'mars',
        outDir: TMP,
      }),
    ).rejects.toThrow(/unknown network/i);
  });

  it('substitutes the package name slug into ephemeral path placeholders', async () => {
    const target = await runCreate({
      target: 'harness',
      pattern: 'forecaster',
      packageName: '@scope/my-impl',
      solverTypeString: 'prediction.v0',
      network: 'base-sepolia',
      outDir: TMP,
    });
    const unitTs = readFileSync(join(target, 'test/unit.test.ts'), 'utf8');
    expect(unitTs).toContain('/tmp/scope-my-impl');
    expect(unitTs).not.toContain('{{packageNameSlug}}');
  });

  /**
   * Smoke-run plan step 6.7: invoke the built CLI from `dist/` to confirm
   * `templates/` is bundled into `dist/templates/` and the scaffolder finds
   * them in the published-tarball layout. Skipped when dist is not built.
   */
  it('built CLI scaffolds via dist/templates (post-yarn-build)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    // test/cli/commands/ -> client/dist/bin/jinn.js
    const distBin = join(here, '../../../dist/bin/jinn.js');
    if (!existsSync(distBin)) {
      // Build hasn't been run in this checkout — skip rather than fail.
      console.warn('[create.test] dist not built; skipping built-CLI smoke');
      return;
    }
    const out = execFileSync(
      'node',
      [
        distBin,
        'create',
        'harness',
        '@smoke/scaffold',
        '--out-dir',
        TMP,
      ],
      { encoding: 'utf8' },
    );
    expect(out).toContain('Created @smoke/scaffold');
    expect(existsSync(join(TMP, '@smoke/scaffold/jinn.manifest.json'))).toBe(true);
    expect(existsSync(join(TMP, '@smoke/scaffold/src/index.ts'))).toBe(true);
  });
});

describe('runCreate (evaluator pattern)', () => {
  it('emits an evaluator package matching the template', async () => {
    const target = await runCreate({
      target: 'harness',
      pattern: 'evaluator',
      packageName: '@example/test-eval',
      solverTypeString: 'prediction.v0',
      network: 'base-sepolia',
      outDir: TMP,
    });
    expect(existsSync(join(target, 'src/index.ts'))).toBe(true);
    const indexTs = readFileSync(join(target, 'src/index.ts'), 'utf8');
    expect(indexTs).toContain("role === 'evaluation'");
    expect(indexTs).not.toContain('{{');
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@jinn-network/sdk']).toBe('^0.1.0');

    const manifest = JSON.parse(
      readFileSync(join(target, 'jinn.manifest.json'), 'utf8'),
    );
    expect(manifest.name).toBe('@example/test-eval');
    expect(manifest.supportedSolverTypes).toEqual(['prediction.v0>=1.0.0']);
    expect(manifest.capabilities.rpc[0].methods).toContain('eth_getLogs');
    expect(manifest.capabilities.rpc[0].chainId).toBe(84532);

    const unitTs = readFileSync(join(target, 'test/unit.test.ts'), 'utf8');
    expect(unitTs).not.toContain('{{');
  });
});

describe('runCreate (alternative-harness pattern)', () => {
  it('emits an alternative-harness package with all seven phase files', async () => {
    const target = await runCreate({
      target: 'harness',
      pattern: 'alternative-harness',
      packageName: '@example/test-althern',
      solverTypeString: 'prediction.v0',
      network: 'base-sepolia',
      outDir: TMP,
    });
    for (const phase of [
      'orient',
      'strategize',
      'plan',
      'execute',
      'debrief',
      'improve',
      'memory',
    ]) {
      expect(existsSync(join(target, 'src/phases', `${phase}.ts`))).toBe(true);
    }
    expect(existsSync(join(target, 'src/mock-harness.ts'))).toBe(true);
    expect(existsSync(join(target, 'src/coordinator.ts'))).toBe(true);
    expect(existsSync(join(target, 'src/harness.ts'))).toBe(true);
    expect(existsSync(join(target, 'test/coordinator.test.ts'))).toBe(true);

    const indexTs = readFileSync(join(target, 'src/index.ts'), 'utf8');
    expect(indexTs).not.toContain('{{');
    expect(indexTs).toContain("solverType === 'prediction.v0'");
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@jinn-network/sdk']).toBe('^0.1.0');
  });

  it('rejects unknown patterns', async () => {
    await expect(
      runCreate({
        target: 'harness',
        pattern: 'nonsense' as unknown as 'forecaster',
        packageName: '@example/x',
        solverTypeString: 'prediction.v0',
        network: 'base-sepolia',
        outDir: TMP,
      }),
    ).rejects.toThrow(/unsupported pattern/);
  });
});
