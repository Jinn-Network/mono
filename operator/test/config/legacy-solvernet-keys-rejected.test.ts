import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JinnConfigSchema, loadConfig } from '../../src/config.js';

describe('legacy SolverNet config keys are retired', () => {
  it('does not carry a joinedSolverNets field', () => {
    expect(Object.keys(JinnConfigSchema.shape)).not.toContain('joinedSolverNets');
  });

  it('does not carry a solverNets field', () => {
    expect(Object.keys(JinnConfigSchema.shape)).not.toContain('solverNets');
  });

  it('parses a v2 config that has neither key', () => {
    const parsed = JinnConfigSchema.parse({ configShapeVersion: 2 });
    expect(parsed).not.toHaveProperty('joinedSolverNets');
    expect(parsed).not.toHaveProperty('solverNets');
  });
});

describe('a stale joinedSolverNets key on disk is ignored, not a boot failure', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-legacy-keys-strip-'));
    configPath = join(dir, 'config.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a file that still carries joinedSolverNets and strips the key', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        network: 'testnet',
        configShapeVersion: 2,
        joinedSolverNets: {
          QmStale: {
            manifestCid: 'QmStale',
            roles: ['solver'],
            harness: 'claude-code',
          },
        },
      }),
    );
    const config = loadConfig(configPath);
    expect(config).not.toHaveProperty('joinedSolverNets');
  });

  it('parses a file that still carries solverNets and strips the key', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        network: 'testnet',
        configShapeVersion: 2,
        solverNets: {
          prediction: { solverType: 'prediction.v1', roles: ['solving'] },
        },
      }),
    );
    const config = loadConfig(configPath);
    expect(config).not.toHaveProperty('solverNets');
  });
});
