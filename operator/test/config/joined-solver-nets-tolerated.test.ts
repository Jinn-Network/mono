/**
 * Stage 5: `joinedSolverNets` is no longer on the parsed config. A stale
 * on-disk copy is stripped (Zod), not a boot failure — live operators who
 * still carry the key must keep booting.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const LIVE_SHAPED_JOINED = {
  bafkreichdzxtjlive0000000000000000000000000000000000000001: {
    manifestCid: 'bafkreichdzxtjlive0000000000000000000000000000000000000001',
    name: 'SWE-rebench v2',
    contract: { id: 'swe-rebench.v2', version: '1.0.0' },
    roles: ['evaluator'],
    harness: 'claude-code',
    model: 'claude-sonnet-4-5-20250929',
    plugins: [],
    disabledDefaultPlugins: [],
  },
  'legacy:prediction': {
    manifestCid: 'legacy:prediction',
    name: 'prediction',
    contract: { id: 'prediction.v1', version: '1.0.0' },
    roles: ['solver'],
    harness: 'claude-code',
    plugins: [],
    disabledDefaultPlugins: [],
  },
};

describe('joinedSolverNets is stripped by the config loader at stage 5', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-joined-tolerated-'));
    configPath = join(dir, 'config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a config carrying live-shaped joinedSolverNets entries and strips the key', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        network: 'testnet',
        configShapeVersion: 2,
        joinedSolverNets: LIVE_SHAPED_JOINED,
      }),
    );
    const config = loadConfig(configPath);
    expect(config).not.toHaveProperty('joinedSolverNets');
  });

  it('does not refuse an empty joinedSolverNets map', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ network: 'testnet', configShapeVersion: 2, joinedSolverNets: {} }),
    );
    expect(() => loadConfig(configPath)).not.toThrow();
  });

  it('does not refuse a config that omits joinedSolverNets entirely', () => {
    writeFileSync(configPath, JSON.stringify({ network: 'testnet' }));
    expect(() => loadConfig(configPath)).not.toThrow();
  });
});
