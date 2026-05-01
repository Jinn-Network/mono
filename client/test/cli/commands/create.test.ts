import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  runCreate,
  runCreatePlugIn,
} from '../../../src/cli/commands/create.js';

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
      kind: 'restorer',
      pattern: 'forecaster',
      packageName: '@example/test-forecaster',
      kindString: 'prediction.v0',
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
    expect(pkg.dependencies['@jinn-network/restorer-sdk']).toBeTruthy();

    const manifest = JSON.parse(
      readFileSync(join(pkgRoot, 'jinn.manifest.json'), 'utf8'),
    );
    expect(manifest.name).toBe('@example/test-forecaster');
    expect(manifest.supportedKinds).toContain('prediction.v0>=1.0.0');
    // base-sepolia chain id substituted into capabilities.rpc[0].chainId
    expect(manifest.capabilities.rpc[0].chainId).toBe(84532);

    const indexTs = readFileSync(join(pkgRoot, 'src/index.ts'), 'utf8');
    expect(indexTs).toContain("kind === 'prediction.v0'");
    expect(indexTs).not.toContain('{{');

    const unitTs = readFileSync(join(pkgRoot, 'test/unit.test.ts'), 'utf8');
    expect(unitTs).not.toContain('{{');
  });

  it('substitutes networkChainId from the network flag', async () => {
    const target = await runCreate({
      kind: 'restorer',
      pattern: 'forecaster',
      packageName: '@example/mainnet',
      kindString: 'prediction.v0',
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
        kind: 'restorer',
        pattern: 'forecaster',
        packageName: '@example/x',
        kindString: 'prediction.v0',
        network: 'mars',
        outDir: TMP,
      }),
    ).rejects.toThrow(/unknown network/i);
  });

  it('substitutes the package name slug into ephemeral path placeholders', async () => {
    const target = await runCreate({
      kind: 'restorer',
      pattern: 'forecaster',
      packageName: '@scope/my-impl',
      kindString: 'prediction.v0',
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
        'restorer',
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
      kind: 'restorer',
      pattern: 'evaluator',
      packageName: '@example/test-eval',
      kindString: 'prediction.v0',
      network: 'base-sepolia',
      outDir: TMP,
    });
    expect(existsSync(join(target, 'src/index.ts'))).toBe(true);
    const indexTs = readFileSync(join(target, 'src/index.ts'), 'utf8');
    expect(indexTs).toContain("type === 'evaluation'");
    expect(indexTs).not.toContain('{{');

    const manifest = JSON.parse(
      readFileSync(join(target, 'jinn.manifest.json'), 'utf8'),
    );
    expect(manifest.name).toBe('@example/test-eval');
    expect(manifest.supportedKinds).toEqual(['prediction.v0>=1.0.0']);
    expect(manifest.capabilities.rpc[0].methods).toContain('eth_getLogs');
    expect(manifest.capabilities.rpc[0].chainId).toBe(84532);

    const unitTs = readFileSync(join(target, 'test/unit.test.ts'), 'utf8');
    expect(unitTs).not.toContain('{{');
  });
});

describe('runCreate (alternative-harness pattern)', () => {
  it('emits an alternative-harness package with all seven phase files', async () => {
    const target = await runCreate({
      kind: 'restorer',
      pattern: 'alternative-harness',
      packageName: '@example/test-althern',
      kindString: 'prediction.v0',
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
    expect(indexTs).toContain("kind === 'prediction.v0'");
  });

  it('rejects unknown patterns', async () => {
    await expect(
      runCreate({
        kind: 'restorer',
        pattern: 'nonsense' as unknown as 'forecaster',
        packageName: '@example/x',
        kindString: 'prediction.v0',
        network: 'base-sepolia',
        outDir: TMP,
      }),
    ).rejects.toThrow(/unsupported pattern/);
  });
});

// ---------------------------------------------------------------------------
// Path 1 plug-in scaffolder — six slot patterns.
// ---------------------------------------------------------------------------

describe('runCreatePlugIn (phase-agent-override)', () => {
  it('emits a phase-agent-override package', async () => {
    const target = await runCreatePlugIn({
      kind: 'plug-in',
      pattern: 'phase-agent-override',
      packageName: '@example/calib',
      phase: 'execute',
      agent: 'step-worker',
      outDir: TMP,
    });
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    expect(existsSync(join(target, 'jinn-plugin.json'))).toBe(true);
    expect(existsSync(join(target, 'agents/execute-step-worker.md'))).toBe(true);
    expect(existsSync(join(target, 'test/manifest.test.ts'))).toBe(true);
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(target, 'jinn-plugin.json'), 'utf8'),
    );
    expect(manifest.name).toBe('@example/calib');
    expect(manifest.slots[0].type).toBe('phase-agent-override');
    expect(manifest.slots[0].phase).toBe('execute');
    expect(manifest.slots[0].agent).toBe('step-worker');
    expect(manifest.slots[0].entry).toBe('agents/execute-step-worker.md');
    const agent = readFileSync(
      join(target, 'agents/execute-step-worker.md'),
      'utf8',
    );
    expect(agent).not.toContain('{{');
  });
});

