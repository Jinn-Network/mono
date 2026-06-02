import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, buildConfigProvenance } from '../src/config.js';
import { defaultStateDir } from '../src/solver-types/swe-rebench-v2.js';

// JINN_STATE_DIR: single volume-aware root from which earningDir, dbPath,
// engine.implStateDirRoot, and the swe-rebench-v2 pool dir derive — unless a
// per-key override (file or env) wins. workingDirRoot is deliberately NOT
// derived (ephemeral, reaped per-task). With JINN_STATE_DIR unset, every
// default is byte-identical to the legacy ~/.jinn-client/... paths.

// Env keys this suite mutates on process.env. Saved/restored around each test.
const MUTATED_ENV = [
  'JINN_STATE_DIR',
  'JINN_EARNING_DIR',
  'JINN_DB_PATH',
  'JINN_ENGINE_IMPL_STATE_DIR_ROOT',
  'JINN_ENGINE_WORKING_DIR_ROOT',
  'JINN_SWE_REBENCH_V2_STATE_DIR',
  'JINN_NETWORK',
] as const;

describe('JINN_STATE_DIR derivation in loadConfig', () => {
  const dirs: string[] = [];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MUTATED_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    for (const key of MUTATED_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeConfigFile(contents: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jinn-state-dir-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify(contents, null, 2));
    return configPath;
  }

  // Legacy byte-identical defaults (must never change when JINN_STATE_DIR unset).
  const legacyEarningDir = path.join(os.homedir(), '.jinn-client', 'earning');
  const legacyDbPath = path.join(os.homedir(), '.jinn-client', 'jinn.db');
  const legacyImplStateDirRoot = path.join(os.homedir(), '.jinn-client', 'engine', 'impl-state');
  const legacyWorkingDirRoot = path.join(os.homedir(), '.jinn-client', 'engine', 'work');

  it('(a) STATE_DIR-only: earningDir, dbPath, implStateDirRoot derive; workingDirRoot stays ephemeral legacy', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    process.env['JINN_STATE_DIR'] = '/data';

    const config = loadConfig(configPath);

    expect(config.earningDir).toBe(path.join('/data', 'earning'));
    expect(config.dbPath).toBe(path.join('/data', 'jinn.db'));
    expect(config.engine.implStateDirRoot).toBe(path.join('/data', 'engine', 'impl-state'));
    // workingDirRoot is deliberately NOT derived — unchanged legacy ephemeral default.
    expect(config.engine.workingDirRoot).toBe(legacyWorkingDirRoot);
    expect(config.engine.workingDirRoot.startsWith('/data')).toBe(false);
  });

  it('(b) per-key ENV override wins over STATE_DIR; the rest still derive', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    process.env['JINN_STATE_DIR'] = '/data';
    process.env['JINN_DB_PATH'] = '/custom/x.db';

    const config = loadConfig(configPath);

    expect(config.dbPath).toBe('/custom/x.db');
    expect(config.earningDir).toBe(path.join('/data', 'earning'));
    expect(config.engine.implStateDirRoot).toBe(path.join('/data', 'engine', 'impl-state'));
  });

  it('(b) per-key FILE override wins over STATE_DIR', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      earningDir: '/file/earning',
    });
    process.env['JINN_STATE_DIR'] = '/data';

    const config = loadConfig(configPath);

    expect(config.earningDir).toBe('/file/earning');
    expect(config.dbPath).toBe(path.join('/data', 'jinn.db'));
    expect(config.engine.implStateDirRoot).toBe(path.join('/data', 'engine', 'impl-state'));
  });

  it('(b) per-key engine.implStateDirRoot file override wins; workingDirRoot still legacy', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      engine: { implStateDirRoot: '/file/impl-state' },
    });
    process.env['JINN_STATE_DIR'] = '/data';

    const config = loadConfig(configPath);

    expect(config.engine.implStateDirRoot).toBe('/file/impl-state');
    expect(config.engine.workingDirRoot).toBe(legacyWorkingDirRoot);
    expect(config.earningDir).toBe(path.join('/data', 'earning'));
  });

  it('STATE_DIR can be set via config file (env still wins over it)', async () => {
    const configPath = await writeConfigFile({
      network: 'testnet',
      stateDir: '/file-state',
    });

    const config = loadConfig(configPath);

    expect(config.earningDir).toBe(path.join('/file-state', 'earning'));
    expect(config.dbPath).toBe(path.join('/file-state', 'jinn.db'));
    expect(config.engine.implStateDirRoot).toBe(path.join('/file-state', 'engine', 'impl-state'));
  });

  it('(c) back-compat: JINN_STATE_DIR unset ⇒ all dirs byte-identical to legacy defaults', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });

    const config = loadConfig(configPath);

    expect(config.earningDir).toBe(legacyEarningDir);
    expect(config.dbPath).toBe(legacyDbPath);
    expect(config.engine.implStateDirRoot).toBe(legacyImplStateDirRoot);
    expect(config.engine.workingDirRoot).toBe(legacyWorkingDirRoot);
  });

  it('(d) provenance: JINN_STATE_DIR and JINN_SWE_REBENCH_V2_STATE_DIR are tracked', async () => {
    const configPath = await writeConfigFile({ network: 'testnet' });
    const config = loadConfig(configPath);

    const prov = buildConfigProvenance(configPath, config, {
      JINN_STATE_DIR: '/data',
      JINN_SWE_REBENCH_V2_STATE_DIR: '/data/swe',
    });

    expect(prov.envOverrides['JINN_STATE_DIR']).toBe('set');
    expect(prov.envOverrides['JINN_SWE_REBENCH_V2_STATE_DIR']).toBe('set');
  });
});

describe('defaultStateDir (swe-rebench-v2) is JINN_STATE_DIR-aware', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['JINN_STATE_DIR', 'JINN_SWE_REBENCH_V2_STATE_DIR'] as const;

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('(e) derives <JINN_STATE_DIR>/swe-rebench-v2 when JINN_STATE_DIR is set', () => {
    process.env['JINN_STATE_DIR'] = '/data';
    expect(defaultStateDir()).toBe(path.join('/data', 'swe-rebench-v2'));
  });

  it('(e) falls back to legacy ~/.jinn-client/swe-rebench-v2 when JINN_STATE_DIR unset', () => {
    const expected = path.join(process.env['HOME'] ?? os.homedir(), '.jinn-client', 'swe-rebench-v2');
    expect(defaultStateDir()).toBe(expected);
  });

  it('(e) per-key JINN_SWE_REBENCH_V2_STATE_DIR wins via the caller idiom', () => {
    process.env['JINN_STATE_DIR'] = '/data';
    process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] = '/per-key/swe';
    const resolved = process.env['JINN_SWE_REBENCH_V2_STATE_DIR'] ?? defaultStateDir();
    expect(resolved).toBe('/per-key/swe');
  });
});
