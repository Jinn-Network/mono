/**
 * Wave-4 D1 regression pin (DR-2026-08-05 decision 7, composition program contract 4):
 * the `joinedSolverNets` CLAIM GATE retires in this wave, but the config KEY stays
 * parseable until stage 5. The live Base Sepolia gate operators (services 72 and 75)
 * both carry `joinedSolverNets` in `~/.jinn-client/config.json`; a parse refusal would
 * brick them, so the loader must tolerate the key rather than reject it.
 *
 * The entry shape below is the live one, verified read-only against an operator home
 * on 2026-08-13: manifest-CID keys plus one synthetic `legacy:<name>` key, each entry
 * carrying `{ manifestCid, name, contract, roles, harness, model?, plugins,
 * disabledDefaultPlugins }`.
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

describe('joinedSolverNets is tolerated by the config loader after the gate retires', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-joined-tolerated-'));
    configPath = join(dir, 'config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a config carrying live-shaped joinedSolverNets entries', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ network: 'testnet', joinedSolverNets: LIVE_SHAPED_JOINED }),
    );
    const config = loadConfig(configPath);
    expect(Object.keys(config.joinedSolverNets ?? {}).sort()).toEqual(
      Object.keys(LIVE_SHAPED_JOINED).sort(),
    );
  });

  it('does not refuse an empty joinedSolverNets map', () => {
    writeFileSync(configPath, JSON.stringify({ network: 'testnet', joinedSolverNets: {} }));
    expect(() => loadConfig(configPath)).not.toThrow();
  });

  it('does not refuse a config that omits joinedSolverNets entirely', () => {
    writeFileSync(configPath, JSON.stringify({ network: 'testnet' }));
    expect(() => loadConfig(configPath)).not.toThrow();
  });
});