describe('runCreatePlugIn (topic-explorer)', () => {
  it('emits a topic-explorer package', async () => {
    const target = await runCreatePlugIn({
      kind: 'plug-in',
      pattern: 'topic-explorer',
      packageName: '@example/news',
      phase: 'orient',
      topic: 'news-context',
      outDir: TMP,
    });
    expect(existsSync(join(target, 'agents/news-context-explorer.md'))).toBe(
      true,
    );
    const manifest = JSON.parse(
      readFileSync(join(target, 'jinn-plugin.json'), 'utf8'),
    );
    expect(manifest.slots[0].type).toBe('topic-explorer');
    expect(manifest.slots[0].topic).toBe('news-context');
    expect(manifest.slots[0].phase).toBe('orient');
  });
});

describe('runCreatePlugIn (mcp-tool)', () => {
  it('emits an mcp-tool package', async () => {
    const target = await runCreatePlugIn({
      kind: 'plug-in',
      pattern: 'mcp-tool',
      packageName: '@example/poly',
      outDir: TMP,
    });
    expect(existsSync(join(target, 'src/server.ts'))).toBe(true);
    expect(existsSync(join(target, 'test/server.test.ts'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(target, 'jinn-plugin.json'), 'utf8'),
    );
    expect(manifest.slots[0].type).toBe('mcp-tool');
    expect(manifest.slots[0].command).toBe('node');
  });
});

describe('runCreatePlugIn (skill-bundle)', () => {
  it('emits a skill-bundle package', async () => {
    const target = await runCreatePlugIn({
      kind: 'plug-in',
      pattern: 'skill-bundle',
      packageName: '@example/skills',
      outDir: TMP,
    });
    expect(existsSync(join(target, '.claude-plugin/plugin.json'))).toBe(true);
    expect(existsSync(join(target, 'skills/example/SKILL.md'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(target, 'jinn-plugin.json'), 'utf8'),
    );
    expect(manifest.slots[0].type).toBe('skill-bundle');
    expect(manifest.slots[0].skillsDir).toBe('skills');
  });
});

describe('runCreatePlugIn (memory-backend)', () => {
  it('emits a memory-backend package', async () => {
    const target = await runCreatePlugIn({
      kind: 'plug-in',
      pattern: 'memory-backend',
      packageName: '@example/vec',
      outDir: TMP,
    });
    expect(existsSync(join(target, 'src/server.ts'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(target, 'jinn-plugin.json'), 'utf8'),
    );
    expect(manifest.slots[0].type).toBe('memory-backend');
  });
});

describe('runCreatePlugIn (hook)', () => {
  it('emits a hook package', async () => {
    const target = await runCreatePlugIn({
      kind: 'plug-in',
      pattern: 'hook',
      packageName: '@example/precheck',
      event: 'pre-phase',
      outDir: TMP,
    });
    expect(existsSync(join(target, 'hooks/pre-phase.sh'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(target, 'jinn-plugin.json'), 'utf8'),
    );
    expect(manifest.slots[0].type).toBe('hook');
    expect(manifest.slots[0].event).toBe('pre-phase');
    expect(manifest.slots[0].entry).toBe('hooks/pre-phase.sh');
    const hook = readFileSync(join(target, 'hooks/pre-phase.sh'), 'utf8');
    expect(hook).not.toContain('{{');
  });
});
